"""
Layer 1+2 tests for event_extractor.py.

No SDK required — events are simple stub objects. Feeds fixture event
sequences and asserts TurnResult shape per spec §1.2.

Run with:
    uv run pytest scripts/framework/providers/openhands_sdk/event_extractor.test.py -v
"""

from __future__ import annotations

import os
import sys
import time

# ---------------------------------------------------------------------------
# Path setup — make _contract and openhands_sdk package importable
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROVIDERS_DIR = os.path.join(_THIS_DIR, "..")
for _p in (_THIS_DIR, _PROVIDERS_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest

from event_extractor import EventExtractor, _truncate
from _contract import TurnResult, ToolCallRecord


# ---------------------------------------------------------------------------
# Minimal stub event classes (no SDK needed)
# ---------------------------------------------------------------------------

class TextContent:
    def __init__(self, text: str) -> None:
        self.text = text


class LLMMessage:
    def __init__(self, content) -> None:
        self.content = content


class SystemPromptEvent:
    pass


class MessageEvent:
    def __init__(self, source: str, content) -> None:
        self.source = source
        self.llm_message = LLMMessage(content)


class ActionEvent:
    def __init__(self, call_id: str, tool_name: str, tool_params: dict) -> None:
        self.id = call_id
        self.tool_name = tool_name
        self.tool_params = tool_params


class ObservationEvent:
    def __init__(self, cause: str, content: str, error=None) -> None:
        self.cause = cause
        self.content = content
        self.error = error


class UnknownSdkEvent:
    pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SIMPLE_FIXTURE = [
    SystemPromptEvent(),
    MessageEvent(source="user", content=[TextContent("hello")]),
    MessageEvent(source="agent", content=[TextContent("Hi there!")]),
]

TOOL_CALL_FIXTURE = [
    SystemPromptEvent(),
    MessageEvent(source="user", content=[TextContent("use bash")]),
    ActionEvent(call_id="c1", tool_name="BashTool", tool_params={"cmd": "ls"}),
    ObservationEvent(cause="c1", content="file1.txt\nfile2.txt"),
    MessageEvent(source="agent", content=[TextContent("Found files.")]),
]

TOOL_ERROR_FIXTURE = [
    ActionEvent(call_id="c2", tool_name="BashTool", tool_params={"cmd": "rm -rf /"}),
    ObservationEvent(cause="c2", content="", error="Permission denied"),
]

ORPHAN_OBSERVATION_FIXTURE = [
    ObservationEvent(cause="no-such-id", content="orphan result"),
]


# ---------------------------------------------------------------------------
# Helper: run fixture through extractor
# ---------------------------------------------------------------------------

def _run_fixture(events) -> TurnResult:
    ex = EventExtractor()
    ex.start_turn()
    for evt in events:
        ex.on_event(evt)
    return ex.end_turn()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestSimpleTextTurn:
    def test_text_assembled_from_agent_messages(self) -> None:
        result = _run_fixture(SIMPLE_FIXTURE)
        assert result.text == "Hi there!"

    def test_no_tool_calls(self) -> None:
        result = _run_fixture(SIMPLE_FIXTURE)
        assert result.tool_calls == []

    def test_no_error(self) -> None:
        result = _run_fixture(SIMPLE_FIXTURE)
        assert result.error is None

    def test_user_message_not_included_in_text(self) -> None:
        result = _run_fixture(SIMPLE_FIXTURE)
        assert "hello" not in result.text

    def test_system_prompt_not_included_in_text(self) -> None:
        result = _run_fixture(SIMPLE_FIXTURE)
        # SystemPromptEvent has no text; just asserting it doesn't crash
        assert isinstance(result.text, str)


class TestToolCallTurn:
    def test_tool_call_name(self) -> None:
        result = _run_fixture(TOOL_CALL_FIXTURE)
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].name == "BashTool"

    def test_tool_call_arguments(self) -> None:
        result = _run_fixture(TOOL_CALL_FIXTURE)
        assert result.tool_calls[0].arguments == {"cmd": "ls"}

    def test_tool_result_attached(self) -> None:
        result = _run_fixture(TOOL_CALL_FIXTURE)
        assert "file1.txt" in result.tool_calls[0].result_truncated

    def test_tool_call_no_error(self) -> None:
        result = _run_fixture(TOOL_CALL_FIXTURE)
        assert result.tool_calls[0].error is None

    def test_agent_text_present_after_tool(self) -> None:
        result = _run_fixture(TOOL_CALL_FIXTURE)
        assert result.text == "Found files."


