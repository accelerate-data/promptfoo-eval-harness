"""Tests for _secret_redactor — mirrors secret_redactor.test.js."""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure providers dir is on sys.path for direct import.
_PROVIDERS_DIR = Path(__file__).resolve().parent
if str(_PROVIDERS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROVIDERS_DIR))

from _secret_redactor import redact  # noqa: E402

# ---------------------------------------------------------------------------
# Per-pattern positive match tests
# ---------------------------------------------------------------------------


def test_anthropic_api_key_replaced():
    key = "sk-ant-api03-" + "A" * 40 + "1234567890AB"
    out = redact(f"key={key}")
    assert "sk-ant-" not in out
    assert "<redacted-anthropic-api-key>" in out


def test_openai_api_key_proj_replaced():
    key = "sk-proj-" + "A" * 40 + "1234567890AB"
    out = redact(f"Authorization: {key}")
    assert "sk-proj-" not in out
    assert "<redacted-openai-api-key>" in out


def test_openai_api_key_bare_replaced():
    key = "sk-" + "A" * 45
    out = redact(f"key={key}")
    assert key not in out
    assert "<redacted-openai-api-key>" in out


def test_anthropic_key_not_matched_as_openai():
    key = "sk-ant-api03-" + "A" * 40 + "1234567890AB"
    out = redact(key)
    assert "<redacted-anthropic-api-key>" in out
    assert "<redacted-openai-api-key>" not in out


def test_openhands_api_key_replaced():
    key = "oh-" + "a" * 40
    out = redact(f"token={key}")
    assert key not in out
    assert "<redacted-openhands-api-key>" in out


def test_aws_access_key_id_replaced():
    out = redact("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert "<redacted-aws-access-key>" in out


def test_github_pat_ghp_replaced():
    pat = "ghp_" + "A" * 36
    out = redact(f"token={pat}")
    assert "ghp_" not in out
    assert "<redacted-github-pat>" in out


def test_github_pat_ghs_replaced():
    pat = "ghs_" + "A" * 36
    out = redact(f"token={pat}")
    assert "ghs_" not in out
    assert "<redacted-github-pat>" in out


def test_bearer_token_replaced_preserving_prefix():
    out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.some-payload")
    assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in out
    assert "Bearer <redacted-bearer-token>" in out


def test_bearer_token_case_insensitive():
    out = redact("authorization: bearer abc123TokenXYZ")
    assert "abc123TokenXYZ" not in out
    # After redaction we'll see bearer (lowercase preserved) + replacement
    assert "<redacted-bearer-token>" in out


def test_gcp_private_key_block_replaced():
    snippet = (
        '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----'
        '\\nMIIEvAIBADANBgkqhkiG9w0B\\n-----END PRIVATE KEY-----\\n"}'
    )
    out = redact(snippet)
    assert "BEGIN PRIVATE KEY" not in out
    assert "<redacted-gcp-private-key>" in out


# ---------------------------------------------------------------------------
# Negative (false-positive guard)
# ---------------------------------------------------------------------------


def test_plain_text_unchanged():
    s = "Hello, this is a normal log line with no secrets"
    assert redact(s) == s


# ---------------------------------------------------------------------------
# Multi-pattern combined
# ---------------------------------------------------------------------------


def test_multiple_keys_all_redacted():
    anthropic = "sk-ant-api03-" + "A" * 40 + "1234567890AB"
    ghpat = "ghp_" + "B" * 36
    bearer = "Bearer tokenXYZABC123"
    text = f"anthropic={anthropic} pat={ghpat} auth={bearer}"
    out = redact(text)
    assert "sk-ant-" not in out
    assert "ghp_" not in out
    assert "tokenXYZABC123" not in out
    assert "<redacted-anthropic-api-key>" in out
    assert "<redacted-github-pat>" in out
    assert "<redacted-bearer-token>" in out


# ---------------------------------------------------------------------------
# Object recursion
# ---------------------------------------------------------------------------


def test_nested_dict_string_leaves_redacted():
    key = "sk-ant-api03-" + "A" * 40 + "1234567890AB"
    inner = "Bearer sk-ant-api03-" + "B" * 40 + "1234567890AB"
    obj = {"error": {"message": f"Bearer {key}", "inner": [inner]}}
    out = redact(obj)
    assert "sk-ant-" not in out["error"]["message"]
    assert "sk-ant-" not in out["error"]["inner"][0]
    # Anthropic pattern fires first on the value portion — either replacement is valid
    assert (
        "<redacted-anthropic-api-key>" in out["error"]["message"]
        or "Bearer <redacted-bearer-token>" in out["error"]["message"]
    )
    assert "error" in out
    assert "message" in out["error"]


def test_dict_keys_not_redacted():
    key_name = "sk-ant-api03-" + "A" * 40 + "12345"
    obj = {key_name: "value"}
    out = redact(obj)
    assert list(out.keys()) == [key_name]


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_empty_string():
    assert redact("") == ""


def test_none_returns_none():
    assert redact(None) is None


def test_integer_unchanged():
    assert redact(42) == 42


def test_bool_unchanged():
    assert redact(True) is True
    assert redact(False) is False


def test_bytes_redacted():
    key = b"sk-ant-api03-" + b"A" * 40 + b"1234567890AB"
    out = redact(key)
    assert isinstance(out, bytes)
    assert b"sk-ant-" not in out
    assert b"<redacted-anthropic-api-key>" in out
