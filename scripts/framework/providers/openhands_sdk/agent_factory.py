"""
OpenHands SDK agent factory (spec §2.6 / spike A.0).

Composes LLM + Agent + Conversation from a ProviderConfig.
All SDK imports are lazy (inside the function) so this module loads without
openhands-sdk installed — critical for the JS-side validator import path.

Spike A.0 shape:
    LLM(model=..., api_key=...)                     # pydantic model
    Agent(llm=LLM(...), tools=[Tool(...)], ...)      # pydantic model
    Conversation(agent=..., workspace=..., callbacks=[...])  # factory → LocalConversation

Two LLM construction modes (v1.4.0):
    1. Gateway mode — `cfg.extra.base_url` set: route the LLM at an
       OpenAI-compatible endpoint. Model name passes through verbatim; auth
       is the single `OPENHANDS_API_KEY` env var. Skips the resolver alias
       map entirely.
    2. LiteLLM mode (legacy) — no base_url: resolve `cfg.model` through the
       `_MODEL_MAP` alias table; pick api_key from the model-prefix env var
       (OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY).

Per-tier UX (eval-tiers.toml v1 schema):

    [[tiers.standard.providers]]
    provider_kind = "openhands_sdk"
    model = "gpt-4o"
    [tiers.standard.providers.extra]
    base_url = "https://gateway.internal/v1"
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from _contract import ProviderConfig


def build_agent(
    cfg: "ProviderConfig",
    tool_registry_mod: Any,
    model_resolver_mod: Any,
) -> tuple[Any, Any]:
    """Construct and return (agent, conversation) from *cfg*.

    Args:
        cfg:               ProviderConfig from the adapter init message.
        tool_registry_mod: the tool_registry module (or a mock with get_allowed_tools).
        model_resolver_mod: the model_resolver module (or a mock with resolve_model).

    Returns:
        (agent, conversation) where conversation is a LocalConversation instance
        per spike A.0 discrepancy row #1.

    Raises:
        ProviderRuntimeError: on bad config or SDK import failure.
    """
    from _errors import ProviderRuntimeError  # noqa: PLC0415

    base_url = cfg.extra.get("base_url") if cfg.extra else None
    gateway_mode = bool(base_url)

    # --- Model resolution ------------------------------------------------
    if gateway_mode:
        # Gateway mode: model passes through verbatim, no alias map / prefix
        # routing. Default LLM params come from the resolver's constants so
        # gateway and legacy modes stay aligned.
        model_str = cfg.model
        default_temperature = 0.0
        default_max_tokens = 4096
    else:
        try:
            llm_cfg = model_resolver_mod.resolve_model(cfg.model)
        except ProviderRuntimeError:
            raise
        except Exception as exc:
            raise ProviderRuntimeError(
                code="sdk_error",
                message=f"model resolution failed for {cfg.model!r}: {exc}",
            ) from exc
        model_str = llm_cfg["model"]
        default_temperature = llm_cfg["temperature"]
        default_max_tokens = llm_cfg["max_tokens"]

    # --- Tool list -------------------------------------------------------
    tool_names: list[str] | None = cfg.tools if cfg.tools else None
    try:
        tools = tool_registry_mod.get_allowed_tools(tool_names)
    except ProviderRuntimeError:
        raise
    except Exception as exc:
        raise ProviderRuntimeError(
            code="sdk_error",
            message=f"tool registry init failed: {exc}",
        ) from exc

    # --- SDK imports (lazy) ----------------------------------------------
    try:
        from openhands.sdk import LLM, Agent, Conversation  # noqa: PLC0415
    except ImportError as exc:
        raise ProviderRuntimeError(
            code="sdk_error",
            message=f"openhands-sdk not importable: {exc}",
        ) from exc

    # --- LLM construction ------------------------------------------------
    # api_key sourcing:
    #   - gateway mode: single env var OPENHANDS_API_KEY (whatever the
    #     gateway expects; pass-through to LiteLLM via LLM(api_key=...))
    #   - legacy mode: model-prefix env var (OPENAI_API_KEY / ANTHROPIC_API_KEY
    #     / OPENROUTER_API_KEY). LLM accepts None and falls back to LiteLLM's
    #     own env-var lookup.
    api_key: str | None = None
    if gateway_mode:
        api_key = os.environ.get("OPENHANDS_API_KEY") or None
    elif model_str.startswith("openai/"):
        api_key = os.environ.get("OPENAI_API_KEY")
    elif model_str.startswith("anthropic/"):
        api_key = os.environ.get("ANTHROPIC_API_KEY")
    elif model_str.startswith("openrouter/"):
        api_key = os.environ.get("OPENROUTER_API_KEY")

    llm_kwargs: dict[str, Any] = {
        "model": model_str,
        "api_key": api_key,
        "temperature": cfg.extra.get("temperature", default_temperature),
        "max_tokens": cfg.extra.get("max_tokens", default_max_tokens),
    }
    if gateway_mode:
        llm_kwargs["base_url"] = base_url
    llm = LLM(**llm_kwargs)

    # --- Agent construction ----------------------------------------------
    system_prompt: str | None = cfg.extra.get("system_prompt")
    agent = Agent(
        llm=llm,
        tools=tools,
        system_prompt=system_prompt,
    )

    # --- Conversation construction ---------------------------------------
    # workspace_root from cfg; delete_on_close=False — bridge owns cleanup (§7.3).
    workspace = cfg.workspace_root or os.path.join(os.getcwd(), "workspace")
    conversation = Conversation(
        agent=agent,
        workspace=workspace,
        delete_on_close=False,
    )

    return agent, conversation
