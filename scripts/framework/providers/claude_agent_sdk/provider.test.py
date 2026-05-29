"""
Layer 3 mock-SDK tests for the Claude Agent SDK provider (Phase 10 / VD-2174-9).

Monkey-patches ``claude_agent_sdk`` with tests._mock_claude_agent_sdk.sdk so
no ANTHROPIC_API_KEY / network is needed.

Coverage (per phase-10 plan §Success Criteria):
  - Single-turn happy path: query() yields AssistantMessage + ResultMessage
  - Multi-turn happy path: 3 turns, all assistant text captured
  - Multi-turn dependency: turn 2 recalls value remembered in turn 1
  - Tool-call error mid-turn: ToolCallRecord.error populated, turn-level error
    set to ``tool_error``
  - Malformed message: provider ignores _WeirdMessage and continues
  - Auth error: ProcessError → TurnResult.error.code == "auth"
  - UNSUPPORTED_MODEL / UNSUPPORTED_TOOL / PERMISSION_DENIED validation
  - Permission granted (allow_shell=True) admits Bash
  - shutdown is idempotent; client allocated only for multi-turn

Async lifecycle is driven via ``asyncio.run`` (no pytest-asyncio dep — matches
the Phase 9.5 async_mock test convention).

Run with:
    uv run pytest scripts/framework/providers/claude_agent_sdk/provider.test.py -v
"""

from __future__ import annotations

import asyncio
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
# Mock SDK install/uninstall helpers — fixture scope ensures every test
# starts with a fresh sys.modules["claude_agent_sdk"] entry.
# ---------------------------------------------------------------------------


def _install_mock_sdk():
    from tests._mock_claude_agent_sdk import sdk as mock_sdk

    pkg = types.ModuleType("claude_agent_sdk")
    for attr in dir(mock_sdk):
        if not attr.startswith("__"):
            setattr(pkg, attr, getattr(mock_sdk, attr))
    sys.modules["claude_agent_sdk"] = pkg
    return mock_sdk


def _uninstall_mock_sdk():
    sys.modules.pop("claude_agent_sdk", None)


@pytest.fixture(autouse=True)
def mock_sdk_fixture():
    mock = _install_mock_sdk()
    # Reset provider's lazy-import cache so the freshly-patched sys.modules
    # entry is the one provider methods see.
    for key in list(sys.modules.keys()):
        if "claude_agent_sdk.provider" in key:
            mod = sys.modules.get(key)
            if mod is not None and hasattr(mod, "_SDK"):
                mod._SDK = None
                mod._CONTRACT = None
                mod._TOOLS = None
    yield mock
    _uninstall_mock_sdk()


@pytest.fixture()
def provider():
    # Late import — after sys.modules patch is in place.
    from scripts.framework.providers.claude_agent_sdk.provider import create

    return create()


def _make_cfg(*, total_turns: int = 1, model: str = "sonnet", tools=None, permissions=None):
    from scripts.framework.providers._contract import ProviderConfig

    return ProviderConfig(
        provider_kind="claude_agent_sdk",
        model=model,
        sdk_version="0.2.85",
        workspace_root="/tmp/claude-ws",
        tools=tools or [],
        permissions=permissions or {},
        timeout_per_turn_s=300,
        extra={"total_turns": total_turns},
    )


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Single-turn lifecycle
# ---------------------------------------------------------------------------


class TestSingleTurn:
    def test_init_single_turn_no_client(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=1)))
        assert session.client is None
        assert session.total_turns_planned == 1

    def test_single_turn_happy_path(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=1)))
        result = _run(provider.turn(session, "hello"))
        assert result.text == "Hi there!"
        assert result.tool_calls == []
        assert result.error is None

    def test_finalize_after_single_turn(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=1)))
        _run(provider.turn(session, "hello"))
        final = _run(provider.finalize(session))
        assert final.turns_completed == 1
        assert final.metadata["cost_usd"] > 0
        assert final.metadata["tokens"]["input"] > 0


# ---------------------------------------------------------------------------
# Multi-turn lifecycle
# ---------------------------------------------------------------------------


