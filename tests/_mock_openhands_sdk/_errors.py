"""
_errors stub for the mock OpenHands SDK environment.

When PYTHONPATH=tests/_mock_openhands_sdk is set, bare-name imports like
``from _errors import ProviderRuntimeError`` (used inside openhands_sdk/provider.py)
resolve here rather than to the canonical location at
scripts/framework/providers/openhands_sdk/_errors.py.

This stub:
1. Defines ProviderRuntimeError inline (identical to canonical) to avoid
   circular imports.
2. Adds scripts/framework/providers/openhands_sdk/ to sys.path so that
   sibling bare-name imports inside provider.py (agent_factory, model_resolver,
   tool_registry, event_extractor) are resolvable.

Extending the mock is explicitly in-scope per F.26 spec:
"extending the phase-06 mock is in-scope here since the mock exists
explicitly to serve scenarios."
"""

from __future__ import annotations

import os
import sys

# ---------------------------------------------------------------------------
# Ensure scripts/framework/providers/openhands_sdk/ is on sys.path so that
# provider.py's bare-name sibling imports (agent_factory, model_resolver,
# tool_registry, event_extractor) resolve correctly when running under
# PYTHONPATH=tests/_mock_openhands_sdk.
# ---------------------------------------------------------------------------
_MOCK_DIR = os.path.dirname(os.path.abspath(__file__))  # tests/_mock_openhands_sdk/
_HARNESS_ROOT = os.path.dirname(os.path.dirname(_MOCK_DIR))  # repo root
_OPENHANDS_SDK_PROVIDERS = os.path.join(
    _HARNESS_ROOT, "scripts", "framework", "providers", "openhands_sdk"
)
if _OPENHANDS_SDK_PROVIDERS not in sys.path:
    sys.path.insert(0, _OPENHANDS_SDK_PROVIDERS)


# ---------------------------------------------------------------------------
# ProviderRuntimeError — inline definition (mirrors canonical _errors.py).
# ---------------------------------------------------------------------------


class ProviderRuntimeError(Exception):
    """Raised by provider modules to signal structured errors to the adapter.

    Attributes match the ProviderError dataclass fields so _error_dict() in
    the adapter falls back to getattr(exc, 'code', 'sdk_error') correctly.
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


__all__ = ["ProviderRuntimeError"]
