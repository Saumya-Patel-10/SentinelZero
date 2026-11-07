"""HTTP middleware: request IDs, body bounds, security headers."""

from __future__ import annotations

import json
import re
import uuid

from starlette.types import ASGIApp, Message, Receive, Scope, Send

_REQUEST_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,80}$")


class SecurityMiddleware:
    def __init__(self, app: ASGIApp, *, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        supplied_id = headers.get("x-request-id", "")
        request_id = supplied_id if _REQUEST_ID.match(supplied_id) else uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id

        try:
            declared = int(headers.get("content-length", "0"))
        except ValueError:
            declared = 0
        if declared > self.max_body_bytes:
            await self._reject(send, request_id)
            return

        # Buffer a bounded request body so chunked requests cannot bypass the limit.
        messages: list[Message] = []
        total = 0
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > self.max_body_bytes:
                    await self._reject(send, request_id)
                    return
                if not message.get("more_body", False):
                    break
            elif message["type"] == "http.disconnect":
                return

        index = 0

        async def replay() -> Message:
            nonlocal index
            if index < len(messages):
                message = messages[index]
                index += 1
                return message
            return await receive()

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                raw_headers = list(message.get("headers", []))
                raw_headers.extend(
                    [
                        (b"x-request-id", request_id.encode("latin-1")),
                        (b"x-content-type-options", b"nosniff"),
                        (b"x-frame-options", b"DENY"),
                        (b"referrer-policy", b"no-referrer"),
                        (b"cache-control", b"no-store"),
                    ]
                )
                message = {**message, "headers": raw_headers}
            await send(message)

        await self.app(scope, replay, send_with_headers)

    async def _reject(self, send: Send, request_id: str) -> None:
        body = json.dumps(
            {
                "error": {
                    "code": "PAYLOAD_TOO_LARGE",
                    "message": "Request body exceeds the allowed size.",
                    "request_id": request_id,
                    "details": {},
                }
            }
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"x-request-id", request_id.encode("latin-1")),
                    (b"x-content-type-options", b"nosniff"),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})
