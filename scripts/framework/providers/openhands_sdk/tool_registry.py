"""
OpenHands SDK tool registry (spec §1.2 / §7.3).

Declares the whitelist of SDK tool names the harness allows the agent to invoke.
Tool classes are lazy-imported so this module loads without openhands-sdk installed
(important for the JS-side validator which does not have the SDK on its import path).

Spike A.0 verdict: Tool is a Pydantic config spec (name: str, params: dict[str, Any]).
Actual OpenHands SDK pattern:
    from openhands.sdk import Tool
    tools = [Tool(name="BashTool", params={}), ...]
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from _errors import ProviderRuntimeError

if TYPE_CHECKING:
    pass

# Whitelist: canonical tool names recognised by the OpenHands SDK registry.
# Spike A.0.B confirmed these names are valid for openhands-sdk==1.22.1.
ALLOWED_TOOL_NAMES: set[str] = {"BashTool", "FileReadTool", "FileEditTool"}


def get_allowed_tools(names: list[str] | None = None) -> list[Any]:
    """Return instantiated Tool config specs ready to pass to Agent(tools=[...]).

    Lazy-imports openhands.sdk.Tool inside the function so importing this module
    without the SDK installed does not raise ImportError.

    Args:
        names: subset of ALLOWED_TOOL_NAMES to instantiate.
               None → return the full whitelist.

    Returns:
        list of Tool(name=..., params={}) config specs.

    Raises:
        ProviderError: if any name in *names* is not in ALLOWED_TOOL_NAMES.
    """
    requested = set(names) if names is not None else ALLOWED_TOOL_NAMES
    unknown = requested - ALLOWED_TOOL_NAMES
    if unknown:
        raise ProviderRuntimeError(
            code="UNKNOWN_TOOL",
            message=f"unknown tool(s): {sorted(unknown)}; allowed: {sorted(ALLOWED_TOOL_NAMES)}",
        )

    # Lazy SDK import — only executed when the adapter actually runs under uv.
    try:
        from openhands.sdk import Tool  # noqa: PLC0415
    except ImportError as exc:
        raise ProviderRuntimeError(
            code="sdk_error",
            message=f"openhands-sdk not installed or importable: {exc}",
        ) from exc

    return [Tool(name=name, params={}) for name in sorted(requested)]
