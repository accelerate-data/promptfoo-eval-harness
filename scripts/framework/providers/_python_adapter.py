"""
Python NDJSON adapter — subprocess entry point for SDK provider kinds (spec §2.5).

Usage:
    uv run --python 3.12 scripts/framework/providers/_python_adapter.py --kind=<kind>

Protocol (spec §2.3):
    Reads one JSON object per line from stdin.
    Writes one JSON object per line to stdout, flushed after each write.
    Logs to stderr only — never to stdout (would contaminate IPC channel).

Supported message types:
    {"type": "init",     "id": "...", "config": {...}}
    {"type": "turn",     "id": "...", "session_id": "...", "message": "..."}
    {"type": "finalize", "id": "...", "session_id": "..."}
    {"type": "shutdown", "id": "...", "session_id": "..."}

Response types:
    {"type": "init_ack",     "id": "...", "session_id": "..."}
    {"type": "turn_ack",     "id": "...", "text": "...", "tool_calls": [...], "error": null|{...}, "raw": {...}}
    {"type": "finalize_ack", "id": "...", "cost_usd": ..., "tokens": {...}, "transcript_summary": "..."}
    {"type": "shutdown_ack", "id": "..."}
    {"type": "error",        "id": "...", "error": {"code": "...", "message": "...", "retryable": ...}}

Banner suppression: OPENHANDS_SUPPRESS_BANNER=1 is set before any provider import.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import inspect
import json
import os
import sys
import traceback
from typing import Any

# ---------------------------------------------------------------------------
# Banner suppression — must happen before any SDK import at module level.
# ---------------------------------------------------------------------------
os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")

# ---------------------------------------------------------------------------
# Ensure the framework providers package is importable when invoked via uv.
# _REPO_ROOT is the repository root (parent of scripts/).
# ---------------------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))  # …/scripts/framework/providers
_FRAMEWORK_DIR = os.path.dirname(_SCRIPT_DIR)  # …/scripts/framework
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_SCRIPT_DIR)))  # repo root

for _dir in (_REPO_ROOT, _SCRIPT_DIR, _FRAMEWORK_DIR):
    if _dir not in sys.path:
        sys.path.insert(0, _dir)

# ---------------------------------------------------------------------------
# Structured NDJSON logger — initialized after sys.path is set.
# ---------------------------------------------------------------------------
from _structured_logger import create_logger  # noqa: E402

_log = create_logger()

# ---------------------------------------------------------------------------
# Provider contract types (from same package, loaded after sys.path fix).
# ProviderError is a *dataclass*, not an Exception subclass. We wrap it in
# _AdapterError so we can raise/catch it as an exception internally.
# ---------------------------------------------------------------------------
from _contract import FinalResult, ProviderConfig, ProviderError, TurnResult  # noqa: E402


class _AdapterError(Exception):
    """Internal exception wrapping a ProviderError data container."""

    def __init__(self, error: ProviderError) -> None:
        super().__init__(error.message)
        self.provider_error = error


def _make_error(code: str, message: str, retryable: bool = False) -> _AdapterError:
    return _AdapterError(ProviderError(code=code, message=message, retryable=retryable))


# ---------------------------------------------------------------------------
# Provider registry — maps kind → dotted module path.
# The mock kind is for harness L2 tests only; it is resolved relative to the
# repo root so the import path is tests._mock_provider.provider.
# Phase 06 will register openhands_sdk here.
# ---------------------------------------------------------------------------
_PROVIDER_REGISTRY: dict[str, str] = {
    "mock": "tests._mock_provider.provider",
    "openhands_sdk": "scripts.framework.providers.openhands_sdk.provider",
    # Async test fixtures (Phase 9.5 — VD-2174-12). Harness L2 tests only.
    "async_mock": "tests._mock_async_python_provider.provider",
    "async_mock_raising": "tests._mock_async_python_provider.provider_raising",
}


def _maybe_await(provider: Any, name: str, *args: Any, **kwargs: Any) -> Any:
    """Call ``provider.<name>(*args, **kwargs)`` synchronously or via ``asyncio.run``
    depending on whether the bound method is a coroutine function.

    Phase 9.5 (VD-2174-12) — lets the same adapter host sync providers
    (mock, openhands_sdk) and async providers (claude_agent_sdk in Phase 10)
    without duplicating the dispatch logic.
    """
    method = getattr(provider, name)
    if inspect.iscoroutinefunction(method):
        return asyncio.run(method(*args, **kwargs))
    return method(*args, **kwargs)


def _load_provider(kind: str) -> Any:
    """Import and return a provider object for *kind*. Raises _AdapterError on unknown kind.

    If the module exposes a ``create()`` factory (class-based providers like openhands_sdk),
    call it and return the instance.  Otherwise return the module itself (function-based
    providers like the ``mock`` test provider).
    """
    if kind not in _PROVIDER_REGISTRY:
        raise _make_error(
            "UNSUPPORTED_KIND",
            f"provider kind {kind!r} is not registered; supported: {list(_PROVIDER_REGISTRY.keys())}",
        )
    module_path = _PROVIDER_REGISTRY[kind]
    try:
        mod = importlib.import_module(module_path)
    except ImportError as exc:
        raise _make_error(
            "UNSUPPORTED_KIND",
            f"failed to import provider module {module_path!r}: {exc}",
        ) from exc

    # Class-based providers expose create(); function-based providers (legacy/mock)
    # expose init/turn/finalize/shutdown at module level.
    if callable(getattr(mod, "create", None)):
        return mod.create()
    return mod


def _emit(obj: dict[str, Any]) -> None:
    """Write a single NDJSON line to stdout and flush immediately."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _error_dict(exc: Exception) -> dict[str, Any]:
    """Convert an exception to a sanitized error dict suitable for IPC emission."""
    if isinstance(exc, _AdapterError):
        return exc.provider_error.to_dict()
    return {
        "code": getattr(exc, "code", "sdk_error"),
        "message": str(exc),
        "retryable": bool(getattr(exc, "retryable", False)),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="SDK provider NDJSON adapter")
    parser.add_argument("--kind", required=True, help="Provider kind (e.g. openhands_sdk)")
    args, _ = parser.parse_known_args()

    kind = args.kind
    _log.info(f"adapter starting, kind={kind}")

    # Load provider module early to surface UNSUPPORTED_KIND before stdin loop.
    try:
        provider = _load_provider(kind)
    except _AdapterError as exc:
        _emit({"type": "error", "id": "", "error": exc.provider_error.to_dict()})
        sys.exit(1)

    # sessions: dict keyed by session_id string.
    sessions: dict[str, Any] = {}

    try:
        while True:
            raw_line = sys.stdin.readline()
            if not raw_line:
                # EOF — parent closed stdin; clean exit.
                _log.info("stdin EOF, exiting")
                break

            line = raw_line.strip()
            if not line:
                continue

            msg_id = ""
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                _emit(
                    {
                        "type": "error",
                        "id": msg_id,
                        "error": ProviderError(
                            code="BAD_INPUT",
                            message=f"malformed JSON: {exc}",
                            retryable=False,
                        ).to_dict(),
                    }
                )
                continue

            msg_id = req.get("id", "")
            msg_type = req.get("type", "")

            if msg_type == "init":
                _handle_init(provider, sessions, req, msg_id)

            elif msg_type == "turn":
                _handle_turn(provider, sessions, req, msg_id)

            elif msg_type == "finalize":
                _handle_finalize(provider, sessions, req, msg_id)

            elif msg_type == "shutdown":
                _handle_shutdown(provider, sessions, req, msg_id)
                return  # normal exit after shutdown_ack

            else:
                _emit(
                    {
                        "type": "error",
                        "id": msg_id,
                        "error": ProviderError(
                            code="BAD_INPUT",
                            message=f"unknown message type: {msg_type!r}",
                            retryable=False,
                        ).to_dict(),
                    }
                )

    except Exception as exc:
        _log.error("adapter fatal error", error_stack=traceback.format_exc())
        _emit({"type": "error", "id": "", "error": _error_dict(exc)})
        sys.exit(1)
    finally:
        # Idempotent shutdown of any remaining sessions.
        for sess in list(sessions.values()):
            try:
                _maybe_await(provider, "shutdown", sess)
            except Exception:
                pass


