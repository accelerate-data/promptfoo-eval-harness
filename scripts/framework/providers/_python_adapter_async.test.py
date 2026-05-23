"""
Phase 9.5 async-aware adapter tests (VD-2174-12).

Spawns the adapter with `--kind=async_mock` and drives the same NDJSON
lifecycle as the sync mock, asserting:
  - init/turn/finalize/shutdown succeed when provider methods are coroutines
  - sync providers (regression on the existing `mock` kind) still work
  - errors raised inside an async `turn` are caught and reported via
    `turn_ack.error` (matching the sync error path shape)

Run with:
    uv run pytest scripts/framework/providers/_python_adapter_async.test.py -v
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).parent.parent.parent.parent.resolve()
ADAPTER_PATH = Path(__file__).parent / "_python_adapter.py"


def _start_adapter(kind: str) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, str(ADAPTER_PATH), f"--kind={kind}"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT),
    )


def _send(proc: subprocess.Popen, msg: dict[str, Any]) -> dict[str, Any]:
    assert proc.stdin is not None
    assert proc.stdout is not None
    proc.stdin.write(json.dumps(msg).encode() + b"\n")
    proc.stdin.flush()
    raw = proc.stdout.readline()
    if not raw:
        stderr = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        raise RuntimeError(f"Adapter stdout EOF (no response). stderr: {stderr[:500]}")
    return json.loads(raw)


def _init_cfg(kind: str) -> dict[str, Any]:
    return {
        "type": "init",
        "id": "init-1",
        "config": {
            "provider_kind": kind,
            "model": "test-model",
            "sdk_version": "1.0.0",
            "workspace_root": "/tmp/test-workspace",
            "tools": [],
            "permissions": {},
            "timeout_per_turn_s": 30,
            "provider_label": "test-label",
            "extra": {},
        },
    }


class TestAsyncProviderLifecycle:
    def test_full_lifecycle_round_trip(self) -> None:
        proc = _start_adapter("async_mock")
        try:
            init_resp = _send(proc, _init_cfg("async_mock"))
            assert init_resp["type"] == "init_ack", init_resp
            sid = init_resp["session_id"]

            turn_resp = _send(
                proc,
                {"type": "turn", "id": "t1", "session_id": sid, "message": "hello-async"},
            )
            assert turn_resp["type"] == "turn_ack", turn_resp
            assert turn_resp["error"] is None, turn_resp
            assert turn_resp["text"].startswith("async-mock 0:"), turn_resp["text"]
            assert turn_resp["tool_calls"][0]["name"] == "async_mock_tool"

            final_resp = _send(proc, {"type": "finalize", "id": "f1", "session_id": sid})
            assert final_resp["type"] == "finalize_ack", final_resp
            assert final_resp["tokens"]["input"] == 7

            shutdown_resp = _send(proc, {"type": "shutdown", "id": "s1", "session_id": sid})
            assert shutdown_resp["type"] == "shutdown_ack", shutdown_resp
        finally:
            proc.kill()
            proc.wait()

    def test_async_turn_raises_returns_turn_ack_with_error(self) -> None:
        # async_mock_raising is a separate registry kind that forces the raising provider.
        proc = _start_adapter("async_mock_raising")
        try:
            init_resp = _send(proc, _init_cfg("async_mock_raising"))
            assert init_resp["type"] == "init_ack", init_resp
            sid = init_resp["session_id"]

            turn_resp = _send(
                proc,
                {"type": "turn", "id": "t-err", "session_id": sid, "message": "explode"},
            )
            assert turn_resp["type"] == "turn_ack", turn_resp
            assert turn_resp["error"] is not None, turn_resp
            assert turn_resp["error"]["code"] == "sdk_error", turn_resp["error"]
            assert "forced async-turn failure" in turn_resp["error"]["message"]
            assert turn_resp["text"] == ""
        finally:
            proc.kill()
            proc.wait()


class TestSyncProviderRegression:
    def test_sync_mock_still_works(self) -> None:
        """Regression: sync provider lifecycle unchanged by async-aware wrap."""
        proc = _start_adapter("mock")
        try:
            init_resp = _send(proc, _init_cfg("mock"))
            assert init_resp["type"] == "init_ack"
            sid = init_resp["session_id"]

            turn_resp = _send(
                proc,
                {"type": "turn", "id": "t1", "session_id": sid, "message": "hello-sync"},
            )
            assert turn_resp["type"] == "turn_ack"
            assert turn_resp["error"] is None
            assert turn_resp["text"].startswith("mock response 0:")

            final_resp = _send(proc, {"type": "finalize", "id": "f1", "session_id": sid})
            assert final_resp["type"] == "finalize_ack"

            shutdown_resp = _send(proc, {"type": "shutdown", "id": "s1", "session_id": sid})
            assert shutdown_resp["type"] == "shutdown_ack"
        finally:
            proc.kill()
            proc.wait()
