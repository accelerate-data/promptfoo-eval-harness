"""
Claude Agent SDK provider — async lifecycle (Phase 10 / VD-2174-9).

All four lifecycle methods are ``async def``; the adapter routes through
``inspect.iscoroutinefunction`` + ``asyncio.run`` (see ``_python_adapter._maybe_await``).
Multi-turn uses ``ClaudeSDKClient`` (stateful, ``async with``); single-turn uses
the stateless module-level ``query()``. Tool/model validation lives in
``tools.py`` to keep this module focused on lifecycle wiring.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

_log = logging.getLogger(__name__)

# Lazy-loaded module references — populated on first lifecycle call so the
# module loads cleanly without claude_agent_sdk wheel and so tests that patch
# sys.modules in a fixture see the patched copy.
_SDK: Any = None
_CONTRACT: Any = None
_TOOLS: Any = None


def _load_deps() -> tuple[Any, Any, Any]:
    """Resolve and cache (sdk_module, contract_module, tools_module)."""
    global _SDK, _CONTRACT, _TOOLS
    if _SDK is None:
        import claude_agent_sdk as _sdk_mod  # noqa: PLC0415

        _SDK = _sdk_mod
    if _CONTRACT is None:
        try:
            from scripts.framework.providers import _contract as _c  # noqa: PLC0415
        except ImportError:
            import _contract as _c  # noqa: PLC0415
        _CONTRACT = _c
    if _TOOLS is None:
        try:
            from . import tools as _t  # noqa: PLC0415
        except ImportError:
            from scripts.framework.providers.claude_agent_sdk import tools as _t  # noqa: PLC0415
        _TOOLS = _t
    return _SDK, _CONTRACT, _TOOLS


# ---------------------------------------------------------------------------
# Session container + per-turn event extractor.
# ---------------------------------------------------------------------------


@dataclass
class _Session:
    options: Any
    total_turns_planned: int
    client: Any = None  # ClaudeSDKClient | None — present only when planned > 1
    turns_completed: int = 0
    all_tool_calls: list = field(default_factory=list)
    last_result_message: Any = None
    closed: bool = False


class _EventExtractor:
    """Per-turn accumulator. Routes on ``msg.type`` (assistant/tool_call/tool_result/result)."""

    def __init__(self) -> None:
        self._text: list[str] = []
        self._tools: list = []
        self._pending: dict[str, dict[str, Any]] = {}
        self.last_result: Any = None

    def reset(self) -> None:
        self._text.clear()
        self._tools = []
        self._pending.clear()
        self.last_result = None

    def on(self, msg: Any, ToolCallRecord: type) -> None:
        mtype = getattr(msg, "type", None)
        if mtype == "assistant":
            for block in getattr(msg, "content", []) or []:
                txt = getattr(block, "text", None)
                if txt:
                    self._text.append(txt)
        elif mtype == "tool_call":
            self._pending[getattr(msg, "tool_use_id", "")] = {
                "name": getattr(msg, "tool_name", "unknown"),
                "arguments": dict(getattr(msg, "input", {}) or {}),
            }
        elif mtype == "tool_result":
            tu_id = getattr(msg, "tool_use_id", "")
            meta = self._pending.pop(tu_id, {"name": "unknown", "arguments": {}})
            is_error = bool(getattr(msg, "is_error", False))
            raw = str(getattr(msg, "content", "") or "")
            content = raw if len(raw) <= 1024 else raw[:1021] + "..."
            self._tools.append(
                ToolCallRecord(
                    name=meta["name"],
                    arguments=meta["arguments"],
                    result_truncated=content,
                    error=content if is_error else None,
                )
            )
        elif mtype == "result":
            self.last_result = msg
        # else: silently ignore (system / unknown / mock _WeirdMessage)

    @property
    def text(self) -> str:
        return "".join(self._text)

    @property
    def tools(self) -> list:
        return list(self._tools)


# ---------------------------------------------------------------------------
# Provider — async lifecycle. Adapter invokes via asyncio.run().
# ---------------------------------------------------------------------------


class ClaudeAgentSDKProvider:
    """Implements the SDKProvider Protocol for the Claude Agent SDK (async)."""

    async def init(self, cfg: Any) -> _Session:
        sdk, contract, tools = _load_deps()
        try:
            model_id = tools.resolve_model(cfg.model)
            allowed = tools.derive_allowed_tools(cfg)
        except tools.ProviderRuntimeError:
            raise
        except Exception as exc:
            raise tools.ProviderRuntimeError(
                code="VALIDATION", message=f"config validation failed: {exc}"
            ) from exc

        total_turns = int((cfg.extra or {}).get("total_turns", 1))
        options = sdk.ClaudeAgentOptions(
            model=model_id,
            allowed_tools=allowed,
            permission_mode="acceptEdits",
            cwd=cfg.workspace_root,
            max_turns=max(total_turns, 1),
        )

        client = None
        if total_turns > 1:
            try:
                client = sdk.ClaudeSDKClient(options=options)
                await client.__aenter__()
            except Exception as exc:
                raise tools.ProviderRuntimeError(
                    code="sdk_error", message=f"ClaudeSDKClient setup failed: {exc}"
                ) from exc

        return _Session(options=options, total_turns_planned=total_turns, client=client)

    async def turn(self, session: _Session, message: str) -> Any:
        sdk, contract, tools = _load_deps()
        if session.closed:
            raise tools.ProviderRuntimeError(
                code="sdk_error", message="turn() called on a closed session"
            )

        ex = _EventExtractor()
        ex.reset()

        try:
            if session.client is not None:
                await session.client.query(message)
                stream = session.client.receive_messages()
            else:
                stream = sdk.query(message, options=session.options)
            async for msg in stream:
                ex.on(msg, contract.ToolCallRecord)
        except sdk.ProcessError as exc:
            code = "auth" if "auth" in str(exc).lower() else "sdk_error"
            return contract.TurnResult(
                text=ex.text,
                tool_calls=ex.tools,
                error=contract.ProviderError(code=code, message=str(exc), retryable=False),
            )
        except sdk.CLIConnectionError as exc:
            return contract.TurnResult(
                text=ex.text,
                tool_calls=ex.tools,
                error=contract.ProviderError(code="sdk_error", message=str(exc), retryable=True),
            )
        except TimeoutError as exc:
            return contract.TurnResult(
                text=ex.text,
                tool_calls=ex.tools,
                error=contract.ProviderError(code="LLM_TIMEOUT", message=str(exc), retryable=True),
            )
        except Exception as exc:
            _log.error("turn failed: %s", exc)
            return contract.TurnResult(
                text=ex.text,
                tool_calls=ex.tools,
                error=contract.ProviderError(code="sdk_error", message=str(exc), retryable=False),
            )

        if ex.last_result is not None:
            session.last_result_message = ex.last_result
        tool_calls = ex.tools
        session.turns_completed += 1
        session.all_tool_calls.extend(tool_calls)

        tool_err = next((tc for tc in tool_calls if tc.error is not None), None)
        return contract.TurnResult(
            text=ex.text,
            tool_calls=tool_calls,
            error=(
                contract.ProviderError(code="tool_error", message=tool_err.error, retryable=False)
                if tool_err is not None
                else None
            ),
        )

    async def finalize(self, session: _Session) -> Any:
        _, contract, _ = _load_deps()
        cost = 0.0
        tokens = {"input": 0, "output": 0}
        if session.last_result_message is not None:
            cost = float(getattr(session.last_result_message, "total_cost_usd", 0.0) or 0.0)
            usage = getattr(session.last_result_message, "usage", {}) or {}
            tokens["input"] = int(usage.get("input_tokens", 0) or 0)
            tokens["output"] = int(usage.get("output_tokens", 0) or 0)
        summary = (
            f"{session.turns_completed} turn(s), {len(session.all_tool_calls)} tool call(s)"
        )
        return contract.FinalResult(
            final_text="",
            turns_completed=session.turns_completed,
            tool_calls=session.all_tool_calls,
            metadata={
                "cost_usd": cost,
                "tokens": tokens,
                "transcript_summary": summary,
            },
        )

    async def shutdown(self, session: _Session) -> None:
        if session.closed:
            return
        try:
            if session.client is not None:
                await session.client.__aexit__(None, None, None)
        except Exception as exc:
            _log.warning("ClaudeSDKClient.__aexit__ raised (ignored): %s", exc)
        finally:
            session.closed = True


def create() -> ClaudeAgentSDKProvider:
    """Public factory consumed by _python_adapter via _PROVIDER_REGISTRY."""
    return ClaudeAgentSDKProvider()