def _handle_init(provider: Any, sessions: dict[str, Any], req: dict[str, Any], msg_id: str) -> None:
    try:
        raw_cfg = req.get("config", {})
        if not isinstance(raw_cfg, dict):
            raise _make_error("BAD_INPUT", "init.config must be a JSON object")
        cfg = ProviderConfig(
            provider_kind=raw_cfg.get("provider_kind", ""),
            model=raw_cfg.get("model", ""),
            sdk_version=raw_cfg.get("sdk_version", ""),
            workspace_root=raw_cfg.get("workspace_root", ""),
            tools=raw_cfg.get("tools", []),
            permissions=raw_cfg.get("permissions", {}),
            timeout_per_turn_s=int(raw_cfg.get("timeout_per_turn_s", 300)),
            provider_label=raw_cfg.get("provider_label", ""),
            extra=raw_cfg.get("extra", {}),
        )
        session = _maybe_await(provider, "init", cfg)
        session_id = str(id(session))
        sessions[session_id] = session
        _emit({"type": "init_ack", "id": msg_id, "session_id": session_id})
    except _AdapterError as exc:
        _emit({"type": "error", "id": msg_id, "error": exc.provider_error.to_dict()})
    except Exception as exc:
        _log.error("init failed", error_stack=traceback.format_exc())
        _emit({"type": "error", "id": msg_id, "error": _error_dict(exc)})


