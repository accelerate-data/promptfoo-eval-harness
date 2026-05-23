"""
OpenHands SDK event extractor (spec §1.2 / §2.6).

Consumes SDK events emitted via Conversation callbacks and assembles the
adapter-internal TurnResult dataclass per spike A.0 findings:

  Event sequence (spike A.0 live run):
    1. SystemPromptEvent  (source=agent)  → noop
    2. MessageEvent       (source=user)   → noop (our own send_message echo)
    3. MessageEvent       (source=agent)  → append text to _text_chunks
    N. ActionEvent        (tool call)     → append ToolCallRecord
    N. ObservationEvent   (tool result)   → update matching ToolCallRecord.result

Spike A.0 discrepancy row #3: turn() calls send_message() then run() (blocking).
Events arrive synchronously inside run() via the callback registered at
Conversation() construction time.
"""

from __future__ import annotations

import logging
import time
from typing import Any

_log = logging.getLogger(__name__)


class EventExtractor:
    """Stateful per-turn event collector.

    Usage:
        extractor = EventExtractor()
        extractor.start_turn()
        conversation.send_message(msg)
        conversation.run()   # callbacks fire synchronously, calling on_event()
        result = extractor.end_turn()
    """

    def __init__(self) -> None:
        self._text_chunks: list[str] = []
        self._tool_calls: list[dict[str, Any]] = []
        self._error: Any = None
        self._t0: float = 0.0
        # Map call_id → index in _tool_calls for fast ToolResult matching
        self._call_id_index: dict[str, int] = {}

    def start_turn(self) -> None:
        """Reset all per-turn state. Call before send_message()."""
        self._text_chunks = []
        self._tool_calls = []
        self._error = None
        self._t0 = time.monotonic()
        self._call_id_index = {}

    def on_event(self, evt: Any) -> None:
        """Route one SDK event to the appropriate handler.

        Unknown event types are logged to stderr and silently skipped —
        they must not raise so run() completes normally.
        """
        evt_type = type(evt).__name__

        if evt_type == "SystemPromptEvent":
            # Auto-emitted by SDK at conversation start — nothing to surface.
            return

        if evt_type == "MessageEvent":
            self._handle_message(evt)
            return

        if evt_type == "ActionEvent":
            self._handle_action(evt)
            return

        if evt_type == "ObservationEvent":
            self._handle_observation(evt)
            return

        # Unknown event — log, do not raise.
        _log.warning("EventExtractor: unknown event type %r — skipped", evt_type)

    def end_turn(self) -> Any:
        """Assemble and return a TurnResult from per-turn state.

        Importing TurnResult / ToolCallRecord here keeps this module
        importable without the contract on sys.path (test-only scenario).
        """
        # Late import so the module loads standalone in unit tests that
        # monkey-patch sys.modules before importing openhands_sdk.

        # Find _contract — it may be on sys.path as '_contract' (adapter path)
        # or as 'scripts.framework.providers._contract' (repo-root import).
        try:
            from _contract import ToolCallRecord, TurnResult  # noqa: PLC0415
        except ImportError:
            from scripts.framework.providers._contract import (  # noqa: PLC0415
                ToolCallRecord,
                TurnResult,
            )

        _latency_ms = int((time.monotonic() - self._t0) * 1000)

        tool_call_records = []
        for tc in self._tool_calls:
            tool_call_records.append(
                ToolCallRecord(
                    name=tc["name"],
                    arguments=tc.get("arguments", {}),
                    result_truncated=_truncate(tc.get("result", "")),
                    error=tc.get("error"),
                )
            )

        return TurnResult(
            text="".join(self._text_chunks),
            tool_calls=tool_call_records,
            error=self._error,
        )

    # ------------------------------------------------------------------
    # Private handlers
    # ------------------------------------------------------------------

    def _handle_message(self, evt: Any) -> None:
        """Extract assistant text from MessageEvent.

        Spike A.0 row #4: text lives at
            evt.llm_message.content[].text  (list of TextContent / ImageContent)
        Only source='agent' messages are surfaced (user echo is skipped).
        """
        source = getattr(evt, "source", None)
        if source != "agent":
            return

        llm_msg = getattr(evt, "llm_message", None)
        if llm_msg is None:
            return

        content = getattr(llm_msg, "content", None)
        if content is None:
            return

        if isinstance(content, str):
            # Flat string content (observed in some SDK versions)
            self._text_chunks.append(content)
            return

        # List of TextContent / ImageContent blocks
        for block in content:
            text = getattr(block, "text", None)
            if text and isinstance(text, str):
                self._text_chunks.append(text)

    def _handle_action(self, evt: Any) -> None:
        """Record a tool call from ActionEvent.

        ActionEvent fields (spike A.0 shape analysis):
            evt.id          — call identifier (str)
            evt.tool_name   — name in tool registry (str)
            evt.tool_params — dict of call arguments
        """
        call_id = getattr(evt, "id", "") or ""
        name = getattr(evt, "tool_name", "") or getattr(evt, "name", "") or "unknown"
        params = getattr(evt, "tool_params", None) or getattr(evt, "params", None) or {}

        idx = len(self._tool_calls)
        self._tool_calls.append(
            {
                "call_id": call_id,
                "name": name,
                "arguments": dict(params) if params else {},
                "result": "",
                "error": None,
            }
        )
        if call_id:
            self._call_id_index[call_id] = idx

    def _handle_observation(self, evt: Any) -> None:
        """Attach a tool result to its matching ActionEvent record.

        ObservationEvent fields:
            evt.cause    — call_id of the originating ActionEvent
            evt.content  — tool output (str)
            evt.error    — error message if tool failed (str | None)
        """
        cause_id = getattr(evt, "cause", "") or ""
        content = getattr(evt, "content", "") or ""
        error = getattr(evt, "error", None)

        if cause_id and cause_id in self._call_id_index:
            idx = self._call_id_index[cause_id]
            self._tool_calls[idx]["result"] = content
            if error:
                self._tool_calls[idx]["error"] = str(error)
        else:
            # Orphan result — append as a new unmatched entry so no data lost.
            _log.warning(
                "EventExtractor: ObservationEvent cause_id=%r has no matching ActionEvent; "
                "recording as orphan tool call",
                cause_id,
            )
            self._tool_calls.append(
                {
                    "call_id": cause_id,
                    "name": "unknown",
                    "arguments": {},
                    "result": content,
                    "error": f"ORPHAN_TOOL_RESULT: no matching ActionEvent for cause_id={cause_id!r}",
                }
            )


def _truncate(s: str, max_bytes: int = 1024) -> str:
    """Truncate a result string to at most max_bytes UTF-8 bytes (spec §7.1)."""
    if not s:
        return ""
    encoded = s.encode("utf-8")
    if len(encoded) <= max_bytes:
        return s
    return encoded[:max_bytes].decode("utf-8", errors="replace") + " [truncated]"