class TestToolErrorTurn:
    def test_tool_error_populated(self) -> None:
        result = _run_fixture(TOOL_ERROR_FIXTURE)
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].error == "Permission denied"

    def test_tool_result_empty_on_error(self) -> None:
        result = _run_fixture(TOOL_ERROR_FIXTURE)
        assert result.tool_calls[0].result_truncated == ""


class TestOrphanObservation:
    """ObservationEvent with no matching ActionEvent is recorded as orphan."""

    def test_orphan_recorded(self) -> None:
        result = _run_fixture(ORPHAN_OBSERVATION_FIXTURE)
        # Orphan is appended to tool_calls
        assert len(result.tool_calls) == 1

    def test_orphan_has_error_message(self) -> None:
        result = _run_fixture(ORPHAN_OBSERVATION_FIXTURE)
        assert result.tool_calls[0].error is not None
        assert "ORPHAN_TOOL_RESULT" in result.tool_calls[0].error

    def test_orphan_result_preserved(self) -> None:
        result = _run_fixture(ORPHAN_OBSERVATION_FIXTURE)
        assert "orphan result" in result.tool_calls[0].result_truncated


class TestUnknownEvent:
    """Unknown event types do not raise — extractor logs and continues."""

    def test_unknown_event_no_exception(self) -> None:
        result = _run_fixture([UnknownSdkEvent()])
        assert isinstance(result, TurnResult)

    def test_unknown_event_empty_text(self) -> None:
        result = _run_fixture([UnknownSdkEvent()])
        assert result.text == ""


class TestMultipleAgentMessages:
    """Multiple agent MessageEvents are concatenated."""

    def test_two_agent_chunks_concatenated(self) -> None:
        events = [
            MessageEvent(source="agent", content=[TextContent("Hello")]),
            MessageEvent(source="agent", content=[TextContent(" world")]),
        ]
        result = _run_fixture(events)
        assert result.text == "Hello world"


class TestStringContent:
    """Agent MessageEvent with string content (not list) is handled."""

    def test_string_content_extracted(self) -> None:
        evt = MessageEvent(source="agent", content="plain string content")
        result = _run_fixture([evt])
        assert result.text == "plain string content"


class TestStartTurnReset:
    """start_turn() clears state from a previous turn."""

    def test_reset_clears_text(self) -> None:
        ex = EventExtractor()
        ex.start_turn()
        ex.on_event(MessageEvent(source="agent", content=[TextContent("turn 1")]))
        ex.end_turn()

        ex.start_turn()
        ex.on_event(MessageEvent(source="agent", content=[TextContent("turn 2")]))
        result = ex.end_turn()
        assert result.text == "turn 2"

    def test_reset_clears_tool_calls(self) -> None:
        ex = EventExtractor()
        ex.start_turn()
        ex.on_event(ActionEvent(call_id="x1", tool_name="BashTool", tool_params={}))
        ex.on_event(ObservationEvent(cause="x1", content="ok"))
        ex.end_turn()

        ex.start_turn()
        result = ex.end_turn()
        assert result.tool_calls == []


class TestTruncateHelper:
    def test_short_string_unchanged(self) -> None:
        assert _truncate("hello") == "hello"

    def test_long_string_truncated(self) -> None:
        big = "x" * 2000
        out = _truncate(big)
        assert len(out.encode("utf-8")) <= 1024 + 20  # a few extra for "[truncated]"
        assert "[truncated]" in out

    def test_empty_string(self) -> None:
        assert _truncate("") == ""
