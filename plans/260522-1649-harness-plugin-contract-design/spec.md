# Harness Plugin Contract + Multi-SDK Provider Design (v1.0.0)

> Date: 2026-05-22
> Author: Brainstorming session (duy.nguyen@acceleratedata.ai + Claude)
> Status: Draft v8 (post-codex review pass 7 rework)
> Linear: VD-XXXX (to be created)
> Scope: Refactor `@accelerate-data/promptfoo-eval-harness` to add a plugin
> contract supporting multiple SDK providers, with multi-turn + parallelism,
> while **preserving the existing OpenCode CLI provider** as the production
> flow for data-engineering. Ship as `v1.0.0`.

> **CHANGES from v7 (codex review pass 7 fixes — 1 finding)**:
> 1. **§2.6 `opencode_cli` validation no longer routes `undefined` into
>    `provider.callApi`.** v7 added `length === 0` guard but missed the
>    `[undefined]` fallback (when `vars.turns: []` AND `prompt` is
>    undefined → `[prompt]` = `[undefined]`, length 1). Both branches now
>    use `noUsableTurn = length === 0 || (length === 1 && (turns[0] is
>    undefined/null/empty))`. (§2.6)
>
> **CHANGES from v6 (codex review pass 6 fixes — 2 findings)**:
> 1. **§2.6 empty `vars.turns: []` no longer falls through.** Empty arrays
>    are truthy in JS (`[] || X === []`), so v6's `||` fallback let
>    `opencode_cli` route an empty array into `provider.callApi(undefined)`.
>    Both branches now use the same precedence helper: `hasTurns =
>    Array.isArray(turns) && turns.length > 0`, then either fall back to
>    `[prompt]` or return a `validation` error if neither source is
>    populated. Matches §3.2 precedence rules exactly. (§2.6)
> 2. **§2.5 benchmark ownership clarified.** §2.5 now says cold-spawn is
>    Step A.7 (was wrongly "Step A.0 benchmark"), and lists both
>    `bench/spawn-cost.js` (Step A.7 — required gating, cold-spawn cost)
>    and `bench/parallel-throughput/` (optional parallelism harness moved
>    from L4 scenarios) as distinct artifacts. (§2.5 + §A.1 + §9.2)
>
> **CHANGES from v5 (codex review pass 5 fixes — 7 findings)**:
> 1. **§2.6 transcript invariant now actually holds on EVERY error path.**
>    `opencode_cli` multi-turn rejection appends one entry per attempted
>    turn (with `error` marker); `opencode_cli` caught exception appends
>    the attempted turn; SDK validation path treats empty `turns` as
>    "no attempted turns" (0 entries — correct), and SDK mid-turn
>    exceptions track `attemptedIndex`/`attemptedInput`/`attemptedStart`
>    so the in-flight turn is appended in the `catch` block before
>    `errorReturn`. New `pushTurn` + `normalizeErr` helpers consolidate
>    the contract. (§2.6)
> 2. **§9.7 success criteria gates both spikes.** Added explicit
>    `Step A.0.B spike passes (gating)` checklist row. Sub-issue count
>    bumped 8 → 9. (§9.7)
> 3. **§9.3 sub-issue table adds VD-XXXX-1B for Spike A.0.B.** Foundation
>    + IPC (`-2`) now depends on BOTH `-1` AND `-1B`. (§9.3)
> 4. **§3.2.1 transcript schema aligned to §2.6.** Per-turn entry shape
>    is now `{turn_index, input, output, latency_ms, tool_calls, error?}`
>    — one entry per attempted turn; `error` field present iff that
>    turn failed. (§3.2.1)
> 5. **`_node_bridge.js` path fully canonicalized.** Remaining shorthand
>    in §9.2 B.9, §9.4 v3-note, §A.2, the header CHANGES block (v3
>    bullet), and the v2/v3 Appendix D rows all use
>    `file://scripts/framework/_node_bridge.js`. (§9.2, §9.4, §A.2,
>    header CHANGES, Appendix D)
> 6. **§A.1 lists both benchmark files distinctly.** `bench/spawn-cost.js`
>    (Step A.7 — cold-spawn / per-turn cost) and `bench/parallel-throughput/`
>    (parallelism harness folder moved from L4) are now both itemized so
>    the §2.5 vs §A.1 conflict is resolved. (§A.1)
> 7. **§8.2 orphan test file renamed.** `scripts/framework/workspace-guard.test.js`
>    → `scripts/framework/_node_bridge.workspace.test.js` to match
>    §7.3 / §9.2 E.24 / §A.1. (§8.2)
> 8. **Footer says v5 → v6.** (NIT)
>
> **CHANGES from v4 (codex review pass 4 fixes — 6 findings)**:
> 1. **§2.6 every return path uses `baseMetadata`.** opencode_cli branch
>    (multi-turn-rejection + happy path + caught exception) now wraps
>    metadata; SDK branch catches spawn/IPC/init exceptions via new
>    `errorReturn(...)` helper so canonical fields appear on all
>    failures, not just per-turn error responses. (§2.6)
> 2. **Transcript records every attempted turn.** The erroring turn is
>    appended unconditionally (even with empty output) and carries an
>    `error` marker so `metadata.transcript[i]` is never missing.
>    (§2.6)
> 3. **§9.4 lists both gating spikes.** A.0 (OpenHands SDK shape) +
>    A.0.B (Promptfoo `file://` option-shape). They may run in
>    parallel; both must pass before A.5. (§9.4)
> 4. **`_node_bridge.js` path canonicalized to `scripts/framework/_node_bridge.js`.**
>    Header CHANGES + §4.3 corrected; all other refs already matched.
>    (§2.2, §2.6, §4.3, §9.2, §A.1)
> 5. **`parallel-throughput` benchmark placement aligned.** §2.5 now
>    says `bench/parallel-throughput/` (matches §5.1 cut list).
>    Removed conflicting `tests/harness-scenarios/packages/...` path.
>    (§2.5)
> 6. **Appendix C "Workspace guard" entry rewritten.** Now states it is
>    NOT a standalone Phase 1 module; the assertion is one branch
>    inside `run-promptfoo-with-guard.js` (matches §7.3 + §9.2 E.24);
>    dedicated `workspace-guard.js` deferred to Phase 1.x. Ownership
>    stays with the cleanup-guard module. (Appendix C)
> 7. **Footer says v4 → v5.** (NIT)
>
> **CHANGES from v3 (codex review pass 3 fixes — 11 findings)**:
> 1. **Scenario inventory aligned to 3 across all sections.** §0.1 Goal 6,
>    §8.1 L4 row, §9.1 Phase 1, §9.11, Appendix D row, and header CHANGES
>    count now all agree. `workspace-cleanup-guard` + migration smoke
>    references removed. (§0.1, §8.1, §9.1, §9.11, Appendix D)
> 2. **SDK extras single-sourced.** `sdk-pins.toml` declares
>    `extras = []`; A.0 spike confirms; every `uv run --with` invocation
>    must follow this single source. (§6.4)
> 3. **CI Python matrix fixed.** `['3.10', '3.12']` → `['3.12', '3.13']`
>    to match OpenHands `>=3.12` requirement. (§8.6)
> 4. **KEEP_WORKSPACE skip semantics.** `AD_EVALS_KEEP_WORKSPACE=1`
>    skips both bridge cleanup AND post-run guard assertion, logs
>    warning. (§7.3)
> 5. **`metadata.transcript` is built.** Every turn pushes
>    `{turn_index, input, output, latency_ms, tool_calls}` onto a
>    transcript array, returned in both success and error paths. (§2.6)
> 6. **Canonical metadata on every return path.** New `baseMetadata(cfg,
>    extra)` helper wires `provider_kind`, `provider_label`, `model`,
>    `sdk_version`, `adapter_version`, `run_id`, `case_id`,
>    `latency_ms_per_turn`, `latency_ms_total` into success AND error
>    returns. (§2.6, §1.5)
> 7. **Bridge registry name corrected.** Registry is `KIND_REGISTRY` in
>    `scripts/framework/_node_bridge.js` (no separate `_dispatch.{py,ts}`).
>    (§4.3)
> 8. **Directory-run step pinned.** §5.3 implementation lives in §9.2
>    Step G.28 (was inconsistently called G.31). (§5.3)
> 9. **Promptfoo file-provider option-shape spike added.** New §9.2 Step
>    A.0.B verifies `options.config.*` shape gates A.5 and all later
>    work. (§2.2 callout, §9.2)
> 10. **`validate-package-config.js` numbering fixed.** Lives in §9.2
>    Step B.11 (header CHANGES + Appendix D rows aligned). (§9.2)
>
> **CHANGES from v2 (codex review pass 2 fixes)**:
> 1. **Promptfoo `exec:` does NOT host a persistent NDJSON loop.**
>    Dispatch table rewritten: ALL `provider_kind` values map to a single
>    `file://scripts/framework/_node_bridge.js` URL. The bridge is the only Promptfoo
>    provider face; it routes by `provider_kind` and spawns persistent
>    subprocesses for SDK-backed kinds. (§2.2, §2.3, §2.6, §4.2)
> 2. **OpenHands SDK pin corrected.** Latest PyPI is `1.22.1`, requires
>    Python `>=3.12`. v1.0.0 pins `openhands-sdk==1.22.1`, Python
>    `>=3.12,<3.14`. (§6.3, §6.4, §6.7)
> 3. **Workspace guard simplified.** The "file ends up outside" wording
>    was incoherent. Replaced with: subprocess CWD = workspace,
>    adapter `finally` removes the workspace dir, existing cleanup-guard
>    verifies `tests/evals/.tmp/workspaces/<run_id>/` is empty post-run.
>    Dedicated `workspace-guard.js` and its L4 scenario deferred to
>    Phase 1.x. (§5.1, §5.2, §7.3, §9.2 Step E)
> 4. **`ad-evals run <package-root>` is a behavior change.** Added
>    explicit step to extend the CLI to accept a directory (scans nested
>    `promptfooconfig.json` files and runs each). (§5.3, §9.2 Step G)
> 5. **Multi-turn assertion semantics defined.** Bridge concatenates per-
>    turn outputs into `output` field (joined with `\n---\n`). Last turn
>    is also exposed as `metadata.final_turn_output`. (§3.2)
> 6. **Env allowlist source defined.** Allowlist is per-provider_kind in
>    `config/sdk-pins.toml`; redaction covers `*_API_KEY`, `*_TOKEN`,
>    `*_SECRET`, `*_PASSWORD`, `*_COOKIE`, `*_SESSION`. (§7.1)
> 7. **uv runtime risk mitigated.** New `ad-evals doctor --install-providers`
>    pre-warms uv cache. `AD_EVALS_OFFLINE=1` fails fast if cache cold.
>    (§6.3, §9.2 Step G, §9.8)
> 8. **Spike order corrected.** Promptfoo `exec:` spike removed (no longer
>    applicable — bridge uses `file://`). Only spike now is OpenHands SDK
>    shape (A.0). (§9.2, §9.4)
> 9. **Appendix D audit trail corrected** for the `validate-package-config.js`
>    row (it is created in §9.2 Step B.11; §A.1 lists it as a new file).
>    New v3 rows appended.

> **CHANGES from v1 (codex review pass 1 fixes — preserved for audit)**:
> removed false cleanup inventory (main has no OpenHands/HITL files; those
> live on the unmerged `feature/vd-2119` branch and are out of scope).
> Reframed Phase 1 to ship OpenCode CLI compatibility + OpenHands SDK only
> (Goals 1+2). Added IPC, Python packaging, observability, secrets,
> workspace lifecycle, and tool-permission sections. Fixed `call_api()`
> bugs. Separated Node and Python adapters. Deferred `--compare`,
> `sdk-version-canary`, contract YAML generation, and 7 of 10 scenarios
> to Phase 2+ (final v3 inventory: 3 packages — see §5.1).

---

## Section 0 — Goals, Non-goals, Constraints

### 0.1 Goals (Phase 1, v1.0.0)

1. **Plugin contract** — define a single SDK-provider contract that any
   in-process LLM agent SDK can implement, callable from Node via a
   subprocess adapter. Contract is hand-written in both Python and TypeScript
   (no generator); future generator deferred to Phase 4+.
2. **Preserve OpenCode CLI provider** — `opencode-cli-provider.js` is the
   primary production flow for data-engineering. Phase 1 keeps it
   first-class (`provider_kind = "opencode_cli"`) and grows tests around
   its current behavior (env vars, abortSignal, project_dir, retry).
3. **OpenHands SDK provider** — first SDK-backed implementation behind the
   plugin contract. Validates the contract is workable end-to-end.
4. **Multi-turn** — scripted multi-turn via `vars.turns: [string, ...]`.
   Precedence: `vars.turns` > `prompts:` file > single-message default.
5. **Single-axis parallelism in Phase 1** — case-level via Promptfoo
   `--max-concurrency`. Each case runs in its own subprocess (session-level
   isolation falls out of subprocess-per-case). Provider/model fan-out
   (`--compare`) **deferred to Phase 2** when ≥2 SDK providers exist.
6. **In-repo regression scenarios (small, sustainable set)** — **3 scenarios**
   in `tests/harness-scenarios/`: `minimal-smoke` (init/turn/finalize/shutdown
   live-LLM), `opencode-cli-compatibility` (lock current production flow),
   and `openhands-mock-multi-turn` (mock SDK, no live LLM). The earlier
   v2-planned `workspace-cleanup-guard` scenario was dropped in v3 (replaced
   by an L3 integration test — see §5.1, §7.3); the `migration smoke` is
   covered by `scripts/framework/migrate-from-v0.test.js` (L1/L2 fixtures),
   not an L4 scenario.
