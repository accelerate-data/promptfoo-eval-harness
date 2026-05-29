"""
OpenHands SDK model resolver (spec §1.4).

Maps short model aliases → LiteLLM-prefixed model strings + default LLM parameters.
LiteLLM unifies OpenAI / Anthropic / OpenRouter at the SDK boundary (spike A.0 appendix).

TODO: Load alias map from config/eval-models.toml when that file is introduced (v1.1+).
      For v1.0.0 the map is hard-coded; adding a new model = editing this file + a test row.
"""

from __future__ import annotations

from typing import Any

from _errors import ProviderRuntimeError

# ---------------------------------------------------------------------------
# Alias map: short name → LiteLLM-prefixed model string
# Spike A.0 verified: LLM(model='openai/gpt-4o-mini', api_key=...) routes
# through LiteLLM correctly; same call path for anthropic/ prefix.
# ---------------------------------------------------------------------------
_MODEL_MAP: dict[str, str] = {
    # Anthropic — via LiteLLM anthropic/ prefix
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
    "claude-haiku-4-5": "anthropic/claude-haiku-4-5",
    "claude-opus-4": "anthropic/claude-opus-4",
    # OpenAI — via LiteLLM openai/ prefix (also useful for CI w/ OPENAI_API_KEY)
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gpt-4o": "openai/gpt-4o",
}

_DEFAULT_MAX_TOKENS = 4096
_DEFAULT_TEMPERATURE = 0.0  # deterministic by default


def resolve_model(name: str) -> dict[str, Any]:
    """Resolve a short model alias to an LLM config dict.

    Args:
        name: short alias (e.g. "claude-sonnet-4-6") OR a fully-qualified
              LiteLLM string (e.g. "anthropic/claude-sonnet-4-6") passed
              through without further transformation.

    Returns:
        dict with keys: model (str), max_tokens (int), temperature (float).

    Raises:
        ProviderRuntimeError(code="UNKNOWN_MODEL"): if *name* is not in the alias map
            and does not look like a LiteLLM-prefixed string.
    """
    # Pass-through: already a LiteLLM-prefixed string (contains "/")
    if "/" in name:
        litellm_name = name
    elif name in _MODEL_MAP:
        litellm_name = _MODEL_MAP[name]
    else:
        raise ProviderRuntimeError(
            code="UNKNOWN_MODEL",
            message=(
                f"model {name!r} not in resolver alias map; "
                f"known aliases: {sorted(_MODEL_MAP.keys())}. "
                "Pass a fully-qualified LiteLLM string (e.g. 'anthropic/claude-sonnet-4-6') "
                "or add the alias to model_resolver.py."
            ),
        )

    return {
        "model": litellm_name,
        "max_tokens": _DEFAULT_MAX_TOKENS,
        "temperature": _DEFAULT_TEMPERATURE,
    }
