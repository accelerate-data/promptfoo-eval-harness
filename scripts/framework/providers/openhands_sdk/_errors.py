"""
Provider-internal exception type for the openhands_sdk provider.

ProviderError in _contract.py is a dataclass (IPC wire type, not an Exception).
Provider code raises ProviderRuntimeError so pytest.raises works normally and so
the _python_adapter._error_dict() fallback path (getattr(exc, 'code', 'sdk_error'))
picks up the structured error code and retryable flag.

The _python_adapter._AdapterError wraps ProviderError for known error paths.
ProviderRuntimeError is used for provider-module-internal errors that propagate
upward through the adapter's general exception handler.
"""

from __future__ import annotations


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
        return f"ProviderRuntimeError(code={self.code!r}, message={self.message!r}, retryable={self.retryable})"
