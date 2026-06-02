"""
Smoke-load test for agent_factory.py (D.19).

Monkey-patches openhands.sdk with the mock SDK so no live API key is needed.
Verifies that build_agent() returns a 2-tuple of the expected mock types.

Run with:
    uv run pytest scripts/framework/providers/openhands_sdk/agent_factory.test.py -v
"""

from __future__ import annotations

import os
import sys
import types

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROVIDERS_DIR = os.path.join(_THIS_DIR, "..")
_REPO_ROOT = os.path.join(_PROVIDERS_DIR, "..", "..", "..")
for _p in (_THIS_DIR, _PROVIDERS_DIR, _REPO_ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest  # noqa: E402

# ---------------------------------------------------------------------------
# Inline minimal mock SDK (avoids dependency on tests/_mock_openhands_sdk
# which is authored in D.20 — factory test must be self-contained per D.19)
# ---------------------------------------------------------------------------


class _MockLLM:
    def __init__(
        self,
        model,
        api_key=None,
        temperature=0.0,
        max_tokens=4096,
        base_url=None,
    ):
        self.model = model
        self.api_key = api_key
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.base_url = base_url


class _MockAgent:
    def __init__(self, llm, tools=None, system_prompt=None, **kwargs):
        self.llm = llm
        self.tools = tools or []
        self.system_prompt = system_prompt


class _MockConversation:
    """Mock Conversation factory — returns itself as the LocalConversation."""

    def __init__(self, agent, workspace=None, delete_on_close=False, **kwargs):
        self.agent = agent
        self.workspace = workspace
        self.delete_on_close = delete_on_close

    def send_message(self, msg):
        pass

    def run(self):
        pass

    def close(self):
        pass


class _MockTool:
    def __init__(self, name, params=None):
        self.name = name
        self.params = params or {}


def _make_mock_sdk_module():
    mod = types.ModuleType("openhands.sdk")
    mod.LLM = _MockLLM
    mod.Agent = _MockAgent
    mod.Conversation = _MockConversation
    mod.Tool = _MockTool
    return mod


# ---------------------------------------------------------------------------
# Mock tool_registry and model_resolver modules
# ---------------------------------------------------------------------------


class _MockToolRegistry:
    @staticmethod
    def get_allowed_tools(names=None):
        names = names or ["terminal"]
        return [_MockTool(name=n) for n in names]


class _MockModelResolver:
    @staticmethod
    def resolve_model(name):
        return {"model": f"anthropic/{name}", "max_tokens": 4096, "temperature": 0.0}


# ---------------------------------------------------------------------------
# Fixture: patch openhands.sdk before import
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def patch_sdk(monkeypatch):
    mock_mod = _make_mock_sdk_module()
    monkeypatch.setitem(sys.modules, "openhands", types.ModuleType("openhands"))
    monkeypatch.setitem(sys.modules, "openhands.sdk", mock_mod)
    yield
    # monkeypatch restores on teardown automatically


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestBuildAgent:
    def _make_cfg(self, **kwargs):
        from _contract import ProviderConfig

        defaults = dict(
            provider_kind="openhands_sdk",
            model="claude-sonnet-4-6",
            sdk_version="1.22.1",
            workspace_root="/tmp/ws",
            tools=[],
            permissions={},
            timeout_per_turn_s=300,
        )
        defaults.update(kwargs)
        return ProviderConfig(**defaults)

    def test_returns_two_tuple(self) -> None:
        from agent_factory import build_agent

        cfg = self._make_cfg()
        result = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_first_element_is_agent(self) -> None:
        from agent_factory import build_agent

        cfg = self._make_cfg()
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert isinstance(agent, _MockAgent)

    def test_second_element_is_conversation(self) -> None:
        from agent_factory import build_agent

        cfg = self._make_cfg()
        _, conv = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert isinstance(conv, _MockConversation)

    def test_conversation_has_workspace(self) -> None:
        from agent_factory import build_agent

        cfg = self._make_cfg(workspace_root="/tmp/myws")
        _, conv = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert conv.workspace == "/tmp/myws"

    def test_conversation_delete_on_close_false(self) -> None:
        from agent_factory import build_agent

        cfg = self._make_cfg()
        _, conv = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert conv.delete_on_close is False

    def test_agent_carries_tools(self) -> None:
        from agent_factory import build_agent

        cfg = self._make_cfg(tools=["terminal"])
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert len(agent.tools) == 1
        assert agent.tools[0].name == "terminal"

    def test_system_prompt_passed_through(self) -> None:
        from agent_factory import build_agent

        cfg = self._make_cfg()
        cfg.extra["system_prompt"] = "You are a helpful assistant."
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.system_prompt == "You are a helpful assistant."

    def test_llm_model_resolved(self) -> None:
        from agent_factory import build_agent

        cfg = self._make_cfg(model="claude-sonnet-4-6")
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.model == "anthropic/claude-sonnet-4-6"


class TestGatewayMode:
    """v1.4.0 — `cfg.extra.base_url` triggers gateway mode: model verbatim,
    OPENHANDS_API_KEY env var, base_url passed through to LLM."""

    def _make_gateway_cfg(self, **kwargs):
        from _contract import ProviderConfig

        extra = {"base_url": "https://gateway.internal/v1"}
        extra.update(kwargs.pop("extra", {}))
        defaults = dict(
            provider_kind="openhands_sdk",
            model="gpt-4o",
            sdk_version="1.22.1",
            workspace_root="/tmp/ws",
            tools=[],
            permissions={},
            timeout_per_turn_s=300,
            extra=extra,
        )
        defaults.update(kwargs)
        return ProviderConfig(**defaults)

    def test_gateway_mode_passes_base_url_to_llm(self) -> None:
        from agent_factory import build_agent

        cfg = self._make_gateway_cfg()
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.base_url == "https://gateway.internal/v1"

    def test_gateway_mode_skips_resolver_and_uses_model_verbatim(self) -> None:
        from agent_factory import build_agent

        # Resolver would prefix this with "anthropic/" in legacy mode.
        # Gateway mode must bypass that and pass the model name through as-is.
        cfg = self._make_gateway_cfg(model="gpt-4o")
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.model == "gpt-4o"

    def test_gateway_mode_uses_openhands_api_key_env(self, monkeypatch) -> None:
        from agent_factory import build_agent

        monkeypatch.setenv("OPENHANDS_API_KEY", "sk-test-gateway-123")
        # Make sure prefix-routed keys do NOT bleed through.
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        cfg = self._make_gateway_cfg()
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.api_key == "sk-test-gateway-123"

    def test_gateway_mode_api_key_none_when_env_unset(self, monkeypatch) -> None:
        from agent_factory import build_agent

        monkeypatch.delenv("OPENHANDS_API_KEY", raising=False)
        cfg = self._make_gateway_cfg()
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.api_key is None

    def test_legacy_mode_when_no_base_url(self) -> None:
        """Sanity: omitting base_url keeps the legacy resolver+prefix path."""
        from agent_factory import build_agent

        from _contract import ProviderConfig

        cfg = ProviderConfig(
            provider_kind="openhands_sdk",
            model="claude-sonnet-4-6",
            sdk_version="1.22.1",
            workspace_root="/tmp/ws",
            tools=[],
            permissions={},
            timeout_per_turn_s=300,
        )
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.base_url is None
        assert agent.llm.model == "anthropic/claude-sonnet-4-6"


class TestEnvOverrides:
    """v1.4.1 — `.env`-driven knobs override tier config so consumers can flip
    model / point at a local server without editing eval-tiers.toml."""

    def _make_cfg(self, **kwargs):
        from _contract import ProviderConfig

        defaults = dict(
            provider_kind="openhands_sdk",
            model="claude-sonnet-4-6",
            sdk_version="1.22.1",
            workspace_root="/tmp/ws",
            tools=[],
            permissions={},
            timeout_per_turn_s=300,
        )
        defaults.update(kwargs)
        return ProviderConfig(**defaults)

    # --- OPENHANDS_BASE_URL ------------------------------------------------

    def test_env_base_url_triggers_gateway_mode(self, monkeypatch) -> None:
        """OPENHANDS_BASE_URL set + no cfg.extra.base_url → gateway mode on."""
        from agent_factory import build_agent

        monkeypatch.setenv("OPENHANDS_BASE_URL", "http://127.0.0.1:8000/v1")
        monkeypatch.delenv("OPENHANDS_MODEL_OVERRIDE", raising=False)
        cfg = self._make_cfg(model="gpt-4o")  # no cfg.extra.base_url
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        # Gateway path: model passes through verbatim (resolver NOT called)
        assert agent.llm.base_url == "http://127.0.0.1:8000/v1"
        assert agent.llm.model == "gpt-4o"

    def test_env_base_url_overrides_cfg_extra_base_url(self, monkeypatch) -> None:
        """When both are set, .env wins so consumer can redirect locally."""
        from agent_factory import build_agent

        monkeypatch.setenv("OPENHANDS_BASE_URL", "http://127.0.0.1:8000/v1")
        monkeypatch.delenv("OPENHANDS_MODEL_OVERRIDE", raising=False)
        cfg = self._make_cfg(
            model="gpt-4o",
            extra={"base_url": "https://gateway.internal/v1"},
        )
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.base_url == "http://127.0.0.1:8000/v1"

    def test_env_base_url_empty_string_falls_back_to_cfg(self, monkeypatch) -> None:
        """Empty OPENHANDS_BASE_URL is treated as unset (consumer .env hygiene)."""
        from agent_factory import build_agent

        monkeypatch.setenv("OPENHANDS_BASE_URL", "")
        monkeypatch.delenv("OPENHANDS_MODEL_OVERRIDE", raising=False)
        cfg = self._make_cfg(
            model="gpt-4o",
            extra={"base_url": "https://gateway.internal/v1"},
        )
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.base_url == "https://gateway.internal/v1"

    # --- OPENHANDS_MODEL_OVERRIDE -----------------------------------------

    def test_env_model_override_in_legacy_mode(self, monkeypatch) -> None:
        """Override propagates through the resolver (legacy / no base_url)."""
        from agent_factory import build_agent

        monkeypatch.delenv("OPENHANDS_BASE_URL", raising=False)
        monkeypatch.setenv("OPENHANDS_MODEL_OVERRIDE", "haiku-4-5")
        cfg = self._make_cfg(model="claude-sonnet-4-6")
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        # Resolver prefixes with "anthropic/" — proves override fed the resolver,
        # not cfg.model.
        assert agent.llm.model == "anthropic/haiku-4-5"

    def test_env_model_override_in_gateway_mode(self, monkeypatch) -> None:
        """Override bypasses resolver in gateway mode (passes through verbatim)."""
        from agent_factory import build_agent

        monkeypatch.setenv("OPENHANDS_BASE_URL", "http://127.0.0.1:8000/v1")
        monkeypatch.setenv("OPENHANDS_MODEL_OVERRIDE", "opencode-go/glm-5.1")
        cfg = self._make_cfg(model="gpt-4o")
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.model == "opencode-go/glm-5.1"
        assert agent.llm.base_url == "http://127.0.0.1:8000/v1"

    def test_env_model_override_empty_string_falls_back_to_cfg(self, monkeypatch) -> None:
        """Empty OPENHANDS_MODEL_OVERRIDE is treated as unset."""
        from agent_factory import build_agent

        monkeypatch.delenv("OPENHANDS_BASE_URL", raising=False)
        monkeypatch.setenv("OPENHANDS_MODEL_OVERRIDE", "")
        cfg = self._make_cfg(model="claude-sonnet-4-6")
        agent, _ = build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert agent.llm.model == "anthropic/claude-sonnet-4-6"


class TestAgentContextWiring:
    """D3 — build_agent must wire AgentContext (plugin skills + orientation
    suffix). Without it the OpenHands agent runs plugin-blind: the SDK does not
    auto-load the .openhands/microagents symlink, so skills never surface via
    the invoke_skill tool."""

    def _make_cfg(self, **kwargs):
        from _contract import ProviderConfig

        defaults = dict(
            provider_kind="openhands_sdk",
            model="claude-sonnet-4-6",
            sdk_version="1.22.1",
            workspace_root="/tmp/ws",
            tools=[],
            permissions={},
            timeout_per_turn_s=300,
        )
        defaults.update(kwargs)
        return ProviderConfig(**defaults)

    def _capturing_agent(self, monkeypatch):
        """Replace openhands.sdk.Agent with a kwargs-capturing class; return the
        capture dict (the factory's lazy `from openhands.sdk import Agent`
        resolves to this patched module attribute)."""
        captured = {}

        class _CapturingAgent:
            def __init__(self, llm, tools=None, system_prompt=None, **kwargs):
                captured["llm"] = llm
                captured["tools"] = tools
                captured["system_prompt"] = system_prompt
                captured["kwargs"] = kwargs

        monkeypatch.setattr(sys.modules["openhands.sdk"], "Agent", _CapturingAgent)
        return captured

    def _install_context_module(self, monkeypatch):
        """Inject a mock openhands.sdk.context with AgentContext +
        load_skills_from_dir (the D3 fix's real import target)."""
        ctx_mod = types.ModuleType("openhands.sdk.context")

        class _MockAgentContext:
            def __init__(self, skills=None, system_message_suffix=None):
                self.skills = skills or []
                self.system_message_suffix = system_message_suffix

        calls = {"dirs": []}

        def _load_skills_from_dir(d):
            calls["dirs"].append(d)
            # Real shape: a tuple of name-keyed dicts; the fix flattens .values().
            return ({"skill_a": object(), "skill_b": object()},)

        ctx_mod.AgentContext = _MockAgentContext
        ctx_mod.load_skills_from_dir = _load_skills_from_dir
        monkeypatch.setitem(sys.modules, "openhands.sdk.context", ctx_mod)
        return calls

    def test_agent_context_passed_when_suffix_present(self, monkeypatch) -> None:
        from agent_factory import build_agent

        captured = self._capturing_agent(monkeypatch)
        self._install_context_module(monkeypatch)
        cfg = self._make_cfg(extra={"system_message_suffix": "ORIENTATION"})
        build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        ctx = captured["kwargs"].get("agent_context")
        assert ctx is not None, "agent_context kwarg must be passed when suffix present"
        assert ctx.system_message_suffix == "ORIENTATION"

    def test_skills_dir_loads_and_flattens(self, monkeypatch) -> None:
        from agent_factory import build_agent

        captured = self._capturing_agent(monkeypatch)
        calls = self._install_context_module(monkeypatch)
        cfg = self._make_cfg(extra={"skills_dir": "/plugins/skills"})
        build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert calls["dirs"] == ["/plugins/skills"], "load_skills_from_dir must receive skills_dir"
        ctx = captured["kwargs"].get("agent_context")
        assert ctx is not None
        assert len(ctx.skills) == 2, "skills from each name-keyed group must be flattened"

    def test_no_agent_context_when_extra_empty(self, monkeypatch) -> None:
        from agent_factory import build_agent

        captured = self._capturing_agent(monkeypatch)
        # Deliberately do NOT install openhands.sdk.context — the fix must not
        # import it when neither skills_dir nor suffix is present.
        cfg = self._make_cfg(extra={})
        build_agent(cfg, _MockToolRegistry, _MockModelResolver)
        assert "agent_context" not in captured["kwargs"], "no agent_context kwarg when extra empty"
