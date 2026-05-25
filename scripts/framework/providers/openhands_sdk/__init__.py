"""OpenHands SDK provider for promptfoo-eval-harness (spec §6.3)."""

import os as _os
import sys as _sys

# Make sibling modules (_errors, agent_factory, model_resolver, tool_registry,
# event_extractor) reachable via bare imports. provider.py uses lazy
# ``from _errors import ...`` and ``import agent_factory`` that only resolve
# when this package's directory is on sys.path. Appended (not prepended) so
# mock-mode shadows (tests/_mock_openhands_sdk on PYTHONPATH) still win.
_PKG_DIR = _os.path.dirname(_os.path.abspath(__file__))
if _PKG_DIR not in _sys.path:
    _sys.path.append(_PKG_DIR)

__version__ = "1.0.0"
