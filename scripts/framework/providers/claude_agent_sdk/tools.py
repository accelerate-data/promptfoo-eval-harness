"""
Tool derivation, model resolution, and provider-runtime error type for the
claude_agent_sdk provider (Phase 10 / VD-2174-9).

Extracted from provider.py per the phase-10 plan ("If file exceeds 200 lines
after authoring, extract ONLY the tool derivation helper into tools.py
(_BUILTIN_TOOLS, derive_allowed_tools)") — the model resolver lives here too
because it shares the same validation idiom and the same exception type.

Defaults (lead-accepted per Architect #7 / phase-10 plan §Requirements.5):
- Read / Write / Edit / Glob / Grep            → default-ON
- Bash                                          → default-OFF; gated by `permissions.allow_shell`
- WebSearch / WebFetch / AskUserQuestion        → default-OFF; web tools gated by `permissions.allow_web`

A consumer that names a default-off tool in `cfg.tools` without flipping the
matching permission flag is rejected with `PERMISSION_DENIED`. Naming a tool
that is not in `_BUILTIN_TOOLS` at all is `UNSUPPORTED_TOOL`.
"""

from __future__ import annotations

from typing import Any

_BUILTIN_TOOLS: frozenset[str] = frozenset(
    {
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "AskUserQuestion",
    }
)
_DEFAULT_ON: frozenset[str] = frozenset({"Read", "Write", "Edit", "Glob", "Grep"})
_SHELL_GATED: frozenset[str] = frozenset({"Bash"})
_WEB_GATED: frozenset[str] = frozenset({"WebSearch", "WebFetch"})

_MODEL_ALIASES: dict[str, str] = {
    "opus": "claude-opus-4-7",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
}
_SUPPORTED_MODELS: frozenset[str] = frozenset(_MODEL_ALIASES.values())


class ProviderRuntimeError(Exception):
    """Raised by the claude_agent_sdk provider to signal structured errors.

    Attributes match the ProviderError dataclass fields so the adapter's
    `_error_dict()` fallback path picks up the code and retryable flag.
    """

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable

    def __repr__(self) -> str:
        return (
            f"ProviderRuntimeError(code={self.code!r}, "
            f"message={self.message!r}, retryable={self.retryable})"
        )


def resolve_model(name: str) -> str:
    """Resolve short aliases to full Claude model IDs and validate.

    Raises ProviderRuntimeError(UNSUPPORTED_MODEL) if the resulting slug is
    not in the v1.1.0 supported set.
    """
    resolved = _MODEL_ALIASES.get(name, name)
    if resolved not in _SUPPORTED_MODELS:
        raise ProviderRuntimeError(
            code="UNSUPPORTED_MODEL",
            message=(
                f"model {name!r} is not in the v1.1.0 supported set "
                f"({sorted(_SUPPORTED_MODELS)}); aliases: {sorted(_MODEL_ALIASES)}"
            ),
            retryable=False,
        )
    return resolved


def derive_allowed_tools(cfg: Any) -> list[str]:
    """Validate cfg.tools against the built-in catalogue and apply permission gates.

    Returns the sorted final allowlist. Default-on tools are always present.
    `permissions.allow_shell=True` adds Bash; `permissions.allow_web=True` adds
    WebSearch and WebFetch. Tools requested explicitly in cfg.tools must be
    permitted, otherwise PERMISSION_DENIED. Tools not in the catalogue are
    UNSUPPORTED_TOOL.
    """
    requested = list(cfg.tools or [])
    permissions = cfg.permissions or {}
    allow_shell = bool(permissions.get("allow_shell", False))
    allow_web = bool(permissions.get("allow_web", False))

    allowed: set[str] = set(_DEFAULT_ON)

    for name in requested:
        if name not in _BUILTIN_TOOLS:
            raise ProviderRuntimeError(
                code="UNSUPPORTED_TOOL",
                message=(
                    f"tool {name!r} is not a Claude Agent SDK built-in; "
                    f"valid built-ins: {sorted(_BUILTIN_TOOLS)}"
                ),
                retryable=False,
            )
        if name in _SHELL_GATED and not allow_shell:
            raise ProviderRuntimeError(
                code="PERMISSION_DENIED",
                message=f"tool {name!r} requires permissions.allow_shell=True",
                retryable=False,
            )
        if name in _WEB_GATED and not allow_web:
            raise ProviderRuntimeError(
                code="PERMISSION_DENIED",
                message=f"tool {name!r} requires permissions.allow_web=True",
                retryable=False,
            )
        allowed.add(name)

    if allow_shell:
        allowed |= _SHELL_GATED
    if allow_web:
        allowed |= _WEB_GATED

    return sorted(allowed)