7. **Reusable as library** — npm-installable, scaffold via
   `eval-harness-init`. Consumer migration via `--migrate-from-v0`.
8. **Boundary enforcement** — CODEOWNERS for review requests + **CI gate**
   for hard enforcement.

### 0.2 Phase 2-4 (out of v1.0.0 scope, sketched only)

- **Phase 2**: Claude Agent SDK provider, `--compare` flag, contract YAML
  generator.
- **Phase 3**: OpenCode SDK provider (in addition to existing OpenCode CLI).
- **Phase 4**: Codex SDK provider, per-provider concurrency caps.

### 0.3 Non-goals (any phase)

- Live Human-in-the-Loop (HITL) revival.
- OpenHands agent-server (HTTP wrapper).
- Generic conversation branching.
- Cross-host distributed execution.
- Per-consumer SDK version override (global pin only).
- Auto-discovery of SDK tools.
- Cost dashboards per provider.
- Backwards compatibility with the unmerged `feature/vd-2119` branch.

### 0.4 Hard Constraints

- **Repo boundary**: harness changes in `promptfoo-eval-harness` only.
  PRs touching harness paths in consumer repos rejected by **CI gate**
  (CODEOWNERS only requests review, does not enforce).
- **No live API keys committed**: `.env.example` only. Live keys read from
  env at runtime. Layer 4 scenarios run on a separate CI workflow with
  workflow-scoped secrets.
- **Adapter language matches SDK language**: Python adapter for Python
  SDKs (OpenHands, Claude Agent). Node adapter for Node/TS SDKs (OpenCode
  SDK, Codex SDK). Provider dispatch chooses adapter by `provider_kind`.
- **Node CLI orchestration only**: `bin/ad-evals.js` stays Node. Python is
  inside the Python adapter subprocess; it never orchestrates.
- **Engineering-framework standards**: Ruff/Black for Python, 70% Python
  coverage, markdown lint MD013 120-char, conventional commits, no `.env`
  commits, gitleaks pre-commit.

### 0.5 Current state of `main` (verified)

`main` has **no OpenHands files, no HITL files, no agent-server code, no
gate-marker code**. The only provider on `main` is
`scripts/framework/opencode-cli-provider.js`. The `feature/vd-2119`
worktree (HITL + agent-server) is **never going to merge** and is out of
scope here. No "cleanup" of those files is needed because they do not
exist on `main`.

What `main` has (framework code):

```text
scripts/framework/
├── environment.js + .test.js
├── eval-tier-config.js
├── index.js
├── opencode-cli-provider.js     <-- preserve as opencode_cli provider_kind
├── package-discovery.js + .test.js
├── paths.js + .test.js
├── resolve-promptfoo-config.js
├── roots.js
└── run-promptfoo-with-guard.js
```

---

## Section 1 — Provider Contract

The contract is implemented in two flavors that share the same shape:

- **Python contract** (`scripts/framework/providers/_contract.py`) — used
  by Python SDKs (OpenHands SDK, Claude Agent SDK).
- **TypeScript contract** (`scripts/framework/providers/_contract.ts`) —
  used by Node/TS SDKs (OpenCode SDK, Codex SDK) and by the existing
  OpenCode CLI provider.

Both files are **hand-maintained**, kept in sync via a markdown table in
`docs/provider-contract.md` and Layer 2 contract tests per language. A
shared YAML generator is deferred to Phase 4+.

### 1.1 The 4-method contract (shape, language-neutral)

```text
init(config: ProviderConfig) -> Session
turn(session: Session, message: str) -> TurnResult
finalize(session: Session) -> FinalResult
shutdown(session: Session) -> None
```

### 1.2 Python contract types

```python
# scripts/framework/providers/_contract.py
from typing import Protocol, Any, Optional
from dataclasses import dataclass, field

@dataclass
class ProviderConfig:
    provider_kind: str          # "openhands_sdk" | "opencode_cli" | ...
    model: str                  # litellm slug: "anthropic/claude-sonnet-4-6"
    sdk_version: str            # from config/sdk-pins.toml at runtime
    workspace_root: str         # absolute path to per-case tmpdir
    tools: list[str]            # tool names from this provider's registry
    permissions: dict           # see Section 1.6
    timeout_per_turn_s: int     # default 300, from tier config
    extra: dict[str, Any] = field(default_factory=dict)

@dataclass
class ToolCallRecord:
    name: str                   # tool registry name
    arguments: dict             # serialized
    result_truncated: str       # ≤ 1KB, redacted
    error: Optional[str] = None

@dataclass
class ProviderError:
    code: str                   # taxonomy below
    message: str                # SANITIZED (no secrets, no full paths)
    retryable: bool
    def to_dict(self) -> dict: ...

@dataclass
class TurnResult:
    text: str                   # final assistant message this turn
    tool_calls: list[ToolCallRecord]
    error: Optional[ProviderError]
    # raw_events NOT in TurnResult — opt-in via AD_EVALS_CAPTURE_RAW_EVENTS=1
    # written to per-run artifact dir, not bundled in Promptfoo result

@dataclass
class FinalResult:
    final_text: str
    turns_completed: int        # canonical name (NOT "turns" — see nit fix)
    tool_calls: list[ToolCallRecord]
    metadata: dict              # see Section 1.5

# Session = LocalConversation (spike A.0 verified).
# Conversation(agent, workspace=...) is a factory that returns LocalConversation
# for local workspaces. Session(Protocol) is removed — no separate opaque Session
# handle exists in the SDK; LocalConversation IS the session container.
# Note: TurnResult is adapter-internal (not an SDK type). Adapter assembles it from
# MessageEvent + ActionEvent objects via Conversation(callbacks=[...]).
from openhands.sdk import Conversation, LocalConversation
Session = LocalConversation  # type alias for adapter annotations

class SDKProvider(Protocol):
    def init(self, cfg: ProviderConfig) -> LocalConversation: ...
    def turn(self, session: LocalConversation, message: str) -> TurnResult: ...
    def finalize(self, session: LocalConversation) -> FinalResult: ...
    def shutdown(self, session: LocalConversation) -> None:
        # Maps to session.close(). Set delete_on_close=False at construction
        # so bridge owns workspace cleanup per §7.3.
        ...
```

### 1.3 Error taxonomy

| `code` | Meaning | `retryable` |
| --- | --- | --- |
| `timeout` | Turn exceeded `timeout_per_turn_s` | True |
| `rate_limit` | Upstream LLM 429 | True |
| `auth` | Upstream LLM 401/403 | False |
| `sdk_error` | SDK threw exception (not classified) | False |
| `tool_error` | Tool registry/exec failure | False |
| `workspace_error` | Workspace setup/cleanup failed | False |
| `validation` | Bad config | False |

### 1.4 Lifecycle invariants

- `init` may raise on bad config — adapter catches, returns error to
  Promptfoo, does NOT call `shutdown` (no session was created).
- `shutdown` is called in adapter `finally` **only when `init` succeeded**.
- `shutdown` must be **idempotent**: second call is a no-op.
- `turn` after `finalize` → `ProviderError("validation", ...)`.

### 1.5 Metadata schema (canonical)

Adapter writes this to Promptfoo's `result.metadata`:

```json
{
  "provider_kind": "openhands_sdk",
  "provider_label": "oh-sonnet",
  "model": "anthropic/claude-sonnet-4-6",
  "sdk_version": "1.22.1",
  "adapter_version": "1.0.0",
  "run_id": "uuid-per-promptfoo-run",
  "case_id": "promptfoo-case-uuid",
  "turns_completed": 3,
  "tool_calls": [{"name": "terminal", "...": "..."}],
  "latency_ms_total": 12340,
  "latency_ms_per_turn": [3200, 4500, 4640],
  "cost_usd": null,
  "provider_error": null
}
```

`cost_usd` is **nullable**. Only populated if the SDK exposes token usage.
Assertions must guard with `metadata.cost_usd != null` before comparing.

### 1.6 Tool permissions model

Each provider declares which tools it supports. Permissions ride alongside
the tool list:

```json
{
  "tools": ["terminal", "file_editor"],
  "permissions": {
    "terminal": {
      "allow": ["ls", "cat", "grep", "rg", "node", "npm test"],
      "deny_network": true,
      "max_runtime_s": 60
    },
    "file_editor": {
      "writable_paths": ["${workspace_root}"],
      "max_file_size_kb": 256
    }
  }
}
```

Defaults defined in `config/eval-tiers.toml` per tier. Provider rejects
permissions it does not understand with `ProviderError("validation", ...)`.

### 1.7 What's NOT in the contract

