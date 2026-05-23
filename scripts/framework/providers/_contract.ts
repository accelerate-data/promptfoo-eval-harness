/**
 * Provider contract types for promptfoo-eval-harness (spec §1.2).
 *
 * This file is the TypeScript mirror of scripts/framework/providers/_contract.py.
 * Both files are hand-maintained and kept in sync via the parity table in
 * docs/provider-contract.md. The parity test scripts/framework/providers/_contract.test.js
 * enforces every row in that table.
 *
 * Session type note (spike A.0 discrepancy row #1):
 *   The bridge treats sessions opaquely — it receives a session from init() and
 *   passes it to turn/finalize/shutdown without inspecting it. Session = unknown
 *   captures that the Node bridge has no SDK-specific type information.
 *
 * TurnResult note (spike A.0 discrepancy row #4):
 *   TurnResult is an adapter-internal type, not an SDK type. The adapter assembles
 *   it from SDK events; the Node bridge reads it from the NDJSON turn_ok response.
 */

/**
 * Configuration passed from the Node bridge to provider implementations.
 * Transmitted as the `config` field of the NDJSON `init` request.
 */
export interface ProviderConfig {
  /** "openhands_sdk" | "opencode_cli" | ... */
  provider_kind: string;
  /** litellm slug: "anthropic/claude-sonnet-4-6" */
  model: string;
  /** from config/sdk-pins.toml at runtime */
  sdk_version: string;
  /** absolute path to per-case tmpdir */
  workspace_root: string;
  /** tool names from this provider's registry */
  tools: string[];
  /** see spec §1.6 */
  permissions: Record<string, unknown>;
  /** default 300, from tier config */
  timeout_per_turn_s: number;
  /** human-readable label, e.g. "oh-sonnet" */
  provider_label: string;
  /** provider-specific extras */
  extra: Record<string, unknown>;
}

/**
 * Record of a single tool invocation within a turn.
 */
export interface ToolCallRecord {
  /** tool registry name */
  name: string;
  /** serialized call arguments */
  arguments: Record<string, unknown>;
  /** <= 1 KB, redacted per §7.1 */
  result_truncated: string;
  error?: string;
}

/**
 * Structured error crossing the IPC boundary.
 * message is SANITIZED — no secrets, no full paths.
 */
export interface ProviderError {
  /** timeout | rate_limit | auth | sdk_error | tool_error | workspace_error | validation */
  code: string;
  /** SANITIZED — no secrets, no full paths */
  message: string;
  retryable: boolean;
}

/**
 * Adapter-internal result for a single turn.
 * Assembled from SDK events (not returned by SDK directly — see spike A.0 row #4).
 * Transmitted as the `result` field of the NDJSON `turn_ok` response.
 */
export interface TurnResult {
  /** final assistant message this turn */
  text: string;
  tool_calls: ToolCallRecord[];
  error?: ProviderError;
  // raw_events NOT included — opt-in via AD_EVALS_CAPTURE_RAW_EVENTS=1
}

/**
 * Result returned by finalize(), summarizing the entire session.
 * Transmitted as the `result` field of the NDJSON `final` response.
 */
export interface FinalResult {
  final_text: string;
  /** canonical name per spec §1.2 (NOT "turns") */
  turns_completed: number;
  tool_calls: ToolCallRecord[];
  /** see spec §1.5 */
  metadata: Record<string, unknown>;
}

/**
 * Session is opaque from the Node bridge perspective.
 * Concrete types: LocalConversation (OpenHands SDK), RemoteConversation (future),
 * OpenCodeSessionHandle (Phase 3, future).
 * The bridge receives a session token from init_ok and passes it through; it
 * never inspects the session object directly (the Python subprocess owns it).
 */
export type Session = unknown;

/**
 * Interface that every SDK-backed provider module must satisfy.
 * See spec §1.1 for the language-neutral 4-method contract shape.
 *
 * OpenHands turn() note (spike A.0 discrepancy row #3):
 *   The concrete implementation calls session.send_message(message) then
 *   session.run() (blocking) and assembles TurnResult from captured events.
 */
export interface SDKProvider {
  /** Construct and return a new session. May throw ProviderError on bad config. */
  init(cfg: ProviderConfig): Session | Promise<Session>;

  /**
   * Execute one conversation turn.
   * Returns TurnResult assembled from SDK events.
   */
  turn(session: Session, message: string): TurnResult | Promise<TurnResult>;

  /**
   * Summarize session after all turns complete.
   * Must not be called after shutdown.
   */
  finalize(session: Session): FinalResult | Promise<FinalResult>;

  /**
   * Tear down the session. Must be idempotent (second call is a no-op).
   * Maps to session.close() for OpenHands SDK.
   * Set delete_on_close=False at construction so the Node bridge owns
   * workspace cleanup per spec §7.3.
   */
  shutdown(session: Session): void | Promise<void>;
}
