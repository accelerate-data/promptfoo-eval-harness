"""
Secret redactor — Python mirror of scripts/framework/secret_redactor.js.

Both implementations load config/redaction-patterns.json at module init so
the redaction patterns are shared between Node and Python.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Load and compile patterns once at module init.
# ---------------------------------------------------------------------------

_PATTERNS_PATH = Path(__file__).resolve().parents[3] / "config" / "redaction-patterns.json"


def _compile_patterns() -> list[tuple[re.Pattern, str]]:
    with _PATTERNS_PATH.open(encoding="utf-8") as f:
        raw = json.load(f)
    compiled = []
    for entry in raw:
        pattern_str = entry["regex"]
        replacement = entry["replacement"]
        # Strip (?i) inline flag — Python re.compile accepts re.IGNORECASE instead.
        flags = 0
        if pattern_str.startswith("(?i)"):
            pattern_str = pattern_str[4:]
            flags = re.IGNORECASE
        compiled.append((re.compile(pattern_str, flags), replacement))
    return compiled


_COMPILED: list[tuple[re.Pattern, str]] = _compile_patterns()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _redact_string(value: str) -> str:
    out = value
    for pattern, replacement in _COMPILED:
        out = pattern.sub(replacement, out)
    return out


def redact(value: Any) -> Any:
    """Recursively redact secret patterns from strings inside *value*.

    - str → redacted string
    - dict → same structure, string leaf values redacted (keys preserved)
    - list → each element recursively redacted
    - bytes → decoded, redacted, re-encoded (UTF-8, errors='replace')
    - other (None, int, float, bool) → returned unchanged
    """
    if value is None:
        return value
    if isinstance(value, bool):
        # bool is a subclass of int; check it before int.
        return value
    if isinstance(value, str):
        return _redact_string(value)
    if isinstance(value, bytes):
        decoded = value.decode("utf-8", errors="replace")
        return _redact_string(decoded).encode("utf-8")
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    # int, float, etc.
    return value


# ---------------------------------------------------------------------------
# CLI helper for parity tests — when invoked directly, reads a JSON string
# from argv[1], redacts it, prints the result.
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:  # pragma: no cover
        sys.exit(1)
    payload = sys.argv[1]
    try:
        obj = json.loads(payload)
        result = redact(obj)
        print(json.dumps(result))
    except json.JSONDecodeError:
        # Treat as plain string
        print(redact(payload))
