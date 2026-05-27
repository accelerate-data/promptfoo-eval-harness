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

import json
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

        Live SDK fields (openhands.sdk.event ActionEvent):
            evt.id           — EventID of this action (matched by ObservationEvent.action_id)
            evt.tool_name    — name in tool registry (str)
            evt.tool_call_id — canonical tool call id (matched by ObservationEvent.tool_call_id)
            evt.tool_call    — MessageToolCall whose .arguments is a JSON string
        Older/stub shapes (evt.tool_params / evt.params dicts) are still honored
        via _extract_action_args fallbacks.
        """
        call_id = getattr(evt, "id", "") or ""
        tool_call_id = getattr(evt, "tool_call_id", "") or ""
        name = getattr(evt, "tool_name", "") or getattr(evt, "name", "") or "unknown"

        idx = len(self._tool_calls)
        self._tool_calls.append(
            {
                "call_id": call_id,
                "name": name,
                "arguments": _extract_action_args(evt),
                "result": "",
                "error": None,
            }
        )
        # Index by BOTH ids so an observation can match via action_id OR tool_call_id.
        if call_id:
            self._call_id_index[call_id] = idx
        if tool_call_id:
            self._call_id_index[tool_call_id] = idx

    def _handle_observation(self, evt: Any) -> None:
        """Attach a tool result to its matching ActionEvent record.

        Live SDK fields (openhands.sdk.event ObservationEvent):
            evt.action_id    — EventID of the originating ActionEvent
            evt.tool_call_id — canonical tool call id (fallback linkage key)
            evt.observation  — Observation with .content (list[TextContent|ImageContent])
                               and .is_error (bool)
        Older/stub shapes (evt.cause / evt.content / evt.error) are still honored
        via the getattr fallbacks below.
        """
        # Try each linkage key in priority order; the FIRST that resolves to a
        # recorded ActionEvent wins. A truthy-but-unmatched action_id must NOT
        # short-circuit the tool_call_id fallback (hence per-key index lookup).
        candidate_ids = [
            getattr(evt, "action_id", "") or "",
            getattr(evt, "tool_call_id", "") or "",
            getattr(evt, "cause", "") or "",
        ]
        content = _extract_observation_text(evt)
        error = _extract_observation_error(evt, content)

        matched_id = next(
            (k for k in candidate_ids if k and k in self._call_id_index), ""
        )
        if matched_id:
            idx = self._call_id_index[matched_id]
            self._tool_calls[idx]["result"] = content
            if error:
                self._tool_calls[idx]["error"] = str(error)
        else:
            cause_id = next((k for k in candidate_ids if k), "")
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


def _extract_action_args(evt: Any) -> dict[str, Any]:
    """Pull call arguments off an ActionEvent across SDK shapes.

    Live SDK keeps args as a JSON string at evt.tool_call.arguments; older/stub
    shapes expose a dict at evt.tool_params / evt.params.
    """
    tool_call = getattr(evt, "tool_call", None)
    if tool_call is not None:
        raw = getattr(tool_call, "arguments", None)
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str) and raw:
            try:
                parsed = json.loads(raw)
            except (ValueError, TypeError):
                return {"_raw": raw}
            return parsed if isinstance(parsed, dict) else {"_raw": raw}
    params = getattr(evt, "tool_params", None) or getattr(evt, "params", None) or {}
    return dict(params) if params else {}


def _extract_observation_text(evt: Any) -> str:
    """Pull plain text off an ObservationEvent across SDK shapes.

    Live SDK nests output at evt.observation.content (list of TextContent /
    ImageContent blocks); older/stub shapes expose a flat str at evt.content.
    """
    obs = getattr(evt, "observation", None)
    if obs is not None:
        content = getattr(obs, "content", None)
        if isinstance(content, str):
            return content
        if content is not None:
            parts = [
                block.text
                for block in content
                if isinstance(getattr(block, "text", None), str)
            ]
            if parts:
                return "\n".join(parts)
    return getattr(evt, "content", "") or ""


def _extract_observation_error(evt: Any, text: str) -> Any:
    """Derive a tool-error message off an ObservationEvent across SDK shapes.

    Live SDK signals failure via evt.observation.is_error (the message lives in
    the content); older/stub shapes expose a flat evt.error string.
    """
    obs = getattr(evt, "observation", None)
    if obs is not None and getattr(obs, "is_error", False):
        return text or "tool error"
    return getattr(evt, "error", None)


def _truncate(s: str, max_bytes: int = 1024) -> str:
    """Truncate a result string to at most max_bytes UTF-8 bytes (spec §7.1)."""
    if not s:
        return ""
    encoded = s.encode("utf-8")
    if len(encoded) <= max_bytes:
        return s
    return encoded[:max_bytes].decode("utf-8", errors="replace") + " [truncated]"
