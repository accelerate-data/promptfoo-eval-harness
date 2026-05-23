"""
OpenHands SDK agent factory (spec §2.6 / spike A.0).

Composes LLM + Agent + Conversation from a ProviderConfig.
All SDK imports are lazy (inside the function) so this module loads without
openhands-sdk installed — critical for the JS-side validator import path.

Spike A.0 shape:
    LLM(model=..., api_key=...)                     # pydantic model
    Agent(llm=LLM(...), tools=[Tool(...)], ...)      # pydantic model
    Conversation(agent=..., workspace=..., callbacks=[...])  # factory → LocalConversation
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

    # --- Model resolution ------------------------------------------------
    try:
        llm_cfg = model_resolver_mod.resolve_model(cfg.model)
    except ProviderRuntimeError:
        raise
    except Exception as exc:
        raise ProviderRuntimeError(
            code="sdk_error",
            message=f"model resolution failed for {cfg.model!r}: {exc}",
        ) from exc

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
        from openhands.sdk import Agent, Conversation, LLM  # noqa: PLC0415
    except ImportError as exc:
        raise ProviderRuntimeError(
            code="sdk_error",
            message=f"openhands-sdk not importable: {exc}",
        ) from exc

    # --- LLM construction ------------------------------------------------
    # api_key: pick from env; LLM accepts None (uses env vars internally via LiteLLM).
    api_key: str | None = None
    model_str: str = llm_cfg["model"]
    if model_str.startswith("openai/"):
        api_key = os.environ.get("OPENAI_API_KEY")
    elif model_str.startswith("anthropic/"):
        api_key = os.environ.get("ANTHROPIC_API_KEY")
    elif model_str.startswith("openrouter/"):
        api_key = os.environ.get("OPENROUTER_API_KEY")

    llm = LLM(
        model=model_str,
        api_key=api_key,
        temperature=cfg.extra.get("temperature", llm_cfg["temperature"]),
        max_tokens=cfg.extra.get("max_tokens", llm_cfg["max_tokens"]),
    )

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
