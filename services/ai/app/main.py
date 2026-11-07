"""FastAPI application factory."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import SERVICE_NAME, __version__
from app.backend import BackendClient, make_backend
from app.config import Settings, get_settings, redact_secrets
from app.errors import (
    INTERNAL_ERROR,
    METHOD_NOT_ALLOWED,
    NOT_FOUND,
    VALIDATION_FAILED,
    ApiError,
)
from app.middleware import SecurityMiddleware
from app.routes import analyze, health, recommendations
from app.runtime import AppRuntime, make_provider
from app.store import RunStore


class _RedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.msg, str):
                record.msg = redact_secrets(record.msg)
            if record.args:
                record.args = tuple(
                    redact_secrets(arg) if isinstance(arg, str) else arg for arg in record.args
                )
        except Exception:
            pass
        return True


def configure_logging(settings: Settings) -> None:
    level = getattr(logging, settings.log_level, logging.INFO)
    root = logging.getLogger()
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
        )
        handler.addFilter(_RedactionFilter())
        root.addHandler(handler)
    root.setLevel(level)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def _request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


def _envelope(
    request: Request,
    *,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "request_id": _request_id(request),
            "details": details or {},
        }
    }


def create_app(
    *,
    settings: Settings | None = None,
    backend: BackendClient | None = None,
    provider: Any | None = None,
    store: RunStore | None = None,
    backend_state: dict | None = None,
    provider_transport: Any | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings)

    selected_backend = backend or make_backend(settings, state=backend_state)
    selected_provider = provider or make_provider(settings, provider_transport)
    selected_store = store or RunStore(
        ttl_seconds=settings.run_ttl_seconds, max_runs=settings.max_stored_runs
    )
    runtime = AppRuntime(
        settings=settings,
        backend=selected_backend,
        provider=selected_provider,
        store=selected_store,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await app.state.runtime.aclose()

    docs_enabled = settings.enable_docs and not settings.is_production
    app = FastAPI(
        title="SentinelZero AI",
        version=__version__,
        description=(
            "Authenticated, proposal-only incident analysis using NVIDIA Nemotron tool calling. "
            "No endpoint in this service can approve or execute an operational action."
        ),
        docs_url="/docs" if docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if docs_enabled else None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.backend = selected_backend
    app.state.provider = selected_provider
    app.state.store = selected_store
    app.state.runtime = runtime
    app.state.started_at = datetime.now(timezone.utc)

    app.add_middleware(SecurityMiddleware, max_body_bytes=settings.max_body_bytes)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=[
                "Authorization",
                "Content-Type",
                "Idempotency-Key",
                "X-Request-ID",
            ],
            expose_headers=["X-Request-ID", "Retry-After"],
            max_age=600,
        )

    app.include_router(health.router)
    app.include_router(analyze.router)
    app.include_router(recommendations.router)

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if exc.status_code == 401 else {}
        headers.update(exc.headers)
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope(
                request, code=exc.code, message=exc.message, details=exc.details
            ),
            headers=headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        errors = []
        for item in exc.errors()[:10]:
            location = [str(part) for part in item.get("loc", [])]
            errors.append({"loc": location, "type": str(item.get("type", "invalid"))})
        return JSONResponse(
            status_code=422,
            content=_envelope(
                request,
                code=VALIDATION_FAILED,
                message="Request validation failed.",
                details={"errors": errors},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        if exc.status_code == 404:
            code, message = NOT_FOUND, "Resource was not found."
        elif exc.status_code == 405:
            code, message = METHOD_NOT_ALLOWED, "Method is not allowed."
        else:
            code, message = "HTTP_ERROR", "Request could not be completed."
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope(request, code=code, message=message),
            headers=getattr(exc, "headers", None) or {},
        )

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        logging.getLogger("sentinelzero.ai").exception(
            "unhandled_error request_id=%s", _request_id(request)
        )
        return JSONResponse(
            status_code=500,
            content=_envelope(
                request,
                code=INTERNAL_ERROR,
                message="An internal error occurred. Manual incident workflows remain available.",
            ),
        )

    return app


app = create_app()
