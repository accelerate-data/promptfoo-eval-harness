"""
Layer 3 mock-SDK tests for provider.py (spec §8.3).

Monkey-patches openhands.sdk with tests._mock_openhands_sdk.sdk so no
ANTHROPIC_API_KEY / OPENAI_API_KEY is needed.

Covers:
  - Full lifecycle: init → 3 turns → finalize → shutdown
  - Shutdown is idempotent (second call is a no-op)
  - Tool-call error mid-turn: TurnResult.tool_calls[0].error is populated
  - LLM timeout: TurnResult.error.code == "LLM_TIMEOUT"
  - Malformed (unknown) event from SDK: no exception, extractor logs and continues

Run with:
    uv run pytest scripts/framework/providers/openhands_sdk/provider.test.py -v
"""

from __future__ import annotations

import os
import sys
import types

# ---------------------------------------------------------------------------
# Path setup — must happen before any local imports
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROVIDERS_DIR = os.path.join(_THIS_DIR, "..")
_REPO_ROOT = os.path.join(_PROVIDERS_DIR, "..", "..", "..")
for _p in (_THIS_DIR, _PROVIDERS_DIR, _REPO_ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest  # noqa: E402

# ---------------------------------------------------------------------------
# Helpers to build the mock SDK sys.modules entries
# ---------------------------------------------------------------------------


def _install_mock_sdk():
    """Inject mock SDK into sys.modules before provider imports it."""
    from tests._mock_openhands_sdk import sdk as mock_sdk

    openhands_pkg = types.ModuleType("openhands")
    openhands_sdk_mod = types.ModuleType("openhands.sdk")
    # Attach all public symbols from mock_sdk onto the fake module
    for attr in dir(mock_sdk):
        if not attr.startswith("__"):
            setattr(openhands_sdk_mod, attr, getattr(mock_sdk, attr))

    sys.modules["openhands"] = openhands_pkg
    sys.modules["openhands.sdk"] = openhands_sdk_mod
    return mock_sdk


def _uninstall_mock_sdk():
    sys.modules.pop("openhands", None)
    sys.modules.pop("openhands.sdk", None)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def mock_sdk_fixture():
    """Install mock SDK before each test; remove after."""
    mock = _install_mock_sdk()
    yield mock
    _uninstall_mock_sdk()
    # Also clear cached provider module so re-import picks up patched sys.modules
    for key in list(sys.modules.keys()):
        if "openhands_sdk.provider" in key or key == "provider":
            sys.modules.pop(key, None)


@pytest.fixture()
def provider():
    from provider import create

    return create()


@pytest.fixture()
def cfg():
    from _contract import ProviderConfig

    return ProviderConfig(
        provider_kind="openhands_sdk",
        model="claude-sonnet-4-6",
        sdk_version="1.22.1",
        workspace_root="/tmp/test-ws",
        tools=[],
        permissions={},
        timeout_per_turn_s=300,
    )


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _assert_turn_result_shape(result) -> None:
    """Assert TurnResult satisfies spec §1.2 shape."""
    from _contract import ToolCallRecord, TurnResult

    assert isinstance(result, TurnResult)
    assert isinstance(result.text, str)
    assert isinstance(result.tool_calls, list)
    for tc in result.tool_calls:
        assert isinstance(tc, ToolCallRecord)
        assert isinstance(tc.name, str)
        assert isinstance(tc.arguments, dict)
        assert isinstance(tc.result_truncated, str)


# ---------------------------------------------------------------------------
# Lifecycle tests
# ---------------------------------------------------------------------------


class TestLifecycle:
    def test_init_returns_session(self, provider, cfg) -> None:
        session = provider.init(cfg)
        assert session is not None
        assert not session.closed

    def test_three_turns_each_return_turn_result(self, provider, cfg) -> None:
        session = provider.init(cfg)
        for i, msg in enumerate(["hello", "hello", "hello"]):
            result = provider.turn(session, msg)
            _assert_turn_result_shape(result)

    def test_three_turns_text_non_empty(self, provider, cfg) -> None:
        session = provider.init(cfg)
        for msg in ["hello", "hello", "hello"]:
            result = provider.turn(session, msg)
            assert result.text != ""

    def test_finalize_returns_final_result(self, provider, cfg) -> None:
        from _contract import FinalResult

        session = provider.init(cfg)
        provider.turn(session, "hello")
        provider.turn(session, "hello")
        provider.turn(session, "hello")
        final = provider.finalize(session)
        assert isinstance(final, FinalResult)

    def test_finalize_turns_completed_count(self, provider, cfg) -> None:
        session = provider.init(cfg)
        provider.turn(session, "hello")
        provider.turn(session, "hello")
        provider.turn(session, "hello")
        final = provider.finalize(session)
        assert final.turns_completed == 3

    def test_finalize_transcript_summary_mentions_turns(self, provider, cfg) -> None:
        session = provider.init(cfg)
        provider.turn(session, "hello")
        provider.turn(session, "hello")
        provider.turn(session, "hello")
        final = provider.finalize(session)
        assert "3" in final.metadata["transcript_summary"]

    def test_shutdown_marks_session_closed(self, provider, cfg) -> None:
        session = provider.init(cfg)
        provider.shutdown(session)
        assert session.closed

    def test_shutdown_idempotent(self, provider, cfg) -> None:
        session = provider.init(cfg)
        provider.shutdown(session)
        provider.shutdown(session)  # must not raise
        assert session.closed


# ---------------------------------------------------------------------------
# Failure-mode tests
# ---------------------------------------------------------------------------


class TestToolCallError:
    """Tool-call error mid-turn: TurnResult.tool_calls[0].error is populated."""

    def test_tool_error_in_turn_result(self, provider, cfg, mock_sdk_fixture) -> None:
        session = provider.init(cfg)
        # Inject a tool error into the mock conversation
        session.conversation._force_tool_error = "Permission denied"
        result = provider.turn(session, "use bash")
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].error is not None
        assert "Permission denied" in result.tool_calls[0].error

    def test_tool_error_does_not_set_turn_error(self, provider, cfg, mock_sdk_fixture) -> None:
        """A tool-level error should NOT set TurnResult.error (turn succeeded)."""
        session = provider.init(cfg)
        session.conversation._force_tool_error = "some tool failure"
        result = provider.turn(session, "use bash")
        # turn-level error should be None; error is on the ToolCallRecord
        assert result.error is None


