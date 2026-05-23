"""
OpenHands SDK provider — implements SDKProvider Protocol (spec §1.2 / §2.6).

Entry point: create() → SDKProvider instance.

Spike A.0 discrepancy row #3: turn() calls send_message() then run() (blocking).
Events arrive via the callback registered at Conversation() construction time.
Spike A.0 discrepancy row #7: shutdown() maps to session.conversation.close().
Spike A.0 discrepancy row #1: Session is LocalConversation, not an opaque Protocol.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Session container — wraps LocalConversation + per-session metadata
# ---------------------------------------------------------------------------


@dataclass
class _Session:
    """Internal session state.  Not part of the public contract type."""

    conversation: Any  # LocalConversation
    extractor: Any  # EventExtractor
    turns_completed: int = 0
    all_tool_calls: list = field(default_factory=list)
    closed: bool = False


# ---------------------------------------------------------------------------
# Provider implementation
# ---------------------------------------------------------------------------


class OpenHandsSDKProvider:
    """Implements the SDKProvider Protocol for openhands-sdk."""

    def init(self, cfg: Any) -> _Session:
        """Construct and return a new session.

        Imports tool_registry, model_resolver, agent_factory lazily so
        the provider module loads without the SDK installed.
        """
        from _errors import ProviderRuntimeError  # noqa: PLC0415

        # Lazy imports of sibling modules
        try:
            import agent_factory as af  # noqa: PLC0415
            import model_resolver as mr  # noqa: PLC0415
            import tool_registry as tr  # noqa: PLC0415
            from event_extractor import EventExtractor  # noqa: PLC0415
        except ImportError as exc:
            raise ProviderRuntimeError(
                code="sdk_error",
                message=f"provider sub-module import failed: {exc}",
            ) from exc

        extractor = EventExtractor()

        # Build agent + conversation; conversation callback captures events.
        try:
            _agent, conversation = af.build_agent(cfg, tr, mr)
        except ProviderRuntimeError:
            raise
        except Exception as exc:
            raise ProviderRuntimeError(
                code="sdk_error",
                message=f"agent construction failed: {exc}",
            ) from exc

        # Register the event callback.  MockConversation exposes add_callback();
        # real LocalConversation accepts callbacks=[...] at construction time.
        # agent_factory passes no callbacks — we add them here after construction
        # via add_callback() if available, otherwise rebuild via stored reference.
        # Simplest portable approach: patch the stored _callbacks list directly.
        if hasattr(conversation, "_callbacks"):
            conversation._callbacks.append(extractor.on_event)
        elif hasattr(conversation, "add_callback"):
            conversation.add_callback(extractor.on_event)
        else:
            _log.warning("conversation has no _callbacks attr; events may not be captured")

        return _Session(conversation=conversation, extractor=extractor)

    def turn(self, session: _Session, message: str) -> Any:
        """Execute one conversation turn; return a TurnResult."""
        from _errors import ProviderRuntimeError  # noqa: PLC0415

        try:
            from _contract import ProviderError, TurnResult  # noqa: PLC0415
        except ImportError:
            from scripts.framework.providers._contract import ProviderError, TurnResult  # noqa: PLC0415

        if session.closed:
            raise ProviderRuntimeError(
                code="sdk_error",
                message="turn() called on a closed session",
            )

        session.extractor.start_turn()

        try:
            session.conversation.send_message(message)
            session.conversation.run()
        except TimeoutError as exc:
            result = session.extractor.end_turn()
            return TurnResult(
                text=result.text,
                tool_calls=result.tool_calls,
                error=ProviderError(
                    code="LLM_TIMEOUT",
                    message=f"SDK run() timed out: {exc}",
                    retryable=True,
                ),
            )
        except Exception as exc:
            _log.error("turn failed: %s", exc)
            result = session.extractor.end_turn()
            return TurnResult(
                text=result.text,
                tool_calls=result.tool_calls,
                error=ProviderError(
                    code="sdk_error",
                    message=str(exc),
                    retryable=False,
                ),
            )

        result = session.extractor.end_turn()
        session.turns_completed += 1
        session.all_tool_calls.extend(result.tool_calls)
        return result

    def finalize(self, session: _Session) -> Any:
        """Summarize the session after all turns complete."""
        try:
            from _contract import FinalResult  # noqa: PLC0415
        except ImportError:
            from scripts.framework.providers._contract import FinalResult  # noqa: PLC0415

        n_turns = session.turns_completed
        n_tools = len(session.all_tool_calls)

        # Cost / token extraction (spike A.0 row #6).
        # ConversationStats.usage_to_metrics[model].accumulated_cost available
        # after run() but requires knowing the model key; defer to v1.1+.
        cost_usd = 0.0
        tokens: dict[str, int] = {"input": 0, "output": 0}

        try:
            stats = getattr(session.conversation, "conversation_stats", None)
            if stats and hasattr(stats, "usage_to_metrics"):
                for metrics in stats.usage_to_metrics.values():
                    cost_usd += getattr(metrics, "accumulated_cost", 0.0) or 0.0
        except Exception:
            pass  # best-effort; never crash finalize

        summary = f"{n_turns} turn(s), {n_tools} tool call(s)"

        return FinalResult(
            final_text="",
            turns_completed=n_turns,
            tool_calls=session.all_tool_calls,
            metadata={
                "cost_usd": cost_usd,
                "tokens": tokens,
                "transcript_summary": summary,
            },
        )

    def shutdown(self, session: _Session) -> None:
        """Tear down the session.  Idempotent (spike A.0 row #7)."""
        if session.closed:
            return
        try:
            session.conversation.close()
        except Exception as exc:
            _log.warning("conversation.close() raised (ignored): %s", exc)
        finally:
            session.closed = True


# ---------------------------------------------------------------------------
# Public factory — imported by _python_adapter via _PROVIDER_REGISTRY
# ---------------------------------------------------------------------------


def create() -> OpenHandsSDKProvider:
    """Return an SDKProvider instance for openhands_sdk."""
    return OpenHandsSDKProvider()
