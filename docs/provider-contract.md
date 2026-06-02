# Provider Contract

> Spec: [`plans/260522-1649-harness-plugin-contract-design/spec.md`](../plans/260522-1649-harness-plugin-contract-design/spec.md) §1.2
> Parity enforced by: [`scripts/framework/providers/_contract.test.js`](../scripts/framework/providers/_contract.test.js)

## Rationale

The provider contract types are **hand-written** in both Python and TypeScript rather
than generated from a shared schema. Reasons:

1. No shared schema generator is needed for two languages and one stable contract shape.
2. The parity table below + the parity test provide equivalent safety with far less machinery.
3. A YAML/JSON-schema generator is deferred to Phase 4+ when ≥3 SDK providers exist.

The two contract files are kept in sync via this document. Every field that appears in
`_contract.py` must appear in `_contract.ts` and in the parity table below.
`_contract.test.js` reads both source files and this table at test time and fails the
build if any row is missing from either file.

## Parity Table

Each row maps one field across Python and TypeScript. The test file enforces this table.

<!-- parity-table-start -->
| Type | Field | Python type | TS type | Source spec § |
| --- | --- | --- | --- | --- |
| ProviderConfig | provider_kind | str | string | §1.2 |
| ProviderConfig | model | str | string | §1.2 |
| ProviderConfig | sdk_version | str | string | §1.2 |
| ProviderConfig | workspace_root | str | string | §1.2 |
| ProviderConfig | tools | list[str] | string[] | §1.2 |
| ProviderConfig | permissions | dict | Record<string, unknown> | §1.2, §1.6 |
| ProviderConfig | timeout_per_turn_s | int | number | §1.2 |
| ProviderConfig | provider_label | str | string | §1.2, §1.5 |
| ProviderConfig | extra | dict[str, Any] | Record<string, unknown> | §1.2 |
| ToolCallRecord | name | str | string | §1.2 |
| ToolCallRecord | arguments | dict | Record<string, unknown> | §1.2 |
| ToolCallRecord | result_truncated | str | string | §1.2 |
| ToolCallRecord | error | Optional[str] | string? | §1.2 |
| ProviderError | code | str | string | §1.2, §1.3 |
| ProviderError | message | str | string | §1.2, §1.3 |
| ProviderError | retryable | bool | boolean | §1.2, §1.3 |
| TurnResult | text | str | string | §1.2 |
| TurnResult | tool_calls | list[ToolCallRecord] | ToolCallRecord[] | §1.2 |
| TurnResult | error | Optional[ProviderError] | ProviderError? | §1.2 |
| FinalResult | final_text | str | string | §1.2 |
| FinalResult | turns_completed | int | number | §1.2 |
| FinalResult | tool_calls | list[ToolCallRecord] | ToolCallRecord[] | §1.2 |
| FinalResult | metadata | dict | Record<string, unknown> | §1.2, §1.5 |
<!-- parity-table-end -->

## Type Notes

- **Session**: Not a dataclass field — it is a type alias. Python: `Session = Union[Any, None]`
  (forward-ref for `LocalConversation | RemoteConversation | OpenCodeSessionHandle`).
  TypeScript: `type Session = unknown`. The bridge treats sessions opaquely.
  See spike A.0 discrepancy row #1 for rationale.
- **TurnResult** is adapter-internal — assembled from SDK events, not returned by the SDK
  directly. See spike A.0 discrepancy row #4.
- **ProviderError.message** is always sanitized before crossing the IPC boundary (no secrets,
  no full paths). See spec §7.1.
- **ToolCallRecord.result_truncated** is capped at 1 KB and redacted per spec §7.1.

## SDKProvider Protocol / Interface

Both files define the 4-method contract (spec §1.1):

| Method | Python | TypeScript |
| --- | --- | --- |
| init | `def init(self, cfg: ProviderConfig) -> Session` | `init(cfg: ProviderConfig): Session \| Promise<Session>` |
| turn | `def turn(self, session: Session, message: str) -> TurnResult` | `turn(session: Session, message: string): TurnResult \| Promise<TurnResult>` |
| finalize | `def finalize(self, session: Session) -> FinalResult` | `finalize(session: Session): FinalResult \| Promise<FinalResult>` |
| shutdown | `def shutdown(self, session: Session) -> None` | `shutdown(session: Session): void \| Promise<void>` |

---

## IPC Wire Format

The Node bridge (`scripts/framework/_node_bridge.js`) communicates with the Python
adapter (`scripts/framework/providers/_python_adapter.py`) over the subprocess's
stdio using **Newline-Delimited JSON (NDJSON)** per spec §2.3.

**Framing rules:**

- One JSON object per line, terminated by `\n` (never `\r\n`).
- Each message is a complete JSON object — no multi-line payloads.
- Logging goes to **stderr only** — stdout carries IPC messages exclusively.

### Request message types (bridge → adapter)

