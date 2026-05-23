"""
Layer 1 unit tests for model_resolver.py.

No SDK required — pure Python, no network calls.

Run with:
    uv run pytest scripts/framework/providers/openhands_sdk/model_resolver.test.py -v
"""

from __future__ import annotations

import os
import sys

# ---------------------------------------------------------------------------
# Ensure _contract and openhands_sdk package are importable
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROVIDERS_DIR = os.path.join(_THIS_DIR, "..")
for _p in (_THIS_DIR, _PROVIDERS_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest  # noqa: E402
from model_resolver import _MODEL_MAP, resolve_model  # noqa: E402


class TestResolveModelAliases:
    """Each known alias resolves to the expected LiteLLM-prefixed string."""

    @pytest.mark.parametrize(
        "alias,expected_litellm",
        [
            ("claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"),
            ("claude-haiku-4-5", "anthropic/claude-haiku-4-5"),
            ("claude-opus-4", "anthropic/claude-opus-4"),
            ("gpt-4o-mini", "openai/gpt-4o-mini"),
            ("gpt-4o", "openai/gpt-4o"),
        ],
    )
    def test_known_alias_resolves(self, alias: str, expected_litellm: str) -> None:
        result = resolve_model(alias)
        assert result["model"] == expected_litellm, f"alias={alias}"

    def test_all_map_entries_have_tests(self) -> None:
        """Guard: every entry in _MODEL_MAP is covered by the parametrize above."""
        tested = {
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
            "claude-opus-4",
            "gpt-4o-mini",
            "gpt-4o",
        }
        assert set(_MODEL_MAP.keys()) == tested, (
            "New alias added to _MODEL_MAP but not to the test parametrize list. Add a row above."
        )


class TestResolveModelDefaults:
    """Returned dict always contains max_tokens and temperature with sensible defaults."""

    def test_default_max_tokens(self) -> None:
        result = resolve_model("claude-sonnet-4-6")
        assert result["max_tokens"] == 4096

    def test_default_temperature(self) -> None:
        result = resolve_model("claude-sonnet-4-6")
        assert result["temperature"] == 0.0

    def test_required_keys_present(self) -> None:
        result = resolve_model("gpt-4o-mini")
        assert "model" in result
        assert "max_tokens" in result
        assert "temperature" in result


class TestResolveModelPassthrough:
    """Fully-qualified LiteLLM strings are passed through without transformation."""

    def test_passthrough_anthropic(self) -> None:
        result = resolve_model("anthropic/claude-sonnet-4-6")
        assert result["model"] == "anthropic/claude-sonnet-4-6"

    def test_passthrough_openai(self) -> None:
        result = resolve_model("openai/gpt-4o-mini")
        assert result["model"] == "openai/gpt-4o-mini"

    def test_passthrough_openrouter(self) -> None:
        result = resolve_model("openrouter/mistralai/mistral-7b")
        assert result["model"] == "openrouter/mistralai/mistral-7b"

    def test_passthrough_defaults_still_present(self) -> None:
        result = resolve_model("anthropic/claude-opus-4")
        assert result["max_tokens"] == 4096
        assert result["temperature"] == 0.0


class TestResolveModelUnknown:
    """Unknown names raise ProviderRuntimeError(code='UNKNOWN_MODEL')."""

    def test_unknown_raises_provider_runtime_error(self) -> None:
        from _errors import ProviderRuntimeError

        with pytest.raises(ProviderRuntimeError) as exc_info:
            resolve_model("not-a-real-model")
        err = exc_info.value
        assert err.code == "UNKNOWN_MODEL"
        assert err.retryable is False
        assert "not-a-real-model" in err.message

    def test_unknown_message_lists_known_aliases(self) -> None:
        from _errors import ProviderRuntimeError

        with pytest.raises(ProviderRuntimeError) as exc_info:
            resolve_model("claude-3-haiku")
        err = exc_info.value
        assert "claude-haiku-4-5" in err.message or "known aliases" in err.message

    def test_empty_string_raises(self) -> None:
        from _errors import ProviderRuntimeError

        with pytest.raises(ProviderRuntimeError) as exc_info:
            resolve_model("")
        assert exc_info.value.code == "UNKNOWN_MODEL"
