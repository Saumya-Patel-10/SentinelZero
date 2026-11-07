"""NVIDIA Nemotron client using the verified OpenAI-compatible chat protocol.

Verified against NVIDIA documentation (2026-11):
  * Base URL: https://integrate.api.nvidia.com/v1
  * POST /chat/completions with Bearer auth
  * tools / tool_choice / parallel_tool_calls
  * assistant tool_calls followed by role="tool" messages with tool_call_id
  * optional response_format json_schema

The client never logs prompts, responses, Authorization headers, or API keys.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from contextlib import suppress
from typing import Any

import httpx

from app.config import Settings
from app.errors import AI_DEADLINE_EXCEEDED, AgentCancelled, AgentRunError
from app.llm.types import (
    AssistantTurn,
    ProviderAuthError,
    ProviderDescriptor,
    ProviderNotConfigured,
    ProviderProtocolError,
    ProviderRateLimited,
    ProviderRequestRejected,
    ProviderTimeout,
    ProviderUnavailable,
    ToolCallRequest,
)

logger = logging.getLogger("sentinelzero.ai.provider")

_MAX_TOOL_CALLS_PER_TURN = 16
_MAX_ARGUMENT_CHARS = 8_000
_MAX_CONTENT_CHARS = 100_000


class NemotronProvider:
    descriptor: ProviderDescriptor

    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._base_url = settings.nvidia_base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                settings.nvidia_timeout_seconds,
                connect=settings.nvidia_connect_timeout_seconds,
            ),
            transport=transport,
            follow_redirects=False,
        )
        self.descriptor = ProviderDescriptor(
            mode=settings.provider_mode,
            endpoint_class=settings.provider_endpoint_class,
            model_identifier=settings.nvidia_model,
            inference_label=settings.inference_label,
            configured=settings.provider_configured,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        key = (
            self._settings.nvidia_api_key.get_secret_value()
            if self._settings.nvidia_api_key
            else ""
        )
        return {
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def _payload(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        response_format: dict[str, Any] | None,
    ) -> dict[str, Any]:
        settings = self._settings
        payload: dict[str, Any] = {
            "model": settings.nvidia_model,
            "messages": messages,
            "temperature": settings.nvidia_temperature,
            "top_p": settings.nvidia_top_p,
            "max_tokens": settings.nvidia_max_output_tokens,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
            payload["parallel_tool_calls"] = True
        if response_format is not None:
            payload["response_format"] = response_format
        if settings.nvidia_seed is not None:
            payload["seed"] = settings.nvidia_seed
        chat_template_kwargs: dict[str, Any] = {}
        if settings.nvidia_enable_thinking:
            chat_template_kwargs["enable_thinking"] = True
        if settings.nvidia_force_nonempty_content:
            chat_template_kwargs["force_nonempty_content"] = True
        if chat_template_kwargs:
            payload["chat_template_kwargs"] = chat_template_kwargs
        return payload

    async def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        response_format: dict[str, Any] | None,
        deadline: float,
        cancel_event: asyncio.Event | None,
    ) -> AssistantTurn:
        if not self.descriptor.configured:
            raise ProviderNotConfigured(
                "The NVIDIA provider is not configured (NVIDIA_API_KEY missing)."
            )

        effective_format = response_format
        format_fallback_used = False
        attempts = max(1, self._settings.nvidia_max_retries + 1)
        last_error: Exception | None = None

        for attempt in range(1, attempts + 1):
            if cancel_event is not None and cancel_event.is_set():
                raise AgentCancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AgentRunError(
                    AI_DEADLINE_EXCEEDED,
                    "Analysis deadline was exceeded before the model responded.",
                )
            started = time.monotonic()
            payload = self._payload(
                messages=messages, tools=tools, response_format=effective_format
            )
            try:
                response = await self._post(
                    payload,
                    timeout=min(self._settings.nvidia_timeout_seconds, remaining),
                    cancel_event=cancel_event,
                )
            except httpx.TimeoutException as exc:
                last_error = ProviderTimeout("The model provider timed out.")
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as exc:
                last_error = ProviderUnavailable("The model provider is unreachable.")
            except httpx.HTTPError:
                last_error = ProviderUnavailable("The model provider request failed.")
            else:
                latency_ms = int((time.monotonic() - started) * 1000)
                if 200 <= response.status_code < 300:
                    turn = self._parse_response(
                        response, latency_ms=latency_ms
                    )
                    turn.response_format_used = effective_format is not None
                    logger.info(
                        "nemotron_step status=ok step_latency_ms=%s model=%s finish_reason=%s tool_calls=%s",
                        latency_ms,
                        self.descriptor.model_identifier,
                        turn.finish_reason,
                        len(turn.tool_calls),
                    )
                    return turn

                mapped = self._map_status(response)
                if (
                    response.status_code == 400
                    and effective_format is not None
                    and not format_fallback_used
                ):
                    # Some model servers reject response_format. Retry once without it;
                    # the agent always parses and validates plain JSON as well.
                    logger.warning(
                        "nemotron_response_format_rejected; retrying_without_format fallback=true"
                    )
                    effective_format = None
                    format_fallback_used = True
                    last_error = mapped
                    continue
                last_error = mapped

            if attempt >= attempts or not getattr(last_error, "retryable", False):
                break
            backoff = min(4.0, 0.5 * (2 ** (attempt - 1))) + random.uniform(0, 0.2)
            if isinstance(last_error, ProviderRateLimited):
                backoff = min(10.0, float(last_error.retry_after))
            logger.warning(
                "nemotron_retry attempt=%s max_attempts=%s category=%s",
                attempt,
                attempts,
                getattr(last_error, "category", "unknown"),
            )
            await self._sleep(backoff, cancel_event)

        assert last_error is not None
        raise last_error

    async def _post(
        self,
        payload: dict[str, Any],
        *,
        timeout: float,
        cancel_event: asyncio.Event | None,
    ) -> httpx.Response:
        url = f"{self._base_url}/chat/completions"
        request_task = asyncio.create_task(
            self._client.post(url, json=payload, headers=self._headers(), timeout=timeout)
        )
        if cancel_event is None:
            return await request_task

        cancel_task = asyncio.create_task(cancel_event.wait())
        try:
            done, _ = await asyncio.wait(
                {request_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if cancel_task in done and cancel_event.is_set():
                request_task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await request_task
                raise AgentCancelled()
            cancel_task.cancel()
            return await request_task
        except asyncio.CancelledError:
            request_task.cancel()
            cancel_task.cancel()
            raise
        finally:
            if not cancel_task.done():
                cancel_task.cancel()

    async def _sleep(self, seconds: float, cancel_event: asyncio.Event | None) -> None:
        if seconds <= 0:
            return
        if cancel_event is None:
            await asyncio.sleep(seconds)
            return
        sleep_task = asyncio.create_task(asyncio.sleep(seconds))
        cancel_task = asyncio.create_task(cancel_event.wait())
        try:
            done, _ = await asyncio.wait(
                {sleep_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if cancel_task in done and cancel_event.is_set():
                sleep_task.cancel()
                with suppress(asyncio.CancelledError):
                    await sleep_task
                raise AgentCancelled()
            cancel_task.cancel()
            with suppress(asyncio.CancelledError):
                await sleep_task
        finally:
            if not sleep_task.done():
                sleep_task.cancel()
            if not cancel_task.done():
                cancel_task.cancel()

    def _map_status(self, response: httpx.Response) -> Exception:
        status = response.status_code
        if status in (401, 403):
            return ProviderAuthError("The model provider rejected service credentials.")
        if status == 429:
            retry_after = 5
            try:
                retry_after = int(response.headers.get("retry-after", "5"))
            except ValueError:
                pass
            return ProviderRateLimited(
                "The model provider is rate limiting requests.",
                retry_after=max(1, min(10, retry_after)),
            )
        if status in (408, 409, 425) or status >= 500:
            return ProviderUnavailable("The model provider is temporarily unavailable.")
        return ProviderRequestRejected(
            "The model provider rejected the request.",
            status_code=status,
        )

    def _parse_response(self, response: httpx.Response, *, latency_ms: int) -> AssistantTurn:
        try:
            data = response.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise ProviderProtocolError("The model provider returned invalid JSON.") from exc
        if not isinstance(data, dict):
            raise ProviderProtocolError("The model provider returned an unexpected response.")
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise ProviderProtocolError("The model provider returned no choices.")
        choice = choices[0]
        message = choice.get("message")
        if not isinstance(message, dict):
            raise ProviderProtocolError("The model provider returned no message.")

        content = message.get("content")
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    parts.append(part["text"])
            content = "".join(parts) if parts else None
        if content is not None and not isinstance(content, str):
            raise ProviderProtocolError("The model provider returned invalid content.")
        if isinstance(content, str) and len(content) > _MAX_CONTENT_CHARS:
            raise ProviderProtocolError("The model provider response was too large.")

        raw_tool_calls = message.get("tool_calls") or []
        if not isinstance(raw_tool_calls, list):
            raise ProviderProtocolError("The model provider returned invalid tool calls.")
        if len(raw_tool_calls) > _MAX_TOOL_CALLS_PER_TURN:
            raise ProviderProtocolError("The model provider requested too many tools at once.")

        tool_calls: list[ToolCallRequest] = []
        for index, item in enumerate(raw_tool_calls):
            if not isinstance(item, dict):
                raise ProviderProtocolError("The model provider returned an invalid tool call.")
            function = item.get("function")
            if not isinstance(function, dict):
                raise ProviderProtocolError("The model provider returned an invalid tool call.")
            name = function.get("name")
            call_id = item.get("id")
            arguments = function.get("arguments")
            if not isinstance(name, str) or not name:
                raise ProviderProtocolError("The model provider returned a tool call without a name.")
            if not isinstance(call_id, str) or not call_id:
                raise ProviderProtocolError("The model provider returned a tool call without an id.")
            if isinstance(arguments, dict):
                arguments_json = json.dumps(arguments, separators=(",", ":"))
            elif isinstance(arguments, str):
                arguments_json = arguments
            elif arguments is None:
                arguments_json = "{}"
            else:
                raise ProviderProtocolError("The model provider returned invalid tool arguments.")
            if len(arguments_json) > _MAX_ARGUMENT_CHARS:
                raise ProviderProtocolError("The model provider returned oversized tool arguments.")
            tool_calls.append(
                ToolCallRequest(
                    id=call_id[:100],
                    name=name[:80],
                    arguments_json=arguments_json,
                )
            )

        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        safe_usage = {
            "input_tokens": int(prompt_tokens) if isinstance(prompt_tokens, (int, float)) else 0,
            "output_tokens": int(completion_tokens)
            if isinstance(completion_tokens, (int, float))
            else 0,
        }
        request_id = (
            response.headers.get("x-request-id")
            or response.headers.get("nvidia-request-id")
            or None
        )
        model = data.get("model") if isinstance(data.get("model"), str) else None
        finish_reason = choice.get("finish_reason")
        return AssistantTurn(
            content=content,
            tool_calls=tool_calls,
            finish_reason=finish_reason if isinstance(finish_reason, str) else None,
            usage=safe_usage,
            model_identifier=model,
            provider_request_id=request_id[:120] if request_id else None,
            latency_ms=latency_ms,
        )
