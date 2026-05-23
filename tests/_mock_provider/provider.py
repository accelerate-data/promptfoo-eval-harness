"""
Mock SDK provider for harness contract tests (spec §8.3 Layer 2).

Implements SDKProvider protocol with deterministic canned results.
No live API calls — safe for CI.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "framework", "providers"))

from _contract import FinalResult, ProviderConfig, Session, ToolCallRecord, TurnResult


class MockSession:
    """Lightweight session container tracking call history."""

    def __init__(self, config: ProviderConfig) -> None:
        self.config = config
        self.turns: list[str] = []
        self.closed = False


def init(config: ProviderConfig) -> Session:
    """Construct and return a new mock session."""
    return MockSession(config)


def turn(session: Session, message: str) -> TurnResult:
    """Record the message and return a canned reply."""
    assert isinstance(session, MockSession), "turn: expected MockSession"
    session.turns.append(message)
    turn_index = len(session.turns) - 1
    tool_call = ToolCallRecord(
        name="mock_tool",
        arguments={"turn_index": turn_index, "input": message},
        result_truncated=f"mock_result_{turn_index}",
    )
    return TurnResult(
        text=f"mock response {turn_index}: {message}",
        tool_calls=[tool_call],
    )


def finalize(session: Session) -> FinalResult:
    """Return a summary of the session."""
    assert isinstance(session, MockSession), "finalize: expected MockSession"
    all_tool_calls = [
        ToolCallRecord(
            name="mock_tool",
            arguments={"turn_index": i},
            result_truncated=f"mock_result_{i}",
        )
        for i in range(len(session.turns))
    ]
    return FinalResult(
        final_text=f"mock final after {len(session.turns)} turns",
        turns_completed=len(session.turns),
        tool_calls=all_tool_calls,
        metadata={
            "cost_usd": 0.0,
            "tokens": {"input": 10 * len(session.turns), "output": 5 * len(session.turns)},
            "transcript_summary": f"mock session with {len(session.turns)} turns",
        },
    )


def shutdown(session: Session) -> None:
    """Mark the session as closed (idempotent)."""
    if isinstance(session, MockSession):
        session.closed = True
