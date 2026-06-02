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

Consumer-side .env overrides (v1.4.1):
    * `OPENHANDS_MODEL_OVERRIDE` — when set, replaces ``cfg.model`` before
      resolution. Applies to BOTH gateway and legacy modes; lets engineers
      switch model without editing eval-tiers.toml.
    * `OPENHANDS_BASE_URL` — when set, replaces ``cfg.extra.base_url`` and
      forces gateway mode. Useful for pointing at a local OpenHands server
      (e.g. ``http://127.0.0.1:8000/v1``) without changing the tier config.
    Both env vars must be listed in ``config/sdk-pins.toml`` →
    ``[openhands_sdk].env_allowlist`` so the Node bridge forwards them to the
    Python subprocess (env_allowlist is the only whitelist).
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
    callbacks: list[Any] | None = None,
) -> tuple[Any, Any]:
    """Construct and return (agent, conversation) from *cfg*.

    Args:
        cfg:               ProviderConfig from the adapter init message.
        tool_registry_mod: the tool_registry module (or a mock with get_allowed_tools).
        model_resolver_mod: the model_resolver module (or a mock with resolve_model).
        callbacks:         optional list of event callbacks. Passed to
                           Conversation(callbacks=...) at construction time —
                           the real LocalConversation in openhands-sdk 1.22.1
                           does NOT expose ``_callbacks`` or ``add_callback()``,
                           so registration must happen here.

    Returns:
        (agent, conversation) where conversation is a LocalConversation instance
        per spike A.0 discrepancy row #1.

    Raises:
        ProviderRuntimeError: on bad config or SDK import failure.
    """
    from _errors import ProviderRuntimeError  # noqa: PLC0415

    # Env overrides (v1.4.1): consumer-side .env wins over eval-tiers.toml so
    # engineers can flip model / point at a local server without editing the
    # tier config. Treat empty strings as unset.
    env_base_url = os.environ.get("OPENHANDS_BASE_URL") or None
    env_model_override = os.environ.get("OPENHANDS_MODEL_OVERRIDE") or None

    cfg_base_url = cfg.extra.get("base_url") if cfg.extra else None
    base_url = env_base_url or cfg_base_url
    gateway_mode = bool(base_url)
    effective_model = env_model_override or cfg.model

    # --- Model resolution ------------------------------------------------
    if gateway_mode:
        # Gateway mode: model passes through verbatim, no alias map / prefix
        # routing. Default LLM params come from the resolver's constants so
        # gateway and legacy modes stay aligned.
        model_str = effective_model
        default_temperature = 0.0
        default_max_tokens = 4096
    else:
        try:
            llm_cfg = model_resolver_mod.resolve_model(effective_model)
        except ProviderRuntimeError:
            raise
        except Exception as exc:
            raise ProviderRuntimeError(
                code="sdk_error",
                message=f"model resolution failed for {effective_model!r}: {exc}",
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

    # Build an AgentContext from consumer-provided plugin skills + an
    # orientation suffix. Without this a bare Agent runs plugin-blind: the
    # SDK does not auto-load the .openhands/microagents symlink, so skills must
    # be injected explicitly. AgentContext.skills surfaces them via the
    # invoke_skill tool, and system_message_suffix is appended to the base
    # system prompt (system_prompt stays None so the base j2 prompt — and its
    # tool scaffolding — is preserved rather than replaced).
    agent_context = None
    skills_dir = cfg.extra.get("skills_dir") if cfg.extra else None
    system_message_suffix = (
        cfg.extra.get("system_message_suffix") if cfg.extra else None
    )
    if skills_dir or system_message_suffix:
        try:
            from openhands.sdk.context import (  # noqa: PLC0415
                AgentContext,
                load_skills_from_dir,
            )

            skills: list[Any] = []
            if skills_dir:
                # load_skills_from_dir returns a tuple of name-keyed dicts;
                # flatten every group into a single skills list.
                for group in load_skills_from_dir(skills_dir):
                    skills.extend(group.values())
            agent_context = AgentContext(
                skills=skills,
                system_message_suffix=system_message_suffix,
            )
        except ProviderRuntimeError:
            raise
        except Exception as exc:
            raise ProviderRuntimeError(
                code="sdk_error",
                message=f"agent context build failed: {exc}",
            ) from exc

    agent_kwargs: dict[str, Any] = {
        "llm": llm,
        "tools": tools,
        "system_prompt": system_prompt,
    }
    if agent_context is not None:
        agent_kwargs["agent_context"] = agent_context
    agent = Agent(**agent_kwargs)

    # --- Conversation construction ---------------------------------------
    # workspace_root from cfg; delete_on_close=False — bridge owns cleanup (§7.3).
    # callbacks=[...] MUST be passed here for the real SDK — LocalConversation
    # in openhands-sdk 1.22.1 has no _callbacks list or add_callback() method.
    workspace = cfg.workspace_root or os.path.join(os.getcwd(), "workspace")
    conv_kwargs: dict[str, Any] = {
        "agent": agent,
        "workspace": workspace,
        "delete_on_close": False,
    }
    if callbacks:
        conv_kwargs["callbacks"] = callbacks
    conversation = Conversation(**conv_kwargs)

    return agent, conversation
