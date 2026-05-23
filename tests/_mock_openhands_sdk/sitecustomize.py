"""
sitecustomize.py — auto-executed by Python at interpreter startup when
tests/_mock_openhands_sdk/ is on PYTHONPATH.

Patches sys.modules so that ``from openhands.sdk import LLM, Agent, ...``
resolves to the mock SDK symbols (tests/_mock_openhands_sdk/sdk.py) instead
of the real openhands-sdk package.  This allows openhands_sdk/agent_factory.py
and openhands_sdk/tool_registry.py to run under mock-mode without live SDK
calls or API keys.

IMPORTANT: This file is discovered via PYTHONPATH entry (not importable as a
regular module).  It must NOT import from the real openhands package.

F.26 in-scope extension of the phase-06 mock.
"""

import sys
import types
import os

# Only activate when PYTHONPATH contains this directory (i.e. we're in
# mock-mode for harness scenarios).  Guard to avoid accidental activation
# in production environments that happen to have this dir on sys.path.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PYTHONPATH = os.environ.get("PYTHONPATH", "")
if _THIS_DIR not in _PYTHONPATH:
    # Not running in explicit mock-mode; skip patching.
    pass
else:
    # Import mock SDK symbols from sdk.py (same directory, loaded directly).
    import importlib.util as _ilu
    _sdk_path = os.path.join(_THIS_DIR, "sdk.py")
    _spec = _ilu.spec_from_file_location("_mock_sdk_impl", _sdk_path)
    _mock_sdk = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_mock_sdk)

    # Build synthetic openhands and openhands.sdk modules.
    _openhands_pkg = types.ModuleType("openhands")
    _openhands_sdk_mod = types.ModuleType("openhands.sdk")

    for _attr in dir(_mock_sdk):
        if not _attr.startswith("__"):
            setattr(_openhands_sdk_mod, _attr, getattr(_mock_sdk, _attr))

    _openhands_pkg.sdk = _openhands_sdk_mod
    sys.modules.setdefault("openhands", _openhands_pkg)
    sys.modules.setdefault("openhands.sdk", _openhands_sdk_mod)