class TestMultiTurn:
    def test_init_multi_turn_allocates_client(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=3)))
        assert session.client is not None
        assert session.client.entered is True

    def test_three_turns_all_assistant(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=3)))
        for _ in range(3):
            r = _run(provider.turn(session, "hello"))
            assert r.text == "Hi there!"
        assert session.turns_completed == 3

    def test_multi_turn_dependency(self, provider) -> None:
        """Skeptic #3 dependency: turn 2 must see turn 1's history via the same client."""
        session = _run(provider.init(_make_cfg(total_turns=2)))
        r1 = _run(provider.turn(session, "Please remember 42 for me."))
        assert "Echo" in r1.text or "42" in r1.text
        client_id_after_t1 = id(session.client)
        r2 = _run(provider.turn(session, "what number was it?"))
        assert "42" in r2.text
        # Same client across turns — provider must NOT recreate.
        assert id(session.client) == client_id_after_t1

    def test_shutdown_after_multi_turn(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=2)))
        _run(provider.turn(session, "hello"))
        _run(provider.shutdown(session))
        assert session.closed is True
        assert session.client.closed is True


# ---------------------------------------------------------------------------
# Failure modes
# ---------------------------------------------------------------------------


class TestFailureModes:
    def test_tool_call_error(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=1)))
        result = _run(provider.turn(session, "__tool_error__: please read /etc/x"))
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].error is not None
        assert "permission denied" in result.tool_calls[0].error.lower()
        assert result.error is not None
        assert result.error.code == "tool_error"

    def test_malformed_event_ignored(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=1)))
        result = _run(provider.turn(session, "__malformed__: stress test extractor"))
        assert result.text == "ok"
        assert result.error is None

    def test_auth_error_via_process_error(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=1)))
        result = _run(provider.turn(session, "__auth_error__: invalid key"))
        assert result.error is not None
        assert result.error.code == "auth"
        assert result.error.retryable is False

    def test_shutdown_idempotent(self, provider) -> None:
        session = _run(provider.init(_make_cfg(total_turns=2)))
        _run(provider.shutdown(session))
        _run(provider.shutdown(session))  # must not raise
        assert session.closed is True


# ---------------------------------------------------------------------------
# Validation: model + tool + permission gates (tools.py)
# ---------------------------------------------------------------------------


class TestValidation:
    def test_unsupported_model(self, provider) -> None:
        from scripts.framework.providers.claude_agent_sdk.tools import ProviderRuntimeError

        with pytest.raises(ProviderRuntimeError) as exc_info:
            _run(provider.init(_make_cfg(model="gpt-4")))
        assert exc_info.value.code == "UNSUPPORTED_MODEL"

    def test_unsupported_tool(self, provider) -> None:
        from scripts.framework.providers.claude_agent_sdk.tools import ProviderRuntimeError

        with pytest.raises(ProviderRuntimeError) as exc_info:
            _run(provider.init(_make_cfg(tools=["NonExistentTool"])))
        assert exc_info.value.code == "UNSUPPORTED_TOOL"

    def test_permission_denied_for_bash_without_allow_shell(self, provider) -> None:
        from scripts.framework.providers.claude_agent_sdk.tools import ProviderRuntimeError

        with pytest.raises(ProviderRuntimeError) as exc_info:
            _run(provider.init(_make_cfg(tools=["Bash"])))
        assert exc_info.value.code == "PERMISSION_DENIED"

    def test_bash_admitted_with_allow_shell(self, provider) -> None:
        session = _run(
            provider.init(
                _make_cfg(tools=["Bash"], permissions={"allow_shell": True})
            )
        )
        assert "Bash" in session.options.allowed_tools

    def test_websearch_denied_without_allow_web(self, provider) -> None:
        from scripts.framework.providers.claude_agent_sdk.tools import ProviderRuntimeError

        with pytest.raises(ProviderRuntimeError) as exc_info:
            _run(provider.init(_make_cfg(tools=["WebSearch"])))
        assert exc_info.value.code == "PERMISSION_DENIED"

    def test_default_on_tools_present_without_request(self, provider) -> None:
        session = _run(provider.init(_make_cfg(tools=[])))
        # Read / Write / Edit / Glob / Grep are default-on.
        for t in ("Read", "Write", "Edit", "Glob", "Grep"):
            assert t in session.options.allowed_tools
        assert "Bash" not in session.options.allowed_tools

    def test_model_alias_resolved(self, provider) -> None:
        session = _run(provider.init(_make_cfg(model="opus")))
        assert session.options.model == "claude-opus-4-7"
