"""
sitecustomize.py — auto-executed by Python at interpreter startup when
tests/_mock_claude_agent_sdk/ is on PYTHONPATH.

Patches sys.modules so that ``import claude_agent_sdk`` resolves to the mock
symbols (tests/_mock_claude_agent_sdk/sdk.py) instead of the real
claude-agent-sdk package. Allows scripts.framework.providers.claude_agent_sdk
to run under mock-mode without ANTHROPIC_API_KEY or network access.

IMPORTANT: discovered via PYTHONPATH entry (not importable as a regular module).
Must NOT import from the real claude_agent_sdk package.

Multi-shim chain: Python only auto-executes one ``sitecustomize.py`` per
interpreter (the first one found on sys.path). If multiple ``_mock_*_sdk/``
shims appear on PYTHONPATH (e.g. claude + openhands during nightly CI),
the others would be silently shadowed. To prevent that, after wiring the
local mock this script scans every PYTHONPATH entry whose basename matches
``_mock_*_sdk`` and explicitly executes any sibling ``sitecustomize.py``
it finds. Each shim guards re-entry with ``sys.modules.setdefault`` so
duplicate execution is harmless.

Phase 10 (VD-2174-9) — parallel to tests/_mock_openhands_sdk/sitecustomize.py.
"""

import os
import runpy
import sys
import types

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PYTHONPATH = os.environ.get("PYTHONPATH", "")

if _THIS_DIR in _PYTHONPATH:
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

# Chain-load every OTHER ``_mock_*_sdk/sitecustomize.py`` on PYTHONPATH so
# Python's "only one sitecustomize" limitation does not silently drop the
# remaining mock shims when multiple shims appear in one run.
for _entry in _PYTHONPATH.split(os.pathsep):
    _entry = _entry.strip()
    if not _entry or _entry == _THIS_DIR:
        continue
    _basename = os.path.basename(os.path.normpath(_entry))
    if not (_basename.startswith("_mock_") and _basename.endswith("_sdk")):
        continue
    _sibling = os.path.join(_entry, "sitecustomize.py")
    if os.path.isfile(_sibling):
        try:
            runpy.run_path(_sibling, run_name="__sitecustomize_chain__")
        except Exception:  # pragma: no cover — never let a sibling break our shim
            pass