- LLM API keys (env-only, never in `ProviderConfig`).
- Tool implementations (each provider owns its registry).
- Streaming (Promptfoo doesn't surface intermediate tokens).
- Conversation persistence (each case = fresh session).
- Raw event logs (opt-in artifact, see Section 7 secrets).

---

## Section 2 — Subprocess Adapter & IPC

Promptfoo loads providers by URL string. To call Python from Promptfoo,
the framework emits provider URLs that point at a thin Node bridge,
which **spawns a Python (or Node) subprocess** per case and talks JSON
over stdio.

### 2.1 Why subprocess (not in-process)

- Promptfoo runs cases concurrently via `--max-concurrency` in a single
  Node process. Embedding Python via `child_process` per case gives
  natural session isolation and crash containment.
- "In-process SDK" was misleading wording in v1; clarified: the SDK is
  **in-process inside the subprocess**, not inside the Promptfoo Node
  process. The subprocess is the session boundary.

### 2.2 Provider URL emission

`resolve-promptfoo-config.js` rewrites every tier-config entry to **one
canonical URL**: `file://scripts/framework/_node_bridge.js`. The bridge
is the only Promptfoo provider face — it reads `options.config.provider_kind`
and `options.config.provider_label` at `callApi` time and dispatches.

| `provider_kind` | Bridge dispatch | Subprocess language | Multi-turn |
| --- | --- | --- | --- |
| `opencode_cli` | `require('./opencode-cli-provider.js')` (in-process module call) | — (CLI is spawned by the provider itself, single shot) | Not supported in v1.0.0; `vars.turns` length > 1 → `validation` error |
| `openhands_sdk` | `spawn('uv', ['run', ..., 'python', '_python_adapter.py', 'openhands_sdk'])` | Python | Yes (NDJSON loop) |
| `claude_agent_sdk` (Phase 2) | `spawn('uv', ['run', ..., 'python', '_python_adapter.py', 'claude_agent_sdk'])` | Python | Yes |
| `opencode_sdk` (Phase 3) | `spawn('node', ['_node_adapter.js', 'opencode_sdk'])` | Node | Yes |
| `codex_sdk` (Phase 4) | `spawn('node', ['_node_adapter.js', 'codex_sdk'])` | Node | Yes |

**Why a single bridge URL** (was: per-`provider_kind` URLs):

1. **Promptfoo `exec:` provider does NOT host a persistent stdin loop.**
   Verified by reading `node_modules/promptfoo/dist/src/providers-*.js`:
   `ScriptCompletionProvider` calls `execFile` once per `callApi` and
   passes prompt/options/context as **argv** (then closes stdin). It
   cannot maintain an `init`→`turn[]`→`finalize`→`shutdown` session across
   `callApi` invocations. A persistent NDJSON loop must live inside a
   `file://` JS provider that itself spawns and owns the subprocess.
2. **Single global concurrency cap.** With one provider URL, the bridge
   semaphore wraps every `callApi` — including `opencode_cli` — so
   `--max-concurrency` clamping is uniform regardless of `provider_kind`.

The bridge module exposes a Promptfoo-compatible class with `id()`,
`callApi()`, and (if needed) `cleanup()`. Provider URL takes optional
`config.provider_kind` and `config.provider_label` injected by
`resolve-promptfoo-config.js` from the tier config — Promptfoo passes
these through to the **constructor** as `options.config.*`.

> **Spike A.0.B result (PASS WITH SPEC EDITS).** Promptfoo's `file://`
> provider passes the per-provider `config:` block verbatim (including
> nested objects, arrays, and all types) to the **constructor** as
> `options.config.*`. The `callApi` third argument only carries runtime
> signals: `{ abortSignal }`. The bridge reads config exclusively from
> `this.options.config` (constructor-time). See
> `spike-promptfoo-file-provider-shape.md` for the full discrepancy table.

### 2.3 IPC protocol (JSON over stdio)

Each subprocess reads a single JSON object from stdin and writes a
single JSON object to stdout. Multi-turn sessions reuse the same
subprocess via a request/response loop:

```text
[parent]                          [subprocess]
  spawn process
  send INIT request  ─────────►   init() → respond INIT_OK | INIT_ERR
  for msg in turns:
    send TURN request ─────────►  turn() → respond TURN_OK { text, tool_calls, error }
  send FINALIZE      ─────────►   finalize() → respond FINAL { metadata }
  send SHUTDOWN      ─────────►   shutdown() → respond CLOSED
  parent closes stdin
                                  process exits 0
```

Wire format: one JSON object per line (newline-delimited JSON, NDJSON).

```json
// INIT request
{"type": "init", "config": { ... ProviderConfig ... }}
// INIT_OK response
{"type": "init_ok"}
// TURN request
{"type": "turn", "message": "...", "turn_index": 0}
// TURN_OK response
{"type": "turn_ok", "result": { ...TurnResult... }}
// SHUTDOWN request
{"type": "shutdown"}
// CLOSED response (or just process exit)
{"type": "closed"}
// ERROR response (any phase)
{"type": "error", "error": { ...ProviderError... }}
```

### 2.4 IPC failure modes (must handle)

| Failure | Adapter behavior |
| --- | --- |
| Malformed JSON from subprocess | Kill subprocess, return `sdk_error` |
| Subprocess exits before INIT_OK | Return `sdk_error` with stderr tail (first 2KB, redacted) |
| Subprocess stderr exceeds 64KB | Truncate, append `[stderr truncated]` |
| Turn timeout (`timeout_per_turn_s`) | `SIGTERM`, wait 5s, `SIGKILL`. Return `timeout` |
| Parent process dies (Ctrl-C, SIGTERM) | Subprocess gets SIGTERM via process group, cleans up |
| Subprocess hangs on SHUTDOWN | Wait `shutdown_timeout_s=5`, then `SIGKILL` |

### 2.5 Subprocess startup cost (real measurement, not "plenty")

Cold spawn cost target (must verify in Step A.7 benchmark):

| Adapter | Cold spawn (no SDK import) | With SDK import | Acceptable? |
| --- | --- | --- | --- |
| Python (uv-managed venv) | ~80-150ms | ~400-800ms | Yes if K×M×C ≤ 32 sessions/min |
| Node | ~50-80ms | ~150-300ms | Yes |

Mitigations if measured cost exceeds budget:

- **Pre-warm pool**: spawn N idle subprocesses at CLI startup, hand out
  via a queue. Deferred unless Phase 1 benchmark shows overhead > 20%
  of total wall-clock.
- **Process reuse**: not allowed in Phase 1 (defeats session isolation).
- **Concurrency caps**: per Section 4.4 — global semaphore in adapter.

Two distinct benchmarks (§A.1 lists both):

- **`bench/spawn-cost.js`** — Step A.7 cold-spawn / per-turn cost. Drives
  the table above. Required gating before A-step sign-off.
- **`bench/parallel-throughput/`** — parallelism harness (folder with
  config + driver). Moved out of L4 scenarios (see §5.1 cut list).
  Optional measurement of fan-out behavior; invoked manually only.

Both are throwaway scripts, NOT live-LLM L4 scenarios, and neither runs
in nightly CI.

### 2.6 Adapter implementation pseudo-code

```python
# scripts/framework/providers/_python_adapter.py
import sys, json, importlib, traceback

def main():
    provider_kind = sys.argv[1]
    provider = load_provider(provider_kind)   # importlib by registry
    session = None
    try:
        for line in sys.stdin:
            req = json.loads(line)
            if req["type"] == "init":
                cfg = ProviderConfig(**req["config"])
                session = provider.init(cfg)
                _emit({"type": "init_ok"})
            elif req["type"] == "turn":
                result = provider.turn(session, req["message"])
                _emit({"type": "turn_ok", "result": result.to_dict()})
            elif req["type"] == "shutdown":
                if session is not None:
                    provider.shutdown(session)
                _emit({"type": "closed"})
                return
            elif req["type"] == "finalize":
                final = provider.finalize(session)
                _emit({"type": "final", "result": final.to_dict()})
    except Exception as exc:
        _emit({"type": "error", "error": _sanitize(exc)})
        sys.exit(1)
    finally:
        if session is not None:
            try: provider.shutdown(session)
            except Exception: pass

def _sanitize(exc):
    return {
        "code": getattr(exc, "code", "sdk_error"),
        "message": redact_secrets(str(exc)),
        "retryable": getattr(exc, "retryable", False),
    }
```

```js
// scripts/framework/_node_bridge.js  (the ONLY Promptfoo provider face)
const semaphore = require('./concurrency').global; // p-limit, cap = AD_EVALS_MAX_CONCURRENCY

/**
 * Parse vars.turns into a string[].
 *
 * Promptfoo's test-matrix engine expands YAML array vars into separate rows
 * (spike A.0.B verified): context.vars.turns is NEVER a JS Array at callApi
 * time. Consumers encode multi-turn sequences as a JSON string:
 *
 *   vars:
 *     turns: '["turn 1","turn 2","turn 3"]'   # JSON-encoded array
 *
 * A plain (non-JSON) string is treated as a single-turn sequence.
 * Falls back to [promptFallback] if turns is absent/empty.
 * Returns null only if both turns and promptFallback are absent.
 */
function parseTurns(rawTurns, promptFallback) {
  if (rawTurns && typeof rawTurns === 'string' && rawTurns.trim()) {
    try {
      const parsed = JSON.parse(rawTurns);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (_) { /* not JSON-encoded — treat as single-turn */ }
    return [rawTurns];
  }
  if (promptFallback) return [promptFallback];
  return null;
}

class HarnessBridgeProvider {
  constructor(options) {
    this.options = options;                       // includes config.provider_kind, config.provider_label
  }
  id() { return `harness:${this.options.config.provider_label}`; }
  label() { return this.options.config.provider_label; }

  async callApi(prompt, context, options) {
    // Promptfoo passes only { abortSignal } as the callApi third arg (spike-verified A.0.B).
    // Provider config is exclusively available via this.options.config (constructor-time).
    const cfg = parseProviderConfig(this.options.config);
    return semaphore(() => this._dispatch(prompt, context, cfg));
  }

  async _dispatch(prompt, context, cfg) {
    // ALL return paths — including in-process opencode_cli, validation
    // failures, and spawn/IPC exceptions — funnel through baseMetadata
    // so canonical fields per §1.5 are never missing.
    const startedAt = Date.now();

    // ALL paths build the transcript by APPENDING a record for every
    // attempted turn (success or failure). The invariant per §3.2.1:
    //   transcript.length === number of attempted turns
    //   each failed turn has an `error` field; each successful turn does not
    const transcript = [];
    const turnOutputs = [];
    const latencyPerTurn = [];

    const pushTurn = (turn_index, input, output, latency_ms, tool_calls, error) => {
      const entry = { turn_index, input, output: output || '', latency_ms, tool_calls: tool_calls || [] };
      if (error) entry.error = error;
      transcript.push(entry);
    };

    if (cfg.provider_kind === 'opencode_cli') {
      // OpenCode CLI is single-shot; bridge calls existing module in-process.
      // Multi-turn rejected until Phase 2.
      // Note: Promptfoo expands YAML array vars into separate matrix rows (spike A.0.B).
      // context.vars.turns is NEVER a JS Array at callApi time — it is either a
      // JSON-encoded string (multi-turn) or a plain string (single-turn) or absent.
      // parseTurns() decodes per §3.2 precedence rules.
      const turns = parseTurns(context?.vars?.turns, prompt);
      // Reject if parseTurns returned null (no usable input at all).
      const noUsableTurn = !turns || turns.length === 0 ||
        (turns.length === 1 && (turns[0] === undefined || turns[0] === null || turns[0] === ''));
      if (noUsableTurn) {
        const err = { code: 'validation', retryable: false, message: 'no turns to send: vars.turns is empty and prompt is missing/empty' };
        return {
          output: '',
          error: err.message,
          metadata: baseMetadata(cfg, {
            provider_error: err,
            turns_completed: 0,
            final_turn_output: '',
            transcript,
            latency_ms_per_turn: latencyPerTurn,
            latency_ms_total: Date.now() - startedAt,
          }),
        };
      }
      if (turns.length > 1) {
        const err = { code: 'validation', retryable: false, message: 'multi-turn not supported by opencode_cli in v1.0.0' };
        // Record one entry per attempted turn so the transcript still reflects intent.
        for (let i = 0; i < turns.length; i++) pushTurn(i, turns[i], '', 0, [], err);
        return {
          output: '',
          error: err.message,
          metadata: baseMetadata(cfg, {
            provider_error: err,
            turns_completed: 0,
            final_turn_output: '',
            transcript,
            latency_ms_per_turn: latencyPerTurn,
            latency_ms_total: Date.now() - startedAt,
          }),
        };
      }
      const turnStart = Date.now();
      let res;
      try {
        const provider = require('./opencode-cli-provider.js').create(cfg);
        res = await provider.callApi(turns[0], context);
      } catch (e) {
        const err = normalizeErr(e);
        const turnLatency = Date.now() - turnStart;
        pushTurn(0, turns[0], '', turnLatency, [], err);
        latencyPerTurn.push(turnLatency);
        return errorReturn(cfg, err, transcript, turnOutputs, latencyPerTurn, 0, startedAt);
      }
      const turnLatency = Date.now() - turnStart;
      latencyPerTurn.push(turnLatency);
      if (res.error) {
        // opencode-cli-provider returned a string error (its contract). Treat as failed turn.
        const err = normalizeErr(res.error);
        pushTurn(0, turns[0], res.output || '', turnLatency, res.metadata?.tool_calls, err);
        return {
          output: res.output || '',
          error: err.message,
          metadata: baseMetadata(cfg, {
            ...(res.metadata || {}),
            provider_error: err,
            turns_completed: 0,
            final_turn_output: res.output || '',
            transcript,
            latency_ms_per_turn: latencyPerTurn,
            latency_ms_total: Date.now() - startedAt,
          }),
        };
      }
      pushTurn(0, turns[0], res.output || '', turnLatency, res.metadata?.tool_calls);
      turnOutputs.push(res.output || '');
      return {
        output: res.output,
        metadata: baseMetadata(cfg, {
          ...(res.metadata || {}),
          turns_completed: 1,
          final_turn_output: res.output || '',
          transcript,
          latency_ms_per_turn: latencyPerTurn,
          latency_ms_total: Date.now() - startedAt,
        }),
      };
    }

    // SDK providers: spawn persistent subprocess, NDJSON loop.
    // Same precedence as opencode_cli branch (§3.2): parseTurns decodes
    // vars.turns (JSON-encoded string or plain string) then falls back to
    // single prompt. Promptfoo never delivers a JS Array here (spike A.0.B).
    const turns = parseTurns(context?.vars?.turns, prompt);
    const sdkNoUsableTurn = !turns || turns.length === 0 ||
      (turns.length === 1 && (turns[0] === undefined || turns[0] === null || turns[0] === ''));
    if (sdkNoUsableTurn) {
      // No turns to attempt → no transcript entries (count invariant: 0 attempted = 0 entries).
      const err = { code: 'validation', retryable: false, message: 'vars.turns is empty' };
      return {
        output: '',
        error: err.message,
        metadata: baseMetadata(cfg, {
          provider_error: err,
          turns_completed: 0,
          final_turn_output: '',
          transcript,
          latency_ms_per_turn: latencyPerTurn,
          latency_ms_total: Date.now() - startedAt,
        }),
      };
    }
    let child = null;
    let attemptedIndex = -1;            // tracks the turn we are mid-flight on
    let attemptedStart = 0;
    let attemptedInput = '';
    try {
      child = spawn(adapterCmd(cfg.provider_kind), { stdio: ['pipe', 'pipe', 'pipe'] });
      await send(child, { type: 'init', config: cfg });
      let lastResult = null;
      for (let i = 0; i < turns.length; i++) {
        attemptedIndex = i;
        attemptedInput = turns[i];
        attemptedStart = Date.now();
        const resp = await send(child, { type: 'turn', message: turns[i], turn_index: i });
        const turnLatency = Date.now() - attemptedStart;
        latencyPerTurn.push(turnLatency);
        attemptedIndex = -1;            // turn completed (cleanly or with explicit response)
        if (resp.type === 'error' || resp.result?.error) {
          const err = normalizeErr(resp.error || resp.result.error);
          const partialOutput = resp.result?.text || '';
          pushTurn(i, turns[i], partialOutput, turnLatency, resp.result?.tool_calls, err);
          return {
            output: turnOutputs.concat(partialOutput).join('\n---\n'),
            error: err.message,
            metadata: baseMetadata(cfg, {
              provider_error: err,
              turns_completed: i,
              final_turn_output: partialOutput,
              transcript,
              latency_ms_per_turn: latencyPerTurn,
              latency_ms_total: Date.now() - startedAt,
            }),
          };
        }
        turnOutputs.push(resp.result.text);
        pushTurn(i, turns[i], resp.result.text, turnLatency, resp.result.tool_calls);
        lastResult = resp.result;
      }
      const final = await send(child, { type: 'finalize' });
      return {
        output: turnOutputs.join('\n---\n'),
        metadata: baseMetadata(cfg, {
          ...final.metadata,
          turns_completed: turns.length,
          final_turn_output: lastResult.text,
          transcript,
          latency_ms_per_turn: latencyPerTurn,
          latency_ms_total: Date.now() - startedAt,
        }),
      };
    } catch (e) {
      // spawn failure, IPC throw, init handshake failure, or mid-turn throw.
      const err = normalizeErr(e);
      // If a turn was mid-flight when the exception fired, record it
      // so the transcript still has an entry for the attempted turn.
      if (attemptedIndex >= 0) {
        const turnLatency = Date.now() - attemptedStart;
        latencyPerTurn.push(turnLatency);
        pushTurn(attemptedIndex, attemptedInput, '', turnLatency, [], err);
      }
      return errorReturn(cfg, err, transcript, turnOutputs, latencyPerTurn, turnOutputs.length, startedAt);
    } finally {
      if (child) {
        try { await send(child, { type: 'shutdown' }, { timeoutMs: 5000 }); }
        catch { child.kill('SIGKILL'); }
      }
    }
  }
}

function normalizeErr(e) {
  if (e && typeof e === 'object' && e.code && e.message) {
    return { code: e.code, message: e.message, retryable: !!e.retryable };
  }
  if (typeof e === 'string') {
    return { code: 'provider_error', message: e, retryable: false };
  }
  return { code: 'bridge_error', message: e?.message || String(e), retryable: false };
}

// Wrap any thrown Error into a Promptfoo-compatible return with canonical metadata.
function errorReturn(cfg, err, transcript, turnOutputs, latencyPerTurn, turnsCompleted, startedAt) {
  return {
    output: turnOutputs.join('\n---\n'),
    error: err.message,
    metadata: baseMetadata(cfg, {
      provider_error: err,
      turns_completed: turnsCompleted,
      final_turn_output: turnOutputs[turnOutputs.length - 1] || '',
      transcript,
      latency_ms_per_turn: latencyPerTurn,
      latency_ms_total: Date.now() - startedAt,
    }),
  };
}

// Canonical adapter metadata per §1.5. Every return path — success and
// error alike — funnels through here so observability/assertion fields
// are never missing.
function baseMetadata(cfg, extra) {
  return {
    provider_kind: cfg.provider_kind,
    provider_label: cfg.provider_label,
    model: cfg.model,
    sdk_version: cfg.sdk_version || null,    // populated by subprocess `init_ok`
    adapter_version: require('../package.json').version,
    run_id: process.env.AD_EVALS_RUN_ID,
    case_id: cfg.case_id,
    ...extra,
  };
}

module.exports = HarnessBridgeProvider;
```

Notes:

- `error` returned to Promptfoo is a **string** (consistent with the
  existing `opencode-cli-provider` contract). Structured error lives in
  `metadata.provider_error`.
- The semaphore wraps every `callApi` regardless of `provider_kind`, so
  `opencode_cli` cases also respect `AD_EVALS_MAX_CONCURRENCY`.
- `adapterCmd(provider_kind)` returns the spawn argv vector per Section
  2.2 dispatch table — e.g., for `openhands_sdk` it produces
  `['uv', 'run', '--python', '3.12', '--with', 'openhands-sdk==1.22.1', 'python', '<path>/_python_adapter.py', 'openhands_sdk']`.
- `parseProviderConfig` validates required fields (`provider_kind`,
  `provider_label`, `model`) and throws `validation` ProviderError if
  malformed.
- **SDK session lifecycle (spike A.0 fix):** `provider.init()` constructs
  `LLM + Agent + Conversation(..., delete_on_close=False)` and returns a
  `LocalConversation`. `provider.turn()` calls `session.send_message(msg)`
  then `session.run()` (blocks), assembles `TurnResult` from event callbacks.
  `provider.shutdown()` calls `session.close()`. Set `delete_on_close=False`
  so the bridge (not the SDK) owns workspace cleanup per §7.3.
- **cost_usd source (spike A.0 fix):** Extract from
  `session.conversation_stats.usage_to_metrics[model_name].accumulated_cost`
  after `run()` completes. Nullable if no LLM calls were made.

---

## Section 3 — Multi-turn Conversation API

### 3.1 Scripted via `vars.turns` (precedence rules)

> **Encoding requirement (spike A.0.B).** Promptfoo's test-matrix engine
> expands YAML/JSON array-valued vars into separate rows — one `callApi`
> invocation per element. To pass a multi-turn sequence as a single unit,
> `vars.turns` MUST be a **JSON-encoded string** (the entire array serialized
> as a string value). The bridge decodes it with `parseTurns()`.

```json
{
  "tests": [
    {
      "description": "[smoke] multi-turn refactor flow",
      "vars": {
        "turns": "[\"Read src/auth.ts and summarize the auth flow.\",\"Propose a refactor to use the new SessionManager.\",\"Implement the refactor and run the test suite.\"]"
      },
      "assert": [
        { "type": "javascript", "value": "context.metadata.turns_completed === 3" },
        { "type": "contains", "value": "SessionManager" }
      ]
    }
  ]
}
```

In YAML (more readable):

```yaml
tests:
  - description: "[smoke] multi-turn refactor flow"
    vars:
      turns: >-
        ["Read src/auth.ts and summarize the auth flow.",
         "Propose a refactor to use the new SessionManager.",
         "Implement the refactor and run the test suite."]
    assert:
      - type: javascript
        value: "context.metadata.turns_completed === 3"
      - type: contains
        value: "SessionManager"
```

### 3.2 Precedence

1. If `vars.turns` is a non-empty **JSON-encoded string** that parses to a
   non-empty string array → decode and use as the turn sequence.
2. Else if `vars.turns` is a non-empty plain string → treat as single turn.
3. Else if `prompts:` resolves to a non-empty string → use as single turn.
4. Else fail with `validation` error.

If both `vars.turns` and `prompts:` are set, **`vars.turns` wins** and
`prompts:` content is ignored (adapter prints a warning to stderr — also
surfaced in metadata as `metadata.warnings: ["prompts ignored: vars.turns set"]`).

Note: do NOT declare `vars.turns` as a YAML/JSON array. Promptfoo's
test-matrix engine would expand it into separate rows — one `callApi`
invocation per element — defeating multi-turn sequencing. Always pass the
full turn list as a JSON-encoded string value.

### 3.2.1 What Promptfoo's assertion layer sees during multi-turn

Promptfoo still passes a single rendered `prompt` string into the
bridge's `callApi`. That rendered prompt is **ignored** when `vars.turns`
wins (per precedence above), but the bridge must still return a single
`output` field for Promptfoo's assertion engine. Canonical semantics:

| Field | Value when `vars.turns` decodes to N>1 turns | Value for single-turn |
| --- | --- | --- |
| `output` | All per-turn outputs joined with `\n---\n` (full transcript) | The single turn's text |
| `metadata.final_turn_output` | Last turn's text only | Same as `output` |
| `metadata.turns_completed` | Number of turns that returned successfully | `1` if turn succeeded, `0` if it errored |
| `metadata.transcript` | Array of `{turn_index, input, output, latency_ms, tool_calls, error?}` per turn (one entry per attempted turn, including any that errored — `error` field present iff that turn failed) | Single-element array |

Recommendation for consumers:
- `assert: { type: contains, value: "..." }` matches anywhere in the
  full transcript (use the joined `output`).
- For "the final answer must say X" assertions, use
  `assert: { type: javascript, value: "context.metadata.final_turn_output.includes('X')" }`.
- For per-turn fine-grained assertions, walk `context.metadata.transcript`.

### 3.3 Per-turn early termination

If `turn N` returns an error, no further turns are sent. Adapter returns
`{error: "...", metadata.turns_completed: N}` (N = number of turns
successfully completed before the failing one).

### 3.4 Kill switch

`AD_EVALS_DISABLE_MULTI_TURN=1` → adapter uses `turns[0]` only, ignores
the rest. Emergency fallback if multi-turn breaks something globally.

### 3.5 Assertion-accessible metadata

Canonical field names (consistent across all references):

```js
context.metadata.turns_completed === 3
context.metadata.tool_calls.some(t => t.name === "terminal")
context.metadata.cost_usd != null && context.metadata.cost_usd < 0.50
context.metadata.latency_ms_total < 30000
```

---

## Section 4 — Parallelism

### 4.1 Phase 1 — one axis: case-level

Promptfoo `--max-concurrency` (default 4, env override
`AD_EVALS_MAX_CONCURRENCY`). Each case runs in its own subprocess; that
naturally provides session isolation.

Provider/model fan-out (`--compare`) and per-provider concurrency caps
are **deferred to Phase 2** when ≥2 SDK providers exist. Adding fan-out
to Phase 1 would expand the test matrix without buying anything (only
one SDK provider exists in v1.0.0).

### 4.2 Concurrency clamping (enforced by bridge, not config)

Codex was right: Promptfoo owns case scheduling. Config rewriting alone
cannot enforce a per-provider semaphore. Phase 1 mitigates by:

- **Single Promptfoo provider URL** — every `callApi`, regardless of
  `provider_kind`, enters `_node_bridge.js`. The bridge wraps every
  dispatch in a `p-limit`-style semaphore with
  cap = `AD_EVALS_MAX_CONCURRENCY` (default 4, matches Promptfoo's
  `--max-concurrency` default). This covers the SDK-subprocess spawn
  path **and** the `opencode_cli` in-process path (which itself
  spawns the `opencode` CLI).
- **Single ad-evals process per run** ensures the semaphore is
  process-local and effective.
- **Bridge module is a singleton** — Node's `require` cache guarantees
  one semaphore instance per `ad-evals` process even if Promptfoo
  instantiates the bridge class multiple times per row.

Per-provider caps (e.g., "Codex SDK = 2 max") deferred to Phase 4 when
Codex is added.

### 4.3 v1.0.0 tier config schema

Multi-provider array form, but Phase 1 only ships 1-2 entries per tier:

```toml
# config/eval-tiers.toml

# Backward-compat: keep light/standard/high/x_high
[[tiers.light.providers]]
provider_kind = "opencode_cli"
model = "anthropic/claude-haiku-4-5"
label = "opencode-haiku"
agent_config = "opencode.json"

[[tiers.standard.providers]]
provider_kind = "opencode_cli"
model = "anthropic/claude-sonnet-4-6"
label = "opencode-sonnet"
agent_config = "opencode.json"

[[tiers.standard.providers]]
provider_kind = "openhands_sdk"
model = "anthropic/claude-sonnet-4-6"
label = "openhands-sonnet"

[tiers.standard.runtime]
timeout_per_turn_s = 300
tools = ["terminal", "file_editor"]
[tiers.standard.runtime.permissions.terminal]
deny_network = true
max_runtime_s = 60

[concurrency]
default_max_concurrency = 4
```

Validation rules:
- `label` must be unique per tier (duplicate → validation error).
- `provider_kind` must be registered in the bridge dispatch table —
  `KIND_REGISTRY` in `scripts/framework/_node_bridge.js` (canonical path;
  matches §2.6, §A.1, §9.2 A.5). Each entry maps `provider_kind` →
  `{ mode: "inproc" | "subprocess", impl }`, where `impl` is either an
  `adapterCmd(cfg)` builder (subprocess kinds: `openhands_sdk`,
  `claude_agent_sdk`, `opencode_sdk`, `codex_sdk`) or a `require(...)`
  path to a Node provider module (in-process kinds: `opencode_cli`).
  `adapterCmd(provider_kind)` in §2.6 reads from this same table — there
  is no separate `_dispatch.{py,ts}` registry.
- `agent_config` only valid for `provider_kind = "opencode_cli"`.
- Unknown keys → validation error (strict mode).

### 4.4 Migration from v0 tier config

The current `eval-tier-config.js` uses a single-provider form (one
provider per tier). Migration script (`migrate-from-v0.js`):

```toml
# v0 (current main)
[runtime]
default_provider = "opencode_cli"

[tiers.standard]
agent = "opencode-sonnet"
opencode_config = "opencode.json"
```

```toml
# v1 (after migrate)
[[tiers.standard.providers]]
provider_kind = "opencode_cli"
label = "opencode-sonnet"
agent_config = "opencode.json"
model = "anthropic/claude-sonnet-4-6"   # filled from current default
```

`eval-tier-config.js` accepts **both forms** in v1.0.0 (single-provider
form auto-promoted to single-element array internally) — gives consumers
a soft migration path.

---

## Section 5 — In-repo Scenarios (small, sustainable)

### 5.1 Location and 3 packages (cut from 10 → 4 → 3)

```text
promptfoo-eval-harness/
└── tests/harness-scenarios/
    ├── config/
    │   └── eval-tiers.toml
    ├── packages/
    │   ├── minimal-smoke/                  # init/turn/finalize/shutdown
    │   ├── opencode-cli-compatibility/     # preserves current production flow
    │   └── openhands-mock-multi-turn/      # 3-turn mock SDK, no live LLM
    └── promptfooconfig.shared.json
```

**Cut from Phase 1** (added in later phases if needed):
- `error-injection` (covered by Layer 3 unit tests).
- `parallel-throughput` (added in Phase 2 when fan-out exists; for v1.0.0
  benchmark lives in `bench/` directory, not as a scenario).
- `tool-registry-coverage` (covered by Layer 3).
- `sdk-version-canary` (post-v1; creates false urgency).
- `provider-parity` (requires ≥2 providers; Phase 2).
- `migration-fixture` (becomes a unit test of `migrate-from-v0.js`).
- `workspace-cleanup-guard` — was planned as L4 live-LLM. Codex pass 2
  flagged this as over-engineering: filesystem-containment is a
  deterministic property — verifying it with a live model adds cost and
  flake without increasing confidence. Replaced with a Layer 3
  integration test (`scripts/framework/_node_bridge.workspace.test.js`)
  that runs a mock subprocess which intentionally writes to a sibling
  path of the workspace dir; the test asserts the existing cleanup-guard
  fails the run.

### 5.2 Scenario inventory (Phase 1)

| Package | Type | Cost/run | Purpose |
| --- | --- | --- | --- |
| `minimal-smoke` | Live LLM | ~$0.01 | Verify init/turn/finalize/shutdown end-to-end |
| `opencode-cli-compatibility` | Live LLM | ~$0.02 | Lock current `opencode-cli-provider` behavior |
| `openhands-mock-multi-turn` | Mock SDK (no LLM) | $0 | 3-turn loop, tool call serialization |

Total nightly sweep ≈ $0.03. Monthly ≈ $0.90.

### 5.3 npm scripts

```json
{
  "eval:scenarios": "ad-evals run tests/harness-scenarios/packages",
  "eval:scenarios:smoke": "ad-evals run tests/harness-scenarios/packages/minimal-smoke/promptfooconfig.json"
}
```

**`ad-evals run <path>` directory semantics (v3 — new in Phase 1):**

`bin/ad-evals.js` currently expects a single config file path. Phase 1
must extend the `run` subcommand so `<path>` may be either:

1. A file ending in `promptfooconfig.json` (existing behavior — unchanged).
2. A directory — the CLI then walks one level of immediate subdirectories,
   collects each `promptfooconfig.json` it finds, and dispatches one
   Promptfoo invocation per package in parallel (capped by
   `AD_EVALS_MAX_CONCURRENCY` and the bridge semaphore from §4.2).

The scenario fan-out happens *outside* a Promptfoo run (one process per
package), not inside one. This is intentional: each package has its own
fixtures, eval-map entries, and tier config, and Promptfoo's per-config
isolation is the cleanest boundary. Implementation lives in Step G.28
of §9.2 (`bin/ad-evals.js` — extend `run <path>` to accept a directory
and fan out per-package Promptfoo runs through the bridge semaphore),
not buried inside the migration tool (G.31).

### 5.4 Quarantine — gated, not free

A scenario added to `tests/harness-scenarios/.quarantine.toml` must include:

```toml
[[quarantined]]
package = "openhands-mock-multi-turn"
issue = "https://linear.app/...VD-XXXX"
added = "2026-06-15"
expires = "2026-07-15"      # MUST be set, max 30 days
reason = "intermittent SDK timeout under investigation"
```

Quarantine expiry → CI fails. Forces accountability instead of silent
suppression. A separate `quarantined-scenarios.yml` workflow still runs
the quarantined scenario nightly and **opens an issue** if it fails (so
regressions don't hide).

---

## Section 6 — Distribution / Versioning / SDK Pinning

### 6.1 SemVer policy

- `v1.0.0` = first stable release of the plugin contract + OpenHands SDK
  provider + OpenCode CLI provider preserved.
- Consumers pin `^1.0.0` (minor + patch auto-update).
- MAJOR bump when contract types or `provider_kind` registry breaks.

### 6.2 npm dist-tags

| Tag | Meaning | Promotion |
| --- | --- | --- |
| `latest` | Production-ready | Manual after RC soak |
| `next` | Pre-release candidate | Auto on tag `v1.x.x-rc.N` |
| `canary` | Bleeding-edge from `main` | Auto on every `main` push |

### 6.3 Python packaging in the npm package

The harness ships Python adapter code inside the npm package. On
consumer install, no Python install runs automatically. Instead:

```text
npx eval-harness-init  →  copies templates  →  prints doctor instructions
```

`ad-evals doctor` checks (Phase 1):
- `python3.12+` on PATH (OpenHands SDK requires `>=3.12`).
- `uv` on PATH (otherwise prints install command).
- `ANTHROPIC_API_KEY` set (warning, not error).

`ad-evals doctor --install-providers` (v3 — new in Phase 1):
- Pre-warms the uv cache by running
  `uv run --python 3.12 --with openhands-sdk==1.22.1 python -c "import openhands.sdk"`
  once. Idempotent. Documented as the one-time setup step in
  `docs/setup.md` so first-eval latency is not perceived as a hang.
- Honors `AD_EVALS_OFFLINE=1` — refuses to fetch; exits non-zero with
  a clear message if the wheels are not already cached. Lets CI runs
  fail fast when the network is missing instead of stalling on uv.

When a `provider_kind` requiring Python is invoked:
- Adapter spawns `uv run --python 3.12 --with openhands-sdk==1.22.1 python adapter.py ...`
- First invocation pulls dependencies into uv cache (~5-30s, one-time)
  unless `--install-providers` ran already.
- Subsequent invocations are cache hits (<200ms warm).
- If `AD_EVALS_OFFLINE=1` and cache is cold → adapter fails the case
  with a clear error pointing to `ad-evals doctor --install-providers`.

Failure mode if no Python: clear error message:
```
[ad-evals] error: provider_kind=openhands_sdk requires Python 3.12+ and uv.
Run `npx ad-evals doctor` for install instructions.
```

`pyproject.toml` and `uv.lock` are committed in the harness repo for
CI determinism. Consumers do NOT need to commit a uv lock file.

### 6.4 SDK version pinning — framework-owned

```toml
# config/sdk-pins.toml — shipped with framework, single source of truth
[openhands_sdk]
version = "1.22.1"
python = ">=3.12,<3.14"
# extras: empty by default. If Step A.0 spike (§9.4) discovers an extras
# group is required (e.g. ["tools"]), add it here AND update every
# `uv run --with openhands-sdk==...` invocation in this spec
# (§2.6 spawn cmd, §6.3 doctor pre-warm, §6.3 adapter spawn) to use
# `openhands-sdk[<extras>]==1.22.1`. Single source of truth — no
# divergence between pin file and call sites.
extras = []
# Env vars copied through to the subprocess (allowlist). Adapter strips
# every other key matching the secret patterns in §7.1.
env_allowlist = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]

[opencode_cli]
# OpenCode CLI is system-installed; harness verifies `opencode --version`
min_version = "0.18.0"
env_allowlist = ["OPENCODE_CONFIG", "XDG_STATE_HOME", "ANTHROPIC_API_KEY"]
```

**Why `1.22.1` / `>=3.12`** (v3 fix — codex review pass 2 BUG #2): PyPI's
`openhands-sdk` latest is `1.22.1`. Its `pyproject.toml` declares
`requires-python = ">=3.12"`. Spec v2 cited `1.23.0` with `>=3.10,<3.13`;
both were wrong. Pin verified with
`uv pip install --dry-run --python 3.12 openhands-sdk==1.22.1`.

Phase 2-4 add entries for `claude_agent_sdk`, `opencode_sdk`, `codex_sdk`.

Consumers **cannot override** per-repo. Rationale: security (one patched
version everywhere) + simplicity. CVE in pinned version → harness patch
release, consumers `npm update`.

### 6.5 Repo boundary enforcement (CI gate is canonical)

CODEOWNERS only **requests review** — does not block merges. Hard
enforcement is a CI gate in consumer repos:

```yaml
# data-engineering/.github/workflows/eval-boundary.yml
- name: reject harness changes
  if: github.event_name == 'pull_request'
  run: |
    if git diff --name-only origin/${{ github.base_ref }}...HEAD \
       | grep -E "^tests/evals/(scripts/framework|bin)/"; then
      echo "::error::Harness changes belong in promptfoo-eval-harness, not here."
      exit 1
    fi
```

CODEOWNERS still useful:
```text
# data-engineering/.github/CODEOWNERS
tests/evals/scripts/framework/  @harness-team
tests/evals/bin/                @harness-team
tests/evals/config/eval-tiers.toml @data-eng-team @harness-team
```

### 6.6 Migration story

```bash
# In consumer repo:
cd tests/evals
npx --package @accelerate-data/promptfoo-eval-harness@^1.0.0 \
  eval-harness-init --upgrade --migrate-from-v0
```

The `--migrate-from-v0` flag:
- Rewrites `config/eval-tiers.toml` from v0 single-provider form to v1
  `[[tiers.X.providers]]` array form (in-place edit, prints diff).
- Adds `.github/dependabot.yml` entries for npm.
- Adds `.github/workflows/eval-boundary.yml`.
- Prints next steps for setting up OpenHands SDK (if user wants it).
- **Does NOT delete anything**. v0 → v1 is additive.

### 6.7 Compatibility matrix (README.md)

| Harness | Node | Python | OpenCode CLI | OpenHands SDK | Claude Agent | OpenCode SDK | Codex SDK |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `1.0.x` | ≥18 | 3.12-3.13 (only if openhands_sdk used) | system ≥0.18 | 1.22.x | — | — | — |
| `1.1.x` | ≥18 | 3.12-3.13 | system ≥0.18 | 1.22.x | 0.4.x | — | — |
| `1.2.x` | ≥18 | 3.12-3.13 | system ≥0.18 | 1.22.x | 0.4.x | 0.18.x | — |
| `1.3.x` | ≥18 | 3.12-3.13 | system ≥0.18 | 1.22.x | 0.4.x | 0.18.x | 0.10.x |

---

## Section 7 — Cross-cutting Concerns

### 7.1 Secret handling

Boundaries:

- **Env vars**: read at adapter startup, never echoed.
- **Subprocess env**: starts empty, then re-populates with two sets:
  1. Harness-internal vars (`PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`,
     `AD_EVALS_*`) needed for `uv`/Python to run.
  2. Per-provider allowlist from `config/sdk-pins.toml`
     (`[<provider_kind>].env_allowlist`) — e.g., `openhands_sdk` allows
     `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`; `opencode_cli` allows
     `OPENCODE_CONFIG`, `XDG_STATE_HOME`, `ANTHROPIC_API_KEY`.
  Any key matching the secret patterns below that is NOT on the
  allowlist is stripped before `spawn()` is called.
- **Secret patterns** (v3 — broadened from `*_API_KEY` only): keys are
  treated as secret and stripped/redacted if they match any of
  `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_COOKIE`,
  `*_SESSION`, or values matching `/Bearer [\w-]+/`, `/sk-[\w-]+/`.
- **Stderr capture**: redacted via the same pattern set before
  surfacing in metadata.
- **Raw events**: NOT in `TurnResult` by default. Opt-in via
  `AD_EVALS_CAPTURE_RAW_EVENTS=1` writes to per-run artifact dir under
  `tests/evals/results/raw-events/<run_id>/<case_id>.jsonl`. The artifact
  dir is in `.gitignore`. Redaction applies before write.
- **Promptfoo reports**: `metadata.provider_error.message` is sanitized;
  `metadata.tool_calls[*].arguments` and `.result_truncated` are
  truncated to 1KB and pass through the secret redactor.

### 7.2 Observability

Every adapter run emits structured logs to stderr (JSON lines):

```json
{"ts": "2026-05-22T16:49:00Z", "level": "info", "run_id": "...", "case_id": "...",
 "provider_kind": "openhands_sdk", "event": "init_ok", "latency_ms": 412}
{"ts": "...", "event": "turn_start", "turn_index": 0}
{"ts": "...", "event": "turn_ok", "turn_index": 0, "latency_ms": 3210,
 "tool_calls_count": 2}
{"ts": "...", "event": "shutdown_ok"}
```

CLI flag `--log-format=json|text` (default `text` interactively, `json`
in CI based on `CI=true`).

Metadata fields enabling observability (already in Section 1.5):
`run_id`, `case_id`, `provider_kind`, `provider_label`, `sdk_version`,
`adapter_version`, `latency_ms_total`, `latency_ms_per_turn`.

### 7.3 Workspace lifecycle (rewritten v3 — codex pass 2 BUG #3)

Each case gets a fresh workspace:

```text
tests/evals/.tmp/workspaces/<run_id>/<case_id>/
```

- Created by the Node bridge just before sending `init` to the
  subprocess.
- Copy-on-write: if a tier specifies `workspace_template`, contents are
  copied (not symlinked — symlinks break sandboxing). Source must be
  inside repo.
- The subprocess is spawned with `cwd = <workspace path>` and
  `workspace_root` in `ProviderConfig`. This is the containment
  mechanism: a misbehaving provider that writes a relative path lands
  inside the workspace by construction.
- Cleanup: the bridge `finally`-removes the workspace directory after
  `shutdown`, even on errors. Exception: if `AD_EVALS_KEEP_WORKSPACE=1`,
  the directory persists for debugging.
- Path traversal: the provider implementation is responsible for
  refusing absolute paths or `..` segments in tool arguments; tool
  registries reject them at the call site.

**What the existing cleanup-guard does and does not cover.** The
existing `run-promptfoo-with-guard.js` snapshots tracked files in the
repo before the run and asserts they match after — it catches a
provider that writes into `src/` or other tracked locations. It does
not cover `.tmp/workspaces/` because that path is `.gitignore`-d.

**What we add in Phase 1.** Wrap the existing guard with one additional
post-run assertion: `tests/evals/.tmp/workspaces/<run_id>/` is empty
after a successful run (the bridge already removed it). If a workspace
directory is left behind, the run fails with a clear pointer to
`AD_EVALS_KEEP_WORKSPACE`. This is one new branch inside
`run-promptfoo-with-guard.js`, not a new file.

**Interaction with `AD_EVALS_KEEP_WORKSPACE=1`.** When the env var is
set, both the bridge's `finally` cleanup AND the post-run assertion
are skipped — the contract becomes "workspace is left for inspection,
guard does not police it." The guard logs a single warning per run
naming the path, so operators don't forget to clean up manually. This
mode is gated to local debugging; nightly/PR CI never sets it.

A dedicated `scripts/framework/workspace-guard.js` module — originally
v2 §7.3 — is **deferred to Phase 1.x**. Codex pass 2 was right that
the v2 text ("any file ... that ends up outside is moved/deleted") was
logically impossible: a file is in exactly one place at one time;
either it leaked or it did not. The replacement above is correct and
small enough to land inside the existing guard.

### 7.4 OpenCode CLI provider — explicit compatibility requirements

The current `opencode-cli-provider.js` behavior is **the baseline**.
Phase 1 must preserve:

- Env vars set: `OPENCODE_CONFIG`, `XDG_STATE_HOME`.
- Empty-output retry: if `opencode run` returns empty stdout but exit 0,
  retry once before failing.
- `abortSignal` propagation: SIGTERM to `ad-evals` kills child `opencode`.
- `project_dir` resolution: defaults to nearest git root, override via
  `opencode_project_dir` in tier config.
- Spawn args: `opencode run --format json --log-level WARN <prompt>`.

These are locked by:
- `tests/harness-scenarios/packages/opencode-cli-compatibility/` (Layer 4)
- New Layer 3 tests in `scripts/framework/opencode-cli-provider.test.js`
  (not present on main today — write before any provider refactor).

### 7.5 Multi-provider compare semantics (Phase 2 — defined now to avoid Phase 1 ambiguity)

When `--compare` lands (Phase 2):
- One case × N providers = N Promptfoo test rows (NOT N evaluations of
  the same row).
- Per-row pass/fail is independent. Whole-eval exit code is non-zero if
  ANY row fails (existing Promptfoo semantics).
- Reports group rows by `provider_label`.
- No cross-provider convergence assertions — that's the consumer's job.

Reserving these semantics now blocks the design space; Phase 1 simply
**rejects** `--compare` with "deferred to v1.1.0".

---

## Section 8 — Testing Strategy

### 8.1 4-layer pyramid (scoped for Phase 1)

| Layer | Purpose | Speed | Cost | When |
| --- | --- | --- | --- | --- |
| **L1 — Framework contract** | Pure Node unit tests, no spawning | <5s | $0 | Every PR |
| **L2 — Provider contract (hand-written)** | Per-language asserts on each provider impl | <30s | $0 | Every PR |
| **L3 — Integration (mock SDK)** | IPC + adapter loop with mocked SDK | <60s | $0 | Every PR |
| **L4 — In-repo scenarios** | 3 scenarios (2 live, 1 mock — §5.1) | 5-15 min | ~$0.03 | Nightly + on-demand |

YAML-driven cross-language L2 generation is **deferred** to Phase 4+.
For Phase 1, each language has its own hand-written contract test file:

- `scripts/framework/providers/openhands_sdk/test_contract.py`
- `scripts/framework/opencode-cli-provider.contract.test.js`

### 8.2 New Phase 1 test files

```text
scripts/framework/concurrency.test.js                  (semaphore behavior)
scripts/framework/eval-tier-config.multi-provider.test.js  (v0 + v1 forms)
scripts/framework/resolve-promptfoo-config.test.js     (provider URL emission)
scripts/framework/_node_bridge.test.js                 (IPC framing, errors)
scripts/framework/_node_bridge.ipc-failure.test.js     (malformed JSON, timeout)
scripts/framework/migrate-from-v0.test.js
scripts/framework/sdk-pins.test.js
scripts/framework/_node_bridge.workspace.test.js     (per §7.3, §9.2 E.24)
scripts/framework/opencode-cli-provider.contract.test.js  (NEW — lock behavior)
scripts/framework/providers/openhands_sdk/test_provider.py
scripts/framework/providers/openhands_sdk/test_tool_registry.py
scripts/framework/providers/openhands_sdk/test_model_resolver.py
scripts/framework/providers/openhands_sdk/test_event_extractor.py
scripts/framework/providers/_python_adapter_test.py    (IPC layer)
```

### 8.3 Mocking philosophy

- **Mock**: SDK boundary (`openhands.sdk.LLM`, `.Agent`, `.Conversation`).
- **Don't mock**: HTTP, file I/O, tool execution outcomes (real
  `subprocess` for `TerminalTool` invocation in L3 — fast and local).
- **Never mock**: actual LLM API in L4.

### 8.4 Flake handling (revised — no quiet quarantine)

- L1–L3 must be deterministic. Flake = bug.
- L4: tight assertions on stable signals (`tool_calls.length`,
  `turns_completed`), loose on content. Retry once on Layer 4 failure.
- Quarantine requires issue+expiry (Section 5.4). Quarantined scenarios
  still run nightly in a separate workflow and open an issue on failure.

### 8.5 Coverage targets

| Layer | Tool | Target |
| --- | --- | --- |
| Node code | c8 | 85% |
| Python code | pytest-cov | 70% (engineering-framework standard) |

### 8.6 CI matrix

```yaml
strategy:
  matrix:
    os: [ubuntu-latest]
    node: ['18', '20']
    python: ['3.12', '3.13']
```

Python `3.10`/`3.11` are out of range (`openhands-sdk` requires
`>=3.12`; see §6.4). `3.13` is included to catch breakage early on the
next minor before bumping the pin range.

Live LLM scenarios run only in a separate workflow with workflow-scoped
secrets — PR CI does NOT need live keys (only the nightly schedule).

---

## Section 9 — Migration Plan & Phasing

### 9.1 Phase overview (REVISED — narrower v1.0.0)

| Phase | Scope | Duration | Ships as | Blocking? |
| --- | --- | --- | --- | --- |
| **Phase 1** | Plugin contract + IPC + OpenCode CLI compat + OpenHands SDK provider + 3 scenarios (§5.1) + v1.0.0 + data-engineering migration | 5-7 weeks | `v1.0.0` | Blocks Phase 2-4 |
| **Phase 2** | Claude Agent SDK + `--compare` + per-provider concurrency | 2-3 weeks | `v1.1.0` | None |
| **Phase 3** | OpenCode SDK provider | 2 weeks | `v1.2.0` | None |
| **Phase 4** | Codex SDK provider + contract YAML generator | 2-3 weeks | `v1.3.0` | None |

Estimate widened: 5-7 weeks (was 4-6). 3 engineers; the SDK spike + IPC
work add ~1 week to the original guess.

### 9.2 Phase 1 — Order of operations (REVISED v3)

```text
Step A — Spike & Foundation
   A.0    *SDK spike (gating)*: round-trip a single message via OpenHands
          SDK 1.22.1 locally to verify the inferred API shape. If it
          diverges from what spec assumes, update spec before any
          further work.
   A.0.B  *Promptfoo file-provider option-shape spike (gating)*: write
          a throwaway `file://probe.js` that exports a `callApi(prompt,
          context, options)` function which serializes its three argv to
          JSON. Drive it from a `promptfooconfig.json` whose provider is
          `file://probe.js` with a `config:` block containing nested
          objects/arrays. Run with `npx promptfoo eval -c ...` and
          assert: (a) `options.config` is present and contains the full
          nested `config:` shape verbatim (no flattening, no string
          coercion); (b) `context.vars` is also reachable. If either
          assumption fails, the §2.2 + §2.6 bridge design must be
          reworked (likely move config into `vars` or split into multiple
          providers) before A.5/A.6 land. Output: `plans/260522-1649-
          harness-plugin-contract-design/spike-promptfoo-file-shape.md`
          with raw probe JSON and verdict. Gates A.5; no implementation
          past A.4 starts until this is green.
   A.1    pyproject.toml + uv.lock + uv setup in CI
   A.2  config/sdk-pins.toml (with env_allowlist per provider_kind)
   A.3  scripts/framework/providers/_contract.py + _contract.ts
   A.4  scripts/framework/providers/_python_adapter.py — IPC layer (no
         providers yet)
   A.5  scripts/framework/_node_bridge.js — IPC layer + dispatch +
         semaphore (no providers yet; routes opencode_cli in-process,
         SDK kinds via subprocess)
   A.6  Layer 1 tests for IPC + contract types
   A.7  Benchmark cold spawn cost (Section 2.5) — abort/redesign if
         >800ms warm-up

Step B — Plugin Dispatch & Schema
   B.8  eval-tier-config.js → support [[tiers.X.providers]] array (and
         keep v0 single-provider form working)
   B.9  resolve-promptfoo-config.js → emit single
         file://scripts/framework/_node_bridge.js URL with
         config.provider_kind + label
   B.10 concurrency.js (semaphore primitive used by _node_bridge.js)
   B.11 validate-package-config.js — CREATE this file (new in v1) →
         reject `providers:` block at the package level + enforce label
         uniqueness within a tier + reject unknown keys (strict mode per
         §4.3). This is the file referenced as new in §A.1.

Step C — Preserve OpenCode CLI Provider
   C.13 Write opencode-cli-provider.contract.test.js (lock current
         behavior — env vars, retry, abortSignal, project_dir)
   C.14 Refactor opencode-cli-provider.js minimally so it can be
         require()'d by _node_bridge.js when provider_kind=opencode_cli
         (no behavior change, in-process)
   C.15 Layer 4: opencode-cli-compatibility scenario green

Step D — OpenHands SDK Provider
   D.16 .../openhands_sdk/tool_registry.py + tests
   D.17 .../openhands_sdk/model_resolver.py + tests (port from any
         existing JS logic, fresh otherwise)
   D.18 .../openhands_sdk/event_extractor.py + tests
   D.19 .../openhands_sdk/agent_factory.py + tests
   D.20 .../openhands_sdk/provider.py + L3 integration tests with mock
         SDK
   D.21 Wire into dispatch; Layer 4 openhands-mock-multi-turn green

Step E — Cross-cutting
   E.22 Secret redactor module + tests (broadened patterns per §7.1)
   E.23 Structured logger module + tests
   E.24 run-promptfoo-with-guard.js: add post-run assertion that
         tests/evals/.tmp/workspaces/<run_id>/ is empty (one new
         branch, not a new file). Adds L3 integration test
         _node_bridge.workspace.test.js with a mock subprocess that
         writes a sibling path → guard fires.
   (workspace-cleanup-guard scenario was v2's E.25 — dropped, replaced
    by the L3 test above.)

Step F — In-repo Scenarios (Layer 4)
   F.25 tests/harness-scenarios/config/eval-tiers.toml
   F.26 3 scenario packages (Section 5.1)
   F.27 .github/workflows/harness-scenarios.yml (nightly schedule,
         workflow-scoped secrets)

Step G — CLI ergonomics, Migration, Doctor
   G.28 bin/ad-evals.js: extend `run <path>` to accept a directory
         (walk one level, dispatch one Promptfoo process per package,
         cap parallelism via AD_EVALS_MAX_CONCURRENCY + bridge
         semaphore) — see §5.3
   G.29 scripts/framework/migrate-from-v0.js (v0 tier config → v1 array
         form; adds eval-boundary.yml + dependabot)
   G.30 MIGRATION-v0-to-v1.md
   G.31 eval-harness-init --migrate-from-v0 wiring
   G.32 ad-evals doctor — Python/uv preflight + new
         `--install-providers` flag (uv cache warm) + AD_EVALS_OFFLINE
         handling (§6.3)

Step H — Distribution
   H.33 CHANGELOG.md 1.0.0 entry
   H.34 README.md compatibility matrix
   H.35 .github/workflows/publish.yml (tag-triggered npm publish + canary)
   H.36 templates/.github/dependabot.yml (npm only — uv lock not for
         consumers)

Step I — Release (out-of-scope for the current implementation request —
         "DONT RAISE PR" — listed for completeness only)
   I.37 Tag v1.0.0-rc.1, npm publish to `next`
   I.38 Open PR in data-engineering applying eval-harness-init --upgrade
         --migrate-from-v0
   I.39 Soak: data-engineering runs `npm run eval:smoke` + `eval:regression`
         on RC for 3 days
   I.40 Tag v1.0.0, npm publish to `latest`
   I.41 Announce in #engineering channel
```

**No Step "Cleanup"** — main has nothing to clean up. The `feature/vd-2119`
branch stays as historical reference; do not merge it.

### 9.3 Sub-issue decomposition (Linear)

| Sub-issue | Steps | Owner | Dependencies |
| --- | --- | --- | --- |
| VD-XXXX-1 | Spike A.0 — OpenHands SDK shape (gating) | Eng A | — (gating; must complete week 1) |
| VD-XXXX-1B | Spike A.0.B — Promptfoo `file://` option-shape (gating) | Eng B | — (gating; must complete week 1; can run in parallel with -1) |
| VD-XXXX-2 | Foundation + IPC (A.1-A.7) | Eng A | -1 AND -1B (both gates must pass) |
| VD-XXXX-3 | Dispatch + schema (B) | Eng B | -2 |
| VD-XXXX-4 | OpenCode CLI lock + dispatch (C) | Eng B | -3 |
| VD-XXXX-5 | OpenHands SDK provider (D) | Eng A | -2 |
| VD-XXXX-6 | Cross-cutting (E) | Eng C | -2 |
| VD-XXXX-7 | Scenarios + CLI dir + migration (F + G) | Eng C | -4, -5, -6 |
| VD-XXXX-8 | Distribution prep (H) | Harness lead | all above |

### 9.4 Phase 1 dependencies (REVISED v4 — two gating spikes)

Two facts must be verified before any provider code lands. Both are
gating — abort/redesign if either fails.

1. **A.0 — OpenHands SDK 1.22.1 round-trips messages** with the shape
   we assume (LLM + Agent + Conversation + Tool[]). If not, redesign
   provider module layout before writing 5 modules around the wrong
   shape. ~1-2 days.
2. **A.0.B — Promptfoo `file://` provider option-shape** spike (added
   in v4; see §2.2 callout + §9.2 Step A.0.B). Verifies that a
   `config:` block in `promptfooconfig.json` is forwarded verbatim to
   `callApi(prompt, context, options)` as `options.config.*` —
   including nested objects/arrays, no flattening, no string coercion.
   If the shape differs, the §2.2/§2.6 bridge design is reworked
   (likely: move config into `vars`, or emit multiple provider URLs)
   before A.5 lands. ~0.5 day. Output:
   `plans/260522-1649-harness-plugin-contract-design/spike-promptfoo-file-shape.md`.

The v2 second spike ("Promptfoo supports `exec:` providers") is
removed in v3 — codex pass 2 BUG #1 forced the dispatch into a single
`file://scripts/framework/_node_bridge.js` URL anyway (read `node_modules/promptfoo/dist`
to confirm `file://` semantics), so the `exec:` question is moot. The
A.0.B file-provider option-shape spike replaces it.

Step ordering: A.0 and A.0.B may run in parallel (independent
concerns); both must pass before A.5 begins.

### 9.5 Backwards-compat strategy

| Concern | v1.0.0 approach |
| --- | --- |
| `feature/vd-2119` worktree | Stays unmerged. Out of scope. |
| Data-engineering current v0 layout | Migrate via `--migrate-from-v0`. v0 tier config form remains accepted by `eval-tier-config.js` for one minor cycle (deprecated in v1.1.0). |
| `openhands.json` in consumer repos | Not present (never on main). Skip. |
| `--hitl` flag | Not present. Skip. |

### 9.6 Kill switches (env vars only)

| Failure | Switch |
| --- | --- |
| Multi-turn hangs | `AD_EVALS_DISABLE_MULTI_TURN=1` |
| SDK pin regression | Revert `sdk-pins.toml`, ship v1.0.x patch |
| Scenarios cascade-fail | Quarantine with issue+expiry (Section 5.4) |
| Cleanup guard false-positive | `AD_EVALS_SKIP_CLEANUP_GUARD=1` (anti-pattern, documented) |
| Subprocess pool overrun | `AD_EVALS_MAX_CONCURRENCY=1` (serial mode) |
| Python adapter broken | Set tier to `opencode_cli` only — OpenHands SDK still optional |
| Promptfoo upstream breaks | Pin known-good in `package.json`, bump deliberately |

### 9.7 Success criteria

**Phase 1 (v1.0.0)**:
- [ ] Step A.0 spike passes (gating — OpenHands SDK shape)
- [ ] Step A.0.B spike passes (gating — Promptfoo `file://` option-shape)
- [ ] All 9 sub-issues closed, CI green
- [ ] `eval:scenarios:smoke` passes on PR
- [ ] `eval:scenarios` (full) passes 7/7 nightly runs in week-after-release
- [ ] Data-engineering `npm run eval:smoke` + `eval:regression` green on RC
- [ ] No P0/P1 issue in 2 weeks post-release
- [ ] Nightly CI cost <$0.10
- [ ] OpenCode CLI provider behavior locked by contract test
- [ ] OpenHands SDK provider passes Layer 3 mock-SDK tests (100%)

### 9.8 Risk register (REVISED with codex additions)

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| OpenHands SDK API ≠ inferred shape | M | H | **Step A.0 spike before architecture commit** |
| Python subprocess cold spawn >800ms | M | M | Step A.7 benchmark; pre-warm pool if needed |
| `uv` cache cold on every CI runner → slow first eval | H | M | `ad-evals doctor --install-providers` in CI setup step; `AD_EVALS_OFFLINE=1` for sandboxed runners with pre-baked cache |
| OpenCode CLI behavior regresses during refactor | M | H | **Lock with contract test BEFORE any change (C.13)** |
| Secrets leak through raw events / stderr / metadata | M | H | Secret redactor module (E.22) + opt-in raw events |
| Concurrency explosion → rate limits / OOM | M | M | Adapter-side semaphore (B.11), not config-only |
| Python missing on consumer host | M | M | `ad-evals doctor` preflight + clear error path |
| `--migrate-from-v0` corrupts working configs | L | H | Print diff, require confirmation, dry-run mode |
| Quarantine hides regressions silently | M | M | Issue+expiry mandatory; separate workflow alerts |
| CODEOWNERS treated as enforcement | M | L | Doc explicitly: CI gate is canonical |
| Live LLM key in PR CI (accidental) | L | H | PR workflow has no `secrets.*` access; live runs nightly only |
| `vars.turns` + `prompts:` conflict | L | L | Explicit precedence + warning (3.2) |
| SDK CVE in pinned version | L | var | Dependabot for npm + manual review for pyproject |
| Stub provider_kinds confuse consumers | L | L | **Don't register stubs in Phase 1**; only OpenCode CLI + OpenHands SDK |
| Two-runtime CI slow | M | L | ~20 min total acceptable |

### 9.9 Rollout cadence (revised)

| T+ | Event |
| --- | --- |
| 0 | Phase 1 sub-issues created; SDK + Promptfoo spikes start |
| 1w | Spikes complete (gating). Adjust spec if needed. |
| 2w | Foundation + IPC merged; benchmark numbers in |
| 3w | OpenCode CLI locked; dispatch + schema merged |
| 4w | OpenHands SDK provider merged; L3 tests green |
| 5w | Cross-cutting + scenarios + migration tool merged |
| 6w | Distribution merged; `v1.0.0-rc.1` tagged |
| 6w+3d | data-engineering migrates on RC, 3-day soak |
| 7w | `v1.0.0` published to npm `latest` |
| 7w-9w | Monitor + patch P0/P1 |
| 9w | Start Phase 2 (Claude Agent SDK + `--compare`) |

### 9.10 Communication

| Audience | Channel | When |
| --- | --- | --- |
| Engineering team | #engineering Slack | Phase 1 kickoff, RC, GA, Phase 2 start |
| Data-engineering team | Direct DM + PR review | Before their migration PR |
| Future plugin teams | `docs/setup.md` + `README.md` | Before v1.0.0 publish |
| Contributors | `CONTRIBUTING.md` + `CHANGELOG.md` | Every release |

### 9.11 Explicit non-deliveries

| Deferred | Why |
| --- | --- |
| 4 providers in Phase 1 | Risk concentration; start with 1 SDK + preserve CLI |
| `--compare` flag | Only 1 SDK provider in Phase 1 — fan-out has no value yet |
| Phase 2-4 stubs in Phase 1 | Confusing failures; don't register until implemented |
| Contract YAML generator | YAGNI for 1-2 providers; hand-write |
| 10 scenarios | 3 are enough to lock current behavior + new contract (see §5.1) |
| Cost dashboards | Premature without ≥3 providers |
| Per-consumer SDK override | Security risk; one global pin |
| Auto-discovery of SDK tools | Magic; explicit registry only |

---

## Appendix A — File inventory (REVISED)

### A.1 New files (Phase 1) — REVISED v3

```text
scripts/framework/providers/_contract.py
scripts/framework/providers/_contract.ts
scripts/framework/providers/_python_adapter.py
scripts/framework/_node_bridge.js                       (Promptfoo provider face; in-process dispatch + subprocess IPC + semaphore)
scripts/framework/_node_bridge.workspace.test.js        (L3 integration test for workspace cleanup, replaces deleted workspace-cleanup-guard L4 scenario)
scripts/framework/providers/openhands_sdk/{__init__,provider,agent_factory,tool_registry,model_resolver,event_extractor}.py
scripts/framework/concurrency.js                        (semaphore primitive used by _node_bridge.js)
scripts/framework/migrate-from-v0.js
scripts/framework/secret-redactor.js
scripts/framework/secret_redactor.py
scripts/framework/structured-logger.js
scripts/framework/validate-package-config.js           (was wrongly listed as "modified" in v1)
config/sdk-pins.toml
pyproject.toml
uv.lock
docs/provider-contract.md
tests/harness-scenarios/config/eval-tiers.toml
tests/harness-scenarios/packages/{minimal-smoke,opencode-cli-compatibility,openhands-mock-multi-turn}/...
bench/spawn-cost.js                                     (Step A.7 benchmark — cold-spawn / per-turn cost)
bench/parallel-throughput/                              (parallelism benchmark — moved from L4 scenarios; harness folder with config + driver)
.github/workflows/harness-scenarios.yml
.github/workflows/publish.yml
CHANGELOG.md
MIGRATION-v0-to-v1.md
templates/eval-boundary.yml
templates/.github/dependabot.yml
```

**Dropped from v2 → v3:**
- `scripts/framework/workspace-guard.js` — folded into existing
  `run-promptfoo-with-guard.js` (§7.3 v3 rewrite).
- `tests/harness-scenarios/packages/workspace-cleanup-guard/` — was a
  live-LLM L4 scenario; replaced by the deterministic L3 test
  `_node_bridge.workspace.test.js`.

### A.2 Modified files

```text
scripts/framework/eval-tier-config.js          (accept v0 + v1 forms)
scripts/framework/resolve-promptfoo-config.js  (emit single file://scripts/framework/_node_bridge.js URL with config.provider_kind)
scripts/framework/opencode-cli-provider.js     (expose as provider_kind=opencode_cli; behavior unchanged; require()'d by _node_bridge.js — see C.14)
scripts/framework/run-promptfoo-with-guard.js  (v3 — add post-run assertion that .tmp/workspaces/<run_id>/ is empty)
bin/ad-evals.js                                (doctor + --install-providers; structured logging; run <dir> walk)
bin/eval-harness-init.sh                       (--migrate-from-v0)
templates/package.json                         (npm scripts; remove HITL refs if any)
docs/setup.md                                  (add SDK provider section; no HITL refs)
docs/design.md                                 (refresh architecture for adapter + dispatch)
README.md                                      (compatibility matrix)
package.json                                   (Promptfoo pin)
```

### A.3 Deleted files

**None.** Main has no OpenHands/HITL files to delete.

### A.4 Files explicitly NOT included from `feature/vd-2119`

The unmerged branch contains files we are NOT pulling forward:
- `openhands-provider.js`, `openhands-supervisor.js`, their tests
- `hitl-broker.js`, `hitl-client.js`, `hitl-ui/`, gate-marker code
- `templates/openhands.json`

These are out of scope for v1.0.0. The branch remains in git history as
reference only.

---

## Appendix B — Open Questions (resolved during brainstorm)

| Q | Resolution |
| --- | --- |
| Multi-turn API shape? | `vars.turns: [...]` scripted (chosen by user) |
| Provider language? | Native per SDK (chosen by user) |
| Scope of Phase 1? | Narrowed: OpenCode CLI preserve + OpenHands SDK only |
| OpenCode CLI provider fate? | **Preserve as `provider_kind = "opencode_cli"` — primary production flow** |
| HITL revival? | No — non-goal in v1.0.0 |
| Backwards-compat with `feature/vd-2119`? | No — branch stays unmerged, files never on main |
| Per-repo SDK override? | No — global pin only |
| Auto-tool-discovery? | No — explicit registry only |
| `--compare` in v1.0.0? | Deferred to v1.1.0 (needs ≥2 SDKs) |
| Cross-language YAML contract generator? | Deferred to v1.3.0 |

---

## Appendix C — Glossary

| Term | Meaning |
| --- | --- |
| **Harness** | `@accelerate-data/promptfoo-eval-harness` npm package |
| **Consumer** | A repo that installs the harness (e.g., `data-engineering`) |
| **Plugin / Provider** | An SDK-backed (or CLI-backed) implementation of the 4-method contract |
| **`provider_kind`** | Identifier for which plugin to load (`openhands_sdk`, `opencode_cli`, etc.) |
| **Adapter** | The subprocess bridge that runs the provider (`_python_adapter.py` or `_node_bridge.js`) |
| **Litellm slug** | `provider/model-name` format, e.g., `anthropic/claude-sonnet-4-6` |
| **Tier** | Named bundle of `[providers + runtime params]` (`light`, `standard`, `high`, `x_high`) |
| **Scenario** | An eval package inside `tests/harness-scenarios/` |
| **Cleanup guard** | Existing module that fails the run if files outside artifact roots are written |
| **Workspace guard** | (Phase 1) NOT a standalone module. The post-run assertion lives as one branch inside the existing `run-promptfoo-with-guard.js` cleanup-guard module (§7.3, §9.2 Step E.24). A dedicated `workspace-guard.js` module was originally scoped but deferred to Phase 1.x — implementation ownership stays with whoever owns `run-promptfoo-with-guard.js`. |
| **IPC** | Inter-process communication — NDJSON over stdio between Node bridge and Python/Node adapter |

---

## Appendix D — Codex review responses (audit trail)

This spec v2 incorporates feedback from `codex review` run on
2026-05-22 against spec v1. Summary of changes:

| Codex finding | Section addressed |
| --- | --- |
| OpenCode CLI dropped | §0.5, §1, §2.2, §5.1, §6.3, §7.4, §A.2 |
| Phase 1 scope contradicts compatibility matrix | §0.1, §0.2 (Phase 1 = OpenCode CLI + OpenHands SDK only) |
| Cleanup inventory wrong (files not on main) | §0.5, §A.3 (no deletions), §A.4 (explicit non-inclusions) |
| `call_api()` duplicate-turn bug | §2.6 (uses `turn_index` from loop) |
| `shutdown` after failed init | §2.6 (session=None guard) |
| `error` shape inconsistency | §1.5, §2.6 (Promptfoo `error: string`, structured copy in metadata.provider_error) |
| Node providers don't go through Python adapter | §2.2 dispatch table, §A.1 (separate _node_bridge.js) |
| Framework can't enforce concurrency via config | §4.2 (adapter-side semaphore) |
| IPC design missing | §2.3 + §2.4 (new section) |
| Python packaging missing | §6.3 (new section) |
| Secret handling missing | §7.1 (new section) |
| Observability missing | §7.2 (new section) |
| OpenCode CLI compatibility missing | §7.4 + §C.13 lock test |
| Workspace lifecycle missing | §7.3 (new section) |
| Tool permissions missing | §1.6 (new section) |
| Multi-turn prompt precedence | §3.2 |
| Transitive deps/CVEs | §6.4, §9.8 risk register |
| `provider_kind` dispatch ambiguity | §2.2 dispatch table |
| Tier schema migration ambiguity | §4.4 (v0 + v1 both accepted) |
| `--compare` semantics | §7.5 (defined, deferred to Phase 2) |
| `label` uniqueness | §4.3 validation rules |
| `cost_usd` source | §1.5 (nullable) |
| `raw_events` bounds | §7.1 (opt-in artifact, gitignored) |
| Live keys contradiction | §0.4, §8.6 (PR vs nightly workflow split) |
| YAML generator over-engineered | §1 (hand-written, generator deferred) |
| Phase 2-4 stubs over-engineered | §0.2, §9.11 (no stubs in Phase 1) |
| 10 scenarios over-engineered | §5.1 (cut to 4 in v2, then to 3 in v3) |
| sdk-version-canary over-engineered | §5.1 (deferred) |
| `--compare` over-engineered for Phase 1 | §4.1, §7.5 (deferred) |
| L2 25×4 contract over-engineered | §8.1 (hand-written per language) |
| SDK spike not gating | §9.2 Step A.0 (gating) |
| Promptfoo `python:` unverified | v2: §9.2 Step A.1 (gating) — superseded in v3 by single-bridge dispatch via `file://scripts/framework/_node_bridge.js` (see §2.2 + §9.4); the file-provider option-shape check is now Step A.0.B in §9.2. |
| OpenCode CLI compat as Phase 1 priority | §0.1 Goal 2, §C |
| Quarantine hiding regressions | §5.4 (issue+expiry+separate workflow) |
| CODEOWNERS as enforcement | §6.5 (CI gate is canonical) |
| Python install break on consumers | §6.3 doctor checks |
| `turns_completed` vs `turns` naming | §1.2, §3.5 (canonical `turns_completed`) |
| "in-process SDK" misleading wording | §2.1 (clarified) |
| `ProviderError.message` sanitization | §1.3, §7.1 |
| `tools: list[str]` shape | §1.6 (permissions object) |
| `timeout_per_turn_s` location | §1.2 (ProviderConfig only; tier value is default source) |
| `validate-package-config.js` doesn't exist | Listed as new file in §A.1 + created in §9.2 Step B.11 |

### Appendix D.v3 — Codex review pass 2 (2026-05-22) responses

Pass 2 ran against spec v2 and returned *not approved*. Findings and
where each is addressed in v3:

| Codex pass 2 finding | Severity | Section addressed |
| --- | --- | --- |
| Dispatch uses Promptfoo `exec:` but design assumes a persistent stdin loop — `ScriptCompletionProvider` runs single-shot with prompt-as-argv | BUG | §2.2 + §2.6 (all kinds via single `file://scripts/framework/_node_bridge.js`); §9.4 (second spike dropped); v3 header note |
| `openhands-sdk==1.23.0` + Python `>=3.10,<3.13` invalid (PyPI: 1.22.1, requires `>=3.12`) | BUG | §6.3 + §6.4 + §6.7 pin/matrix updated; v3 header note |
| §7.3 workspace guard logic impossible ("file outside is moved/deleted") | BUG | §7.3 rewritten — subprocess `cwd`=workspace, bridge `finally` removes, existing guard verifies empty post-run; dedicated `workspace-guard.js` deferred |
| §A.1 said `validate-package-config.js` lives there but it was only in §9.2 B.12 | BUG | §9.2 Step B.11 explicitly creates it; §A.1 lists as new file; Appendix D row above updated |
| `ad-evals run tests/harness-scenarios/packages` needs CLI to accept a directory — no implementation step | MISSING | §5.3 directory semantics + §9.2 Step G.28 |
| Semaphore would not cap OpenCode CLI fan-out (was a direct file provider) | MISSING | §2.6 + §4.2 — bridge wraps every callApi (opencode_cli too) |
| Multi-turn `output` shape was ambiguous for assertions | AMBIGUITY | §3.2.1 — joined transcript + `metadata.final_turn_output` + `metadata.transcript` |
| Env allowlist source vague (`*_API_KEY` only) | AMBIGUITY | §7.1 broadened pattern set + per-provider_kind `env_allowlist` in `config/sdk-pins.toml` (§6.4) |
| `workspace-cleanup-guard` as a live-LLM L4 scenario is over-engineered | OVER-ENGINEERING | §5.1/§5.2 dropped from L4; replaced by L3 `_node_bridge.workspace.test.js` |
| `uv run` cold-cache cost coupled to every invocation | RISK | §6.3 `ad-evals doctor --install-providers` pre-warm + `AD_EVALS_OFFLINE=1`; §9.8 risk row added |
| §2.2 said "Step A.0" but §9.2 numbered it A.1 | NIT | §9.2 renumbered, A.0 = SDK spike, A.1 = pyproject |

### Appendix D.v4 — Codex review pass 3 (2026-05-22) responses

Pass 3 ran against spec v3 and returned *not approved* with 4 BUGS,
2 MISSING, 2 AMBIGUITIES, 1 RISK, 2 NITS. v4 surgical edits address each:

| Codex pass 3 finding | Severity | Section addressed |
| --- | --- | --- |
| §0.1/§5.1/§5.2/§8.1/§9.1/§9.11 still disagree on scenario count — referenced 4 incl. dropped `workspace-cleanup-guard` + nonexistent migration smoke | BUG | §0.1 Goal 6 rewritten with 3 named scenarios; §8.1, §9.1, §9.11, Appendix D row, header CHANGES count all aligned to 3 |
| §6.3/§2.6 install `openhands-sdk==1.22.1` bare while §6.4 declares `extras = ["tools"]` | BUG | §6.4 changed to `extras = []`; A.0 spike confirms extras; note added that ALL `uv run --with` invocations track this single source |
| §8.6 CI matrix `python: ['3.10', '3.12']` contradicts `>=3.12` requirement | BUG | §8.6 matrix updated to `['3.12', '3.13']` with rationale |
| §7.3 KEEP_WORKSPACE preserved workspace but post-run guard fails if dir is left | BUG | §7.3 — KEEP_WORKSPACE=1 skips bridge cleanup AND post-run assertion; logs warning |
| §2.6 builds `final_turn_output` but no `transcript`, despite §3.2.1 making it canonical | MISSING | §2.6 — `transcript` array now built per turn and returned in success and error paths |
| §2.6 error path missing canonical metadata (provider_kind, label, sdk_version, run_id, case_id, latency_ms_*) | MISSING | §2.6 — new `baseMetadata(cfg, extra)` helper used by every return path; latency tracking added |
| §4.3 says registry lives in `_dispatch.{py,ts}` but v3 dispatch routes through `_node_bridge.js`/`adapterCmd` | AMBIGUITY | §4.3 — registry name corrected to `KIND_REGISTRY` in `_node_bridge.js`; explicit note no separate `_dispatch.{py,ts}` registry exists |
| §5.3 says directory-run lives in G.31; §9.2 says G.28 | AMBIGUITY | §5.3 — directory-run implementation pinned to G.28; G.31 = migration wiring |
| §2.2 bridge contract depends on Promptfoo `options.config.*` shape but no spike verifies it | RISK | §2.2 — critical-assumption callout added; §9.2 — new Step A.0.B gating spike (`spike-promptfoo-file-shape.md`) gates A.5 and all later work |
| Header CHANGES claimed `validate-package-config.js` lives in §9.2 B.12; D.v3 said B.11; §9.2 had both | NIT | Header CHANGES corrected to B.11; §9.2 B.12 row removed (was placeholder); B.11 expanded with concrete responsibilities |
| Appendix D rows "cut to 4" and "Promptfoo `python:` unverified" stale post-v3 | NIT | Appendix D row updated to "cut to 4 in v2, then to 3 in v3"; Promptfoo `python:` row already marked superseded |

---

### Appendix D.v5 — Codex review pass 4 (2026-05-22) responses

Pass 4 ran against spec v4 and returned *not approved* with 1 BUG,
2 MISSING, 2 AMBIGUITY, 1 RISK, 1 NIT. v5 surgical edits address each:

| Codex pass 4 finding | Severity | Section addressed |
| --- | --- | --- |
| §2.6 opencode_cli error path + spawn/IPC exceptions bypassed `baseMetadata` | BUG | §2.6 — opencode_cli branch wraps every return via `baseMetadata`; new `errorReturn(...)` helper handles spawn/IPC/init exceptions in the SDK branch's `catch` |
| §2.6 transcript skipped erroring turn when no partial text | MISSING | §2.6 — transcript entry pushed unconditionally for the erroring turn (empty `output` ok, carries `error` marker) |
| §9.4 still said "single Step A.0 spike", omitted A.0.B | MISSING | §9.4 — both A.0 and A.0.B listed as gating; may run in parallel; both must pass before A.5 |
| `_node_bridge.js` path inconsistent (`scripts/framework/` vs `scripts/framework/providers/`) | AMBIGUITY | Header CHANGES v4-#7 + §4.3 corrected to `scripts/framework/_node_bridge.js` (the canonical path used everywhere else) |
| `parallel-throughput` benchmark placement conflict (§2.5 vs §5.1) | AMBIGUITY | §2.5 updated — benchmark now lives in `bench/parallel-throughput/`, not in L4 scenarios |
| Appendix C "Workspace guard" entry misleading vs §7.3 deferral | RISK | Appendix C rewritten — explicitly states the standalone module is deferred, Phase 1 work is one branch in `run-promptfoo-with-guard.js`, ownership stays there |
| Footer "End of design doc v3" in v4 spec | NIT | Footer bumped to v5 |

---

### Appendix D.v6 — Codex review pass 5 (2026-05-22) responses

Pass 5 ran against spec v5 and returned *not approved* with 1 BUG,
2 MISSING, 3 AMBIGUITY, 1 RISK. v6 surgical edits address each:

| Codex pass 5 finding | Severity | Section addressed |
| --- | --- | --- |
| §2.6 transcript invariant violated on 4 error paths (`opencode_cli` multi-turn reject, `opencode_cli` caught exception, SDK empty-turn validation, SDK mid-turn IPC exception) | BUG | §2.6 — `pushTurn` helper added; multi-turn-reject pushes one entry per attempted turn; opencode_cli caught exception pushes entry for the attempted turn before `errorReturn`; SDK validation path retains empty transcript (no attempted turns = 0 entries, which is correct); SDK try/catch now tracks `attemptedIndex`/`attemptedInput`/`attemptedStart` and pushes the mid-flight turn in the catch block before calling `errorReturn` |
| §9.7 success criteria gated only A.0 — A.0.B missing | MISSING | §9.7 — explicit `Step A.0.B spike passes (gating)` checklist row added; sub-issue count bumped 8 → 9 |
| §9.3 sub-issues only tracked Spike A.0 (`-1`); A.0.B had no sub-issue | MISSING | §9.3 — new `VD-XXXX-1B` row for Spike A.0.B; Foundation + IPC (`-2`) dependency updated to "-1 AND -1B" |
| §3.2.1 transcript schema (`message`/`text`) vs §2.6 (`input`/`output`/`latency_ms`/`error`) | AMBIGUITY | §3.2.1 transcript entry schema aligned to §2.6: `{turn_index, input, output, latency_ms, tool_calls, error?}` with explicit invariant: one entry per attempted turn; `error` iff that turn failed |
| `file://_node_bridge.js` shorthand vs canonical `file://scripts/framework/_node_bridge.js` (§9.2 B.9, §9.4, §A.2, header CHANGES, Appendix D rows) | AMBIGUITY | All 5 remaining shorthand refs canonicalized to `file://scripts/framework/_node_bridge.js` |
| Benchmark path: §2.5 `bench/parallel-throughput/` vs §A.1 `bench/spawn-cost.js` | AMBIGUITY | §A.1 now lists BOTH as distinct files with role annotations: `spawn-cost.js` (Step A.7 cold-spawn), `parallel-throughput/` (parallelism benchmark moved from L4) |
| §8.2 still listed orphan `scripts/framework/workspace-guard.test.js`; §7.3 / §9.2 E.24 / §A.1 say canonical name is `_node_bridge.workspace.test.js` | RISK | §8.2 renamed to `scripts/framework/_node_bridge.workspace.test.js` with cross-ref `(per §7.3, §9.2 E.24)` |

---

### Appendix D.v7 — Codex review pass 6 (2026-05-22) responses

Pass 6 ran against spec v6 and returned *not approved* with 1 BUG and
1 AMBIGUITY (down from 7 findings in pass 5). v7 surgical edits address
each:

| Codex pass 6 finding | Severity | Section addressed |
| --- | --- | --- |
| §2.6 / §3.2 empty `vars.turns: []` fell through `[] || [prompt]` to `provider.callApi(undefined)` in opencode_cli branch | BUG | §2.6 — introduced explicit `hasTurns = Array.isArray(...) && length > 0` check in BOTH opencode_cli and SDK branches; new validation-error path catches "no turns to send" in opencode_cli; SDK branch also tightened to reject undefined/empty single turn |
| §2.5 / §9.2 / §A.1 benchmark ownership inconsistent — §2.5 said "Step A.0 benchmark" and named `bench/parallel-throughput/`; §9.2 says A.7; §A.1 says A.7 → `bench/spawn-cost.js` | AMBIGUITY | §2.5 rewritten — cold-spawn target now references Step A.7; lists both `bench/spawn-cost.js` (required gating, cold-spawn) and `bench/parallel-throughput/` (optional parallelism) as distinct artifacts with explicit roles |

*End of design doc v7.*

---

### Appendix D.v8 — Codex review pass 7 (2026-05-22) responses

Pass 7 ran against spec v7 and returned *not approved* with 1 BUG and
0 other findings (down from 7 in pass 5, 2 in pass 6). v8 surgical edit:

| Codex pass 7 finding | Severity | Section addressed |
| --- | --- | --- |
| §2.6 opencode_cli could still reach `provider.callApi(undefined)` because v7 only guarded `length === 0` — when `vars.turns: []` AND `prompt` is undefined, fallback `[prompt]` produces `[undefined]`, length 1, slips through | BUG | §2.6 — added `noUsableTurn` predicate that also rejects `length === 1 && turns[0]` undefined/null/empty; applied identically in both opencode_cli and SDK branches |

*End of design doc v8.*
