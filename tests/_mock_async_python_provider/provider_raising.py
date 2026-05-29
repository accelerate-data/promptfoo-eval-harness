"""
Variant of the async mock whose `turn` coroutine raises a synthetic
exception. Used to exercise the adapter's async error path.

Registered as `async_mock_raising` in `_PROVIDER_REGISTRY`.
"""

from __future__ import annotations

from .provider import create_raising


def create():
    """Adapter loader entry point — returns the raising provider."""
    return create_raising()
