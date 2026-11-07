"""Configuration for the SentinelZero AI service.

Secrets are held in ``SecretStr`` and are never serialized into responses, logs,
or run records. The health endpoint exposes booleans only.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import AliasChoices, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "production"]
ProviderMode = Literal["live", "scripted"]
BackendMode = Literal["memory", "http"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="AI_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    environment: Environment = "development"
    service_version: str = "0.1.0"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    enable_docs: bool = True
    demo_mode: bool = False

    # --- caller authentication -------------------------------------------
    jwt_secret: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("AI_JWT_SECRET", "JWT_SECRET"),
    )
    jwt_public_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("AI_JWT_PUBLIC_KEY", "JWT_PUBLIC_KEY"),
    )
    jwt_algorithm: Literal["HS256", "RS256"] = "HS256"
    jwt_issuer: str = "sentinelzero-auth"
    jwt_audience: str = "sentinelzero-ai"
    jwt_leeway_seconds: int = 30
    allowed_roles: tuple[str, ...] = ("OWNER", "COMMANDER", "ANALYST", "RESPONDER", "OBSERVER")

    # --- NVIDIA Nemotron ---------------------------------------------------
    nvidia_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("AI_NVIDIA_API_KEY", "NVIDIA_API_KEY"),
    )
    nvidia_base_url: str = Field(
        default="https://integrate.api.nvidia.com/v1",
        validation_alias=AliasChoices("AI_NVIDIA_BASE_URL", "NVIDIA_BASE_URL"),
    )
    nvidia_model: str = Field(
        default="nvidia/nemotron-3-super-120b-a12b",
        validation_alias=AliasChoices("AI_NVIDIA_MODEL", "NVIDIA_MODEL"),
    )
    nvidia_timeout_seconds: float = 45.0
    nvidia_connect_timeout_seconds: float = 10.0
    nvidia_max_retries: int = 2
    nvidia_max_output_tokens: int = 2048
    nvidia_temperature: float = 0.1
    nvidia_top_p: float = 0.9
    nvidia_seed: int | None = None
    # Some Nemotron reasoning variants need chat_template_kwargs for tool parsing.
    # See docs/deployment.md "Model capability verification".
    nvidia_enable_thinking: bool = False
    nvidia_force_nonempty_content: bool = False
    provider_mode: ProviderMode = "live"
    require_tool_round_trip: bool = True

    # --- incident backend (Agent 1 contract; MOCK until published) --------
    backend_mode: BackendMode = "memory"
    backend_base_url: str = "http://127.0.0.1:3000"
    backend_service_token: SecretStr | None = None
    backend_timeout_seconds: float = 10.0
    simulator_state_path: str = "../../simulator/.state/state.json"

    # --- bounds ------------------------------------------------------------
    max_steps: int = Field(default=6, ge=1, le=8)
    max_tool_calls: int = Field(default=10, ge=1, le=16)
    max_tool_result_chars: int = Field(default=20_000, ge=1_000, le=100_000)
    max_context_chars: int = Field(default=32_000, ge=4_000, le=200_000)
    run_deadline_seconds: float = Field(default=90.0, ge=5.0, le=300.0)
    max_body_bytes: int = Field(default=16_384, ge=1_024, le=1_048_576)
    max_concurrent_runs_per_user: int = Field(default=2, ge=1, le=10)
    rate_limit_per_minute: int = Field(default=6, ge=1, le=120)
    rate_limit_burst: int = Field(default=2, ge=0, le=20)
    run_ttl_seconds: int = Field(default=3_600, ge=60, le=86_400)
    max_stored_runs: int = Field(default=500, ge=10, le=10_000)

    # --- HTTP --------------------------------------------------------------
    cors_origins: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate(self) -> "Settings":
        if self.jwt_algorithm == "RS256" and not self.jwt_public_key:
            raise ValueError("AI_JWT_PUBLIC_KEY is required when AI_JWT_ALGORITHM=RS256")
        if self.jwt_algorithm == "HS256" and self.jwt_secret is None:
            # Startup is allowed so /health can report degraded; endpoints fail closed.
            pass
        if self.environment == "production":
            if self.provider_mode == "scripted":
                raise ValueError("AI_PROVIDER_MODE=scripted is forbidden in production")
            if self.jwt_secret is None and self.jwt_public_key is None:
                raise ValueError("JWT verification is not configured")
            if self.backend_mode == "http" and self.backend_service_token is None:
                raise ValueError("AI_BACKEND_SERVICE_TOKEN is required for HTTP backend mode")
            if "*" in self.cors_origins:
                raise ValueError("Wildcard CORS is forbidden in production")
        if not self.nvidia_base_url.startswith(("http://", "https://")):
            raise ValueError("AI_NVIDIA_BASE_URL must be an HTTP(S) URL")
        if self.nvidia_base_url.rstrip("/").endswith("/chat/completions"):
            # Accept either base URL style but normalize in the client.
            self.nvidia_base_url = self.nvidia_base_url.rsplit("/chat/completions", 1)[0]
        return self

    # --- derived, non-secret descriptors ----------------------------------
    @property
    def auth_configured(self) -> bool:
        if self.jwt_algorithm == "RS256":
            return self.jwt_public_key is not None
        return self.jwt_secret is not None

    @property
    def provider_configured(self) -> bool:
        return self.nvidia_api_key is not None and bool(self.nvidia_model)

    @property
    def provider_endpoint_class(self) -> str:
        """Honest endpoint classification; only NVIDIA's host is called live NVIDIA."""
        if self.provider_mode == "scripted":
            return "SIMULATED_SCRIPTED"
        host = (urlparse(self.nvidia_base_url).hostname or "").lower()
        if host == "integrate.api.nvidia.com":
            return "NVIDIA_HOSTED"
        if host.endswith(".nvidia.com"):
            return "NVIDIA_HOSTED"
        return "CUSTOM_OPENAI_COMPATIBLE"

    @property
    def inference_label(self) -> str:
        if self.provider_mode == "scripted":
            return "SIMULATED_MODEL_OUTPUT"
        if self.provider_configured and self.provider_endpoint_class == "NVIDIA_HOSTED":
            return "LIVE_NVIDIA_INFERENCE"
        return "UNVERIFIED_PROVIDER"

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def resolved_simulator_state_path(self) -> Path:
        path = Path(self.simulator_state_path)
        if path.is_absolute():
            return path
        # Prefer the process working directory, then the repository root
        # (services/ai/app/config.py -> repo root is parents[3]).
        if path.exists():
            return path.resolve()
        repo_root = Path(__file__).resolve().parents[3]
        return (repo_root / path).resolve()

    def safe_summary(self) -> dict[str, object]:
        """Non-secret configuration summary for /health and logs."""
        return {
            "environment": self.environment,
            "auth_configured": self.auth_configured,
            "provider_mode": self.provider_mode,
            "provider_endpoint_class": self.provider_endpoint_class,
            "provider_configured": self.provider_configured,
            "inference_label": self.inference_label,
            "model_identifier": self.nvidia_model if self.provider_mode == "live" else "scripted-local-test-model",
            "backend_mode": self.backend_mode,
            "backend_configured": self.backend_mode != "http" or self.backend_service_token is not None,
        }


_SECRET_PATTERNS = [
    re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]+"),
    re.compile(r"(?i)(nvapi-)[A-Za-z0-9._-]+"),
    re.compile(r"(?i)(api[_-]?key[\"']?\s*[:=]\s*[\"']?)[A-Za-z0-9._-]{8,}"),
]


def redact_secrets(text: str) -> str:
    """Best-effort final defense for log records; never used to store data."""
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(r"\1[REDACTED]", text)
    return text


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
