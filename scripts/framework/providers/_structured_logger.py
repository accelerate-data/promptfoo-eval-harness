"""
Structured NDJSON logger — Python mirror of scripts/framework/structured_logger.js.

Emits one JSON record per call to stderr. Schema matches spec §7.2:
  { ts, level, msg, run_id, case_id, provider_kind, model, **extra }

Every record is run through the secret redactor before serialization.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any

from _secret_redactor import redact


class Logger:
    """Structured NDJSON logger with fixed context fields."""

    def __init__(
        self,
        *,
        run_id: str | None = None,
        case_id: str | None = None,
        provider_kind: str | None = None,
        model: str | None = None,
    ) -> None:
        self._base: dict[str, Any] = {
            "run_id": run_id,
            "case_id": case_id,
            "provider_kind": provider_kind,
            "model": model,
        }

    def _write(self, level: str, msg: str, **extra: Any) -> None:
        record: dict[str, Any] = {
            "ts": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": level,
            "msg": str(msg),
            **self._base,
            **extra,
        }
        redacted = redact(record)
        sys.stderr.write(json.dumps(redacted) + "\n")
        sys.stderr.flush()

    def info(self, msg: str, **extra: Any) -> None:
        self._write("info", msg, **extra)

    def warn(self, msg: str, **extra: Any) -> None:
        self._write("warn", msg, **extra)

    def error(self, msg: str, **extra: Any) -> None:
        self._write("error", msg, **extra)


def create_logger(
    *,
    run_id: str | None = None,
    case_id: str | None = None,
    provider_kind: str | None = None,
    model: str | None = None,
) -> Logger:
    """Factory — mirrors createLogger() in structured_logger.js."""
    return Logger(run_id=run_id, case_id=case_id, provider_kind=provider_kind, model=model)