def _handle_turn(provider: Any, sessions: dict[str, Any], req: dict[str, Any], msg_id: str) -> None:
    session_id = req.get("session_id", "")
    message = req.get("message", "")
    session = sessions.get(session_id)
    try:
        if session is None:
            raise _make_error(
                "UNKNOWN_SESSION",
                f"session_id {session_id!r} not found",
            )
        result: TurnResult = _maybe_await(provider, "turn", session, message)
        _emit(
            {
                "type": "turn_ack",
                "id": msg_id,
                "text": result.text,
                "tool_calls": [tc.to_dict() for tc in result.tool_calls],
                "error": result.error.to_dict() if result.error is not None else None,
                "raw": {},
            }
        )
    except _AdapterError as exc:
        # Per spec §2.5: bad turn → turn_ack with error populated, NOT crash.
        _emit(
            {
                "type": "turn_ack",
                "id": msg_id,
                "text": "",
                "tool_calls": [],
                "error": exc.provider_error.to_dict(),
                "raw": {},
            }
        )
    except Exception as exc:
        # Any non-adapter exception goes into turn_ack.error to avoid killing the subprocess.
        _log.error("turn failed", error_stack=traceback.format_exc())
        _emit(
            {
                "type": "turn_ack",
                "id": msg_id,
                "text": "",
                "tool_calls": [],
                "error": _error_dict(exc),
                "raw": {},
            }
        )


def _handle_finalize(provider: Any, sessions: dict[str, Any], req: dict[str, Any], msg_id: str) -> None:
    session_id = req.get("session_id", "")
    session = sessions.get(session_id)
    try:
        if session is None:
            raise _make_error("UNKNOWN_SESSION", f"session_id {session_id!r} not found")
        result_f: FinalResult = _maybe_await(provider, "finalize", session)
        meta = result_f.metadata or {}
        _emit(
            {
                "type": "finalize_ack",
                "id": msg_id,
                "cost_usd": meta.get("cost_usd"),
                "tokens": meta.get("tokens", {}),
                "transcript_summary": meta.get("transcript_summary", ""),
            }
        )
    except _AdapterError as exc:
        _emit({"type": "error", "id": msg_id, "error": exc.provider_error.to_dict()})
    except Exception as exc:
        _log.error("finalize failed", error_stack=traceback.format_exc())
        _emit({"type": "error", "id": msg_id, "error": _error_dict(exc)})


def _handle_shutdown(provider: Any, sessions: dict[str, Any], req: dict[str, Any], msg_id: str) -> None:
    session_id = req.get("session_id", "")
    session = sessions.get(session_id)
    try:
        if session is not None:
            _maybe_await(provider, "shutdown", session)
            del sessions[session_id]
    except Exception as exc:
        _log.warn(f"shutdown error (ignored): {exc}")
    _emit({"type": "shutdown_ack", "id": msg_id})


if __name__ == "__main__":
    main()
