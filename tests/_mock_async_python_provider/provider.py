"""
Async Python mock provider for Phase 9.5 adapter tests (VD-2174-12).

Mirrors `tests/_mock_provider/provider.py` but exposes async coroutine
lifecycle methods so the adapter can be exercised on the async path
without relying on a real SDK (claude-agent-sdk arrives in Phase 10).

Async behaviors:
  - `init` awaits a 0-second sleep so the coroutine actually yields.
  - `turn` awaits a sleep then returns a deterministic TurnResult.
  - `finalize` and `shutdown` are also async.

A separate `create_raising()` factory returns a provider whose `turn`
coroutine raises a synthetic exception, so the adapter's error path
under async can be tested.
"""

from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "framework", "providers"))

from _contract import FinalResult, ProviderConfig, Session, ToolCallRecord, TurnResult


class AsyncMockSession:
    def __init__(self, config: ProviderConfig) -> None:
        self.config = config
        self.turns: list[str] = []
        self.closed = False


class _AsyncMockProvider:
    async def init(self, config: ProviderConfig) -> Session:
        await asyncio.sleep(0)
        return AsyncMockSession(config)

    async def turn(self, session: Session, message: str) -> TurnResult:
        assert isinstance(session, AsyncMockSession), "turn: expected AsyncMockSession"
        await asyncio.sleep(0)
        session.turns.append(message)
        turn_index = len(session.turns) - 1
        return TurnResult(
            text=f"async-mock {turn_index}: {message}",
            tool_calls=[
                ToolCallRecord(
                    name="async_mock_tool",
                    arguments={"turn_index": turn_index, "input": message},
                    result_truncated=f"async_result_{turn_index}",
                ),
            ],
        )

    async def finalize(self, session: Session) -> FinalResult:
        assert isinstance(session, AsyncMockSession), "finalize: expected AsyncMockSession"
        await asyncio.sleep(0)
        return FinalResult(
            final_text=f"async-mock final after {len(session.turns)} turns",
            turns_completed=len(session.turns),
            tool_calls=[],
            metadata={
                "cost_usd": 0.0,
                "tokens": {"input": 7 * len(session.turns), "output": 3 * len(session.turns)},
                "transcript_summary": f"async session with {len(session.turns)} turns",
            },
        )

    async def shutdown(self, session: Session) -> None:
        if isinstance(session, AsyncMockSession):
            await asyncio.sleep(0)
            session.closed = True


class _AsyncMockRaisingProvider(_AsyncMockProvider):
    async def turn(self, session: Session, message: str) -> TurnResult:  # type: ignore[override]
        await asyncio.sleep(0)
        raise RuntimeError(f"forced async-turn failure for {message!r}")


def create() -> _AsyncMockProvider:
    """Default factory — happy-path async provider."""
    return _AsyncMockProvider()


def create_raising() -> _AsyncMockRaisingProvider:
    """Variant whose `turn` coroutine raises (test only)."""
    return _AsyncMockRaisingProvider()