| Type | Required fields | Optional fields | Description |
| --- | --- | --- | --- |
| `init` | `id`, `config` | — | Open a new session. `config` is a `ProviderConfig` object (see parity table). |
| `turn` | `id`, `session_id`, `message` | — | Run one conversation turn in an existing session. |
| `finalize` | `id`, `session_id` | — | Close the session and return summary metadata. |
| `shutdown` | `id`, `session_id` | — | Shut down the adapter cleanly. Process exits 0 after emitting `shutdown_ack`. |

All request messages carry an `id` string that the adapter echoes in its response,
enabling the bridge to correlate concurrent requests. The `id` is opaque — the
bridge uses values like `"bridge-init"`, `"bridge-turn-0"`, `"bridge-final"`,
`"bridge-shutdown"`.

### Response message types (adapter → bridge)

| Type | Required fields | Optional fields | Description |
| --- | --- | --- | --- |
| `init_ack` | `id`, `session_id` | — | Session opened successfully. `session_id` is the opaque handle for subsequent messages. |
| `turn_ack` | `id`, `text`, `tool_calls`, `error`, `raw` | — | Turn completed. `error` is `null` on success or a `ProviderError` dict on failure (see §error field). Subprocess stays alive either way. |
| `finalize_ack` | `id`, `cost_usd`, `tokens`, `transcript_summary` | — | Session finalized. |
| `shutdown_ack` | `id` | — | Adapter has shut down all sessions and will exit 0. |
| `error` | `id`, `error` | — | Fatal adapter-level error (e.g., `UNSUPPORTED_KIND` at startup, `BAD_INPUT` from malformed JSON). The `error` field is a `ProviderError` dict. See §Error Envelopes. |

**The `error` field in `turn_ack`** (see also the `ProviderError` row in the parity
table above): when a turn fails without killing the subprocess (e.g., `UNKNOWN_SESSION`,
an exception inside `provider.turn()`), the adapter emits a `turn_ack` with
`error: { code, message, retryable }` populated and the subprocess continues
accepting requests. This is distinct from a top-level `error` message which signals
a fatal condition.

---

## Error Envelopes

Every error the bridge surfaces to Promptfoo carries a `{ code, message, retryable }`
object. The codes below are the canonical set for Phase 1:

| Code | Raised by | `retryable` | Semantics |
| --- | --- | --- | --- |
| `UNSUPPORTED_KIND` | Bridge or adapter | `false` | `provider_kind` not in `KIND_REGISTRY` (bridge) or `_PROVIDER_REGISTRY` (adapter). |
| `BAD_CONFIG` | Bridge | `false` | Constructor config missing required field (`provider_kind`) or not an object. |
| `BAD_INPUT` | Adapter | `false` | Malformed JSON line received on stdin, or `init.config` is not a JSON object. |
| `SUBPROCESS_CRASH` | Bridge | `true` | Subprocess stdout closed unexpectedly, or subprocess emitted non-parseable NDJSON. |
| `SUBPROCESS_TIMEOUT` | Bridge | `true` | IPC round-trip exceeded its bound, or a `SIGTERM`/`SIGKILL` sequence was used. The `init` handshake is bounded by `AD_EVALS_INIT_TIMEOUT_MS` (default 600 s) because cold starts pay one-time costs (uv environment resolution, SDK import, model warm-up); every subsequent per-turn and `finalize` round-trip is bounded by `AD_EVALS_SUBPROCESS_TIMEOUT_MS` (default 120 s). The init bound is floored at the per-turn bound, so it can never be tighter. |
| `UNKNOWN_SESSION` | Adapter | `false` | `session_id` in a `turn` or `finalize` request does not match any open session. Returned in `turn_ack.error`, not as a top-level `error`, so the subprocess stays alive. |

All error messages are sanitized before crossing the IPC boundary (no secrets, no full
paths). Full redaction patterns land in Phase 7; Phase 1 uses a placeholder redactor.

---

## Subprocess Lifecycle

The adapter process follows a strict 4-message sequence per case:

```text
[bridge]                         [adapter subprocess]
  spawn uv … _python_adapter.py
  ──── {"type":"init", …} ──────►  _handle_init() → {"type":"init_ack", "session_id":"…"}
  ◄──── {"type":"init_ack"} ──────

  ──── {"type":"turn", …} ──────►  _handle_turn() → {"type":"turn_ack", …}
  ◄──── {"type":"turn_ack"} ──────
          (repeat N times)

  ──── {"type":"finalize", …} ──►  _handle_finalize() → {"type":"finalize_ack", …}
  ◄──── {"type":"finalize_ack"} ──

  ──── {"type":"shutdown", …} ──►  _handle_shutdown() → {"type":"shutdown_ack"} → exit 0
  ◄──── {"type":"shutdown_ack"} ──
  bridge closes stdin
                                    process exits 0
```

Lifecycle invariants (spec §1.4):

- `init` may emit `error` on bad config — adapter does NOT call `shutdown` (no session exists yet).
- `shutdown` is sent by the bridge in a `finally` block — always executed even if turns fail.
- `shutdown` is idempotent: a second call is a no-op (adapter ignores unknown session IDs).
- If the subprocess exits before `shutdown_ack`, the bridge performs `SIGTERM → 5 s grace → SIGKILL`.