class TestLLMTimeout:
    """LLM timeout: TurnResult.error.code == 'LLM_TIMEOUT'."""

    def test_timeout_sets_turn_error(self, provider, cfg, mock_sdk_fixture) -> None:
        session = provider.init(cfg)
        result = provider.turn(session, "__timeout__: simulate slow LLM")
        assert result.error is not None
        assert result.error.code == "LLM_TIMEOUT"

    def test_timeout_error_is_retryable(self, provider, cfg, mock_sdk_fixture) -> None:
        session = provider.init(cfg)
        result = provider.turn(session, "__timeout__: simulate slow LLM")
        assert result.error.retryable is True

    def test_timeout_text_may_be_empty(self, provider, cfg, mock_sdk_fixture) -> None:
        session = provider.init(cfg)
        result = provider.turn(session, "__timeout__: simulate slow LLM")
        assert isinstance(result.text, str)  # may be empty, must not crash


class TestMalformedEvent:
    """Unknown event class from SDK: no exception bubbles up."""

    def test_unknown_event_no_crash(self, provider, cfg, mock_sdk_fixture) -> None:
        from _contract import TurnResult

        # Inject an unknown event class by patching run() on the conversation
        session = provider.init(cfg)

        class WeirdEvent:
            pass

        original_run = session.conversation.run

        def patched_run():
            # Emit one unknown event then proceed normally
            for cb in session.conversation._callbacks:
                cb(WeirdEvent())
            original_run()

        session.conversation.run = patched_run
        result = provider.turn(session, "hello")
        assert isinstance(result, TurnResult)

    def test_unknown_event_result_still_has_text(self, provider, cfg, mock_sdk_fixture) -> None:
        session = provider.init(cfg)

        class WeirdEvent:
            pass

        original_run = session.conversation.run

        def patched_run():
            for cb in session.conversation._callbacks:
                cb(WeirdEvent())
            original_run()

        session.conversation.run = patched_run
        result = provider.turn(session, "hello")
        assert result.text == "Hi there!"
