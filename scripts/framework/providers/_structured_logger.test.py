"""Tests for _structured_logger — mirrors structured_logger.test.js."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Ensure providers dir on path for sibling imports.
_PROVIDERS_DIR = Path(__file__).resolve().parent
if str(_PROVIDERS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROVIDERS_DIR))

from _structured_logger import create_logger  # noqa: E402

# ---------------------------------------------------------------------------
# Basic emission
# ---------------------------------------------------------------------------


def test_info_emits_one_ndjson_line(capsys):
    logger = create_logger(run_id="r1", case_id="c1", provider_kind="opencode_cli", model="m1")
    logger.info("hello")
    captured = capsys.readouterr()
    lines = [line for line in captured.err.splitlines() if line.strip()]
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["level"] == "info"
    assert record["msg"] == "hello"


def test_warn_emits_level_warn(capsys):
    logger = create_logger()
    logger.warn("heads up")
    captured = capsys.readouterr()
    record = json.loads(captured.err.strip())
    assert record["level"] == "warn"


def test_error_emits_level_error(capsys):
    logger = create_logger()
    logger.error("boom")
    captured = capsys.readouterr()
    record = json.loads(captured.err.strip())
    assert record["level"] == "error"


# ---------------------------------------------------------------------------
# Required fields
# ---------------------------------------------------------------------------


def test_all_required_fields_present(capsys):
    logger = create_logger(
        run_id="run-42",
        case_id="case-7",
        provider_kind="openhands_sdk",
        model="claude-3",
    )
    logger.info("check fields")
    captured = capsys.readouterr()
    record = json.loads(captured.err.strip())
    for field in ("ts", "level", "msg", "run_id", "case_id", "provider_kind", "model"):
        assert field in record, f"field {field!r} missing from record"


def test_context_fields_reflect_initial_context(capsys):
    logger = create_logger(
        run_id="run-42",
        case_id="case-7",
        provider_kind="openhands_sdk",
        model="claude-3",
    )
    logger.info("ctx")
    captured = capsys.readouterr()
    record = json.loads(captured.err.strip())
    assert record["run_id"] == "run-42"
    assert record["case_id"] == "case-7"
    assert record["provider_kind"] == "openhands_sdk"
    assert record["model"] == "claude-3"


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


def test_logger_redacts_secrets_in_message(capsys):
    logger = create_logger()
    key = "sk-ant-api03-" + "A" * 40 + "1234567890AB"
    logger.info(f"key={key}")
    captured = capsys.readouterr()
    record = json.loads(captured.err.strip())
    assert "sk-ant-" not in record["msg"]
    assert "<redacted-anthropic-api-key>" in record["msg"]


def test_logger_redacts_secrets_in_extra_fields(capsys):
    logger = create_logger()
    key = "sk-ant-api03-" + "A" * 40 + "1234567890AB"
    logger.info("err", error_msg=key)
    captured = capsys.readouterr()
    record = json.loads(captured.err.strip())
    assert "sk-ant-" not in record["error_msg"]


# ---------------------------------------------------------------------------
# Extra fields
# ---------------------------------------------------------------------------


def test_extra_fields_merge_into_record(capsys):
    logger = create_logger()
    logger.info("test", foo="bar", count=3)
    captured = capsys.readouterr()
    record = json.loads(captured.err.strip())
    assert record["foo"] == "bar"
    assert record["count"] == 3


def test_no_extra_does_not_crash(capsys):
    logger = create_logger()
    logger.info("test")
    captured = capsys.readouterr()
    assert captured.err.strip()  # something was emitted


# ---------------------------------------------------------------------------
# ts field is valid ISO 8601
# ---------------------------------------------------------------------------


def test_ts_is_valid_iso_8601(capsys):
    logger = create_logger()
    logger.info("time")
    captured = capsys.readouterr()
    record = json.loads(captured.err.strip())
    iso_8601 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
    assert iso_8601.match(record["ts"]), f"ts not ISO 8601: {record['ts']!r}"


# ---------------------------------------------------------------------------
# Empty context
# ---------------------------------------------------------------------------


def test_logger_works_with_no_context(capsys):
    logger = create_logger()
    logger.info("minimal")
    captured = capsys.readouterr()
    record = json.loads(captured.err.strip())
    assert record["run_id"] is None
    assert record["case_id"] is None
    assert record["provider_kind"] is None
    assert record["model"] is None
