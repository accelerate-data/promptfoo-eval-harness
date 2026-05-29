"""
Provider contract types for promptfoo-eval-harness (spec §1.2).

These dataclasses are hand-maintained and kept in sync with
scripts/framework/providers/_contract.ts via the parity table in
docs/provider-contract.md. The parity test scripts/framework/providers/_contract.test.js
enforces every row in that table.

Session type note (spike A.0 discrepancy row #1):
  The spec originally defined Session as an opaque Protocol. The OpenHands SDK
  has no such Protocol — LocalConversation (returned by the Conversation() factory)
  IS the session container. For the contract module we define Session as a forward-
  reference Union so the type is documentable without importing SDK types at contract
  load time. Provider implementations annotate their own session arguments with the
  concrete SDK type (e.g. LocalConversation).

TurnResult note (spike A.0 discrepancy row #4):
  TurnResult is an adapter-internal dataclass, not an SDK type. The OpenHands SDK
  does not return a TurnResult directly — the adapter assembles it from MessageEvent
  and ActionEvent objects captured via Conversation callbacks. See spec §2.6.

SDKProvider.turn() note (spike A.0 discrepancy row #3):
  The Protocol documents the adapter-visible turn() signature. The OpenHands
  implementation internally calls session.send_message(message) followed by
  session.run() (blocking) and assembles TurnResult from events. The Protocol
  abstracts that implementation detail.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, Union

# Session is a forward-reference union alias. Concrete session containers:
#   LocalConversation  — OpenHands SDK (local workspace)
#   RemoteConversation — OpenHands SDK (remote workspace, future)
#   OpenCodeSessionHandle — OpenCode SDK adapter (Phase 3, future)
# Provider implementations annotate with the concrete type; the bridge
# treats sessions opaquely (passes them from init() through to turn/finalize/shutdown).
Session = Union[Any, None]  # forward-ref: LocalConversation | RemoteConversation | OpenCodeSessionHandle


@dataclass
class ProviderConfig:
    """Configuration passed from the Node bridge to the Python adapter via NDJSON init."""

    provider_kind: str  # "openhands_sdk" | "opencode_cli" | ...
    model: str  # litellm slug: "anthropic/claude-sonnet-4-6"
    sdk_version: str  # from config/sdk-pins.toml at runtime
    workspace_root: str  # absolute path to per-case tmpdir
    tools: list[str]  # tool names from this provider's registry
    permissions: dict[str, Any]  # see spec §1.6
    timeout_per_turn_s: int  # default 300, from tier config
    provider_label: str = ""  # human-readable label (e.g. "oh-sonnet")
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a plain dict suitable for NDJSON emission."""
        return {
            "provider_kind": self.provider_kind,
            "model": self.model,
            "sdk_version": self.sdk_version,
            "workspace_root": self.workspace_root,
            "tools": self.tools,
            "permissions": self.permissions,
            "timeout_per_turn_s": self.timeout_per_turn_s,
            "provider_label": self.provider_label,
            "extra": self.extra,
        }


@dataclass
class ToolCallRecord:
    """Record of a single tool invocation within a turn."""

    name: str  # tool registry name
    arguments: dict[str, Any]  # serialized call arguments
    result_truncated: str  # <= 1 KB, redacted per §7.1
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "name": self.name,
            "arguments": self.arguments,
            "result_truncated": self.result_truncated,
        }
        if self.error is not None:
            d["error"] = self.error
        return d


@dataclass
class ProviderError:
    """Structured error crossing the IPC boundary. Message is SANITIZED (no secrets, no full paths)."""

    code: str  # taxonomy: timeout | rate_limit | auth | sdk_error | tool_error | workspace_error | validation
    message: str  # SANITIZED — no secrets, no full paths
    retryable: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }


@dataclass
class TurnResult:
    """Adapter-internal result for a single turn. Assembled from SDK events, not returned by SDK directly."""

    text: str  # final assistant message this turn
    tool_calls: list[ToolCallRecord]
    error: Optional[ProviderError] = None
    # raw_events NOT included — opt-in via AD_EVALS_CAPTURE_RAW_EVENTS=1 (written to artifact dir)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "text": self.text,
            "tool_calls": [tc.to_dict() for tc in self.tool_calls],
        }
        if self.error is not None:
            d["error"] = self.error.to_dict()
        return d


@dataclass
class FinalResult:
    """Result returned by finalize(), summarizing the entire session."""

    final_text: str
    turns_completed: int  # canonical name per spec §1.2 (NOT "turns")
    tool_calls: list[ToolCallRecord]
    metadata: dict[str, Any]  # see spec §1.5

    def to_dict(self) -> dict[str, Any]:
        return {
            "final_text": self.final_text,
            "turns_completed": self.turns_completed,
            "tool_calls": [tc.to_dict() for tc in self.tool_calls],
            "metadata": self.metadata,
        }


class SDKProvider(Protocol):
    """
    Protocol that every SDK-backed provider must implement.

    Lifecycle (see spec §1.4 for invariants):
      init  → returns the session object (LocalConversation for OpenHands SDK)
      turn  → called once per scripted turn; returns TurnResult
      finalize → called after all turns; returns FinalResult
      shutdown → teardown; must be idempotent (second call is a no-op)

    OpenHands turn() implementation note (spike A.0 discrepancy row #3):
      The Protocol defines turn(session, message) -> TurnResult.
      The concrete implementation calls session.send_message(message) then
      session.run() (blocking), and assembles TurnResult from captured events.
    """

    def init(self, cfg: ProviderConfig) -> Session:
        """Construct and return a new session. May raise ProviderError on bad config."""
        ...

    def turn(self, session: Session, message: str) -> TurnResult:
        """Execute one conversation turn. Returns TurnResult (adapter-assembled from events)."""
        ...

    def finalize(self, session: Session) -> FinalResult:
        """Summarize session after all turns complete. Must not be called after shutdown."""
        ...

    def shutdown(self, session: Session) -> None:
        """
        Tear down the session. Maps to session.close() for OpenHands SDK.
        Set delete_on_close=False at construction so the Node bridge owns
        workspace cleanup per spec §7.3.
        Must be idempotent.
        """
        ...
