"""
sitecustomize.py — auto-executed by Python at interpreter startup when
tests/_mock_claude_agent_sdk/ is on PYTHONPATH.

Patches sys.modules so that ``import claude_agent_sdk`` resolves to the mock
symbols (tests/_mock_claude_agent_sdk/sdk.py) instead of the real
claude-agent-sdk package. Allows scripts.framework.providers.claude_agent_sdk
to run under mock-mode without ANTHROPIC_API_KEY or network access.

IMPORTANT: discovered via PYTHONPATH entry (not importable as a regular module).
Must NOT import from the real claude_agent_sdk package.

Phase 10 (VD-2174-9) parallel to tests/_mock_openhands_sdk/sitecustomize.py.
Both can coexist on PYTHONPATH because each scopes its patch to a distinct
sys.modules key.
"""

import os
import sys
import types

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PYTHONPATH = os.environ.get("PYTHONPATH", "")

if _THIS_DIR not in _PYTHONPATH:
    # Not running in explicit mock-mode; skip patching.
    pass
else:
    import importlib.util as _ilu

    _sdk_path = os.path.join(_THIS_DIR, "sdk.py")
    _spec = _ilu.spec_from_file_location("_mock_claude_sdk_impl", _sdk_path)
    _mock_sdk = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_mock_sdk)

    _claude_pkg = types.ModuleType("claude_agent_sdk")
    for _attr in dir(_mock_sdk):
        if not _attr.startswith("__"):
            setattr(_claude_pkg, _attr, getattr(_mock_sdk, _attr))

    sys.modules.setdefault("claude_agent_sdk", _claude_pkg)
