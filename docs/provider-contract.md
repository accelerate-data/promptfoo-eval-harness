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
