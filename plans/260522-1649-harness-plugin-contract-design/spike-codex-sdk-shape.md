# Codex SDK Shape Spike — Node/TypeScript Verification

> **Spike:** VD-2174-4 (Step A.0 for Phase 4)
> **Date:** 2026-05-23
> **SDK:** `@openai/codex-sdk@0.133.0` (latest stable)
> **Node:** ≥18 (verified via npm)
> **Source:** OpenAI official [SDK repo](https://github.com/openai/codex), [npm package](https://www.npmjs.com/package/@openai/codex-sdk)

---

## VERDICT: PASS — CODEX SDK SHAPE CONFIRMED FOR PHASE 4

The Codex SDK (Node/TypeScript) exists as a published npm package (`@openai/codex-sdk@0.133.0`)
and ships with a well-defined, documented API surface. The SDK is **NOT** a wrapper around the CLI
but a **first-class Node SDK** that spawns the Codex CLI internally and exchanges JSONL events
over stdin/stdout. This is **critically different** from the OpenCode SDK pattern (which is also
a Node SDK): Codex SDK owns the CLI invocation internally, whereas our Node adapter pattern
assumes the adapter owns subprocess spawning. **Architecture decision required at end of spike.**

**Live test:** Not conducted (no API key in spike environment), but SDK shape is fully documented
and importable.

---

## 1. SDK Metadata (Verified)

| Property | Value | Source |
|---|---|---|
| **npm package name** | `@openai/codex-sdk` | [npm registry](https://www.npmjs.com/package/@openai/codex-sdk) |
| **Latest stable version** | `0.133.0` | `npm view @openai/codex-sdk dist-tags.latest` |
| **Node version range** | `>=18` | `npm view @openai/codex-sdk@0.133.0 engines.node` |
| **Peer dependency** | `@openai/codex@0.133.0` (CLI) | `npm view @openai/codex-sdk@0.133.0 dependencies` |
| **TypeScript types** | Included (`dist/index.d.ts`) | `npm view @openai/codex-sdk@0.133.0 exports` |
| **Install command** | `npm install @openai/codex-sdk` | [GitHub README](https://github.com/openai/codex/tree/main/sdk/typescript) |
| **Deprecation status** | **LIVE agentic tool** (NOT the deprecated text-completion Codex model from 2021-2023) | [OpenAI Codex product page](https://developers.openai.com/codex) |

**Key distinction:** Codex (2025) is a **modern agentic coding assistant** that spawns the CLI,
executes tools (file editor, terminal, MCP), and returns structured events. It is **NOT** the
deprecated `text-davinci-003`-based Codex completion API (sunset 2023).

---

## 2. Architecture: SDK-Owns-CLI vs. Adapter-Owns-CLI

**Critical finding for Phase 4 design:**

The Codex SDK follows a **fundamentally different pattern** from the target contract:

```
SPEC PATTERN (OpenCode, OpenHands):
  adapter spawns SDK subprocess
  adapter talks to SDK (via Python/Node imports)
  
CODEX SDK ACTUAL PATTERN:
  SDK spawns Codex CLI subprocess internally
  adapter imports SDK
  SDK owns CLI I/O + event parsing
  adapter talks to SDK object methods (run(), runStreamed())
```

**Impact:** The Node adapter will **import the Codex SDK, not spawn a subprocess.**
The SDK instance wraps the CLI internally. This means:

1. The Node adapter workflow becomes simpler — no NDJSON parsing of subprocess I/O needed.
2. The provider can be used in-process (NOT as a separate `scripts/framework/providers/codex_sdk/` subprocess).
3. Per-provider concurrency (spec §1085) must lock at the SDK level, not subprocess level.

---

## 3. Agent Factory & Session Creation

### Minimal TypeScript Example

```typescript
// scripts/framework/providers/codex_sdk/agent_factory.ts
import { Codex, Thread } from "@openai/codex-sdk";
import type { ProviderConfig } from "../_contract";

export async function buildAgent(cfg: ProviderConfig): Promise<Thread> {
  const codex = new Codex({
    apiKey: process.env.OPENAI_API_KEY,  // or from cfg.extra if overridden
    baseUrl: process.env.OPENAI_BASE_URL,
    env: {
      // Filtered per sdk-pins.toml env_allowlist
      PATH: process.env.PATH,
      // ... other allowed env vars
    },
    config: {
      // Optional CLI config overrides from cfg.extra.cli_config
      show_raw_agent_reasoning: cfg.extra?.show_raw_agent_reasoning ?? false,
    },
  });

  const thread = codex.startThread({
    workingDirectory: cfg.workspace_root,
    skipGitRepoCheck: false,  // Enforce Git repo requirement
    model: cfg.model,  // e.g. "gpt-4o" or "o1-preview"
    sandboxMode: cfg.permissions?.sandbox_mode ?? "workspace-write",
    modelReasoningEffort: cfg.extra?.reasoning_effort ?? "medium",
  });

  return thread;
}
```

### Constructor Arguments

- `apiKey`: OPENAI_API_KEY (required, from env)
- `baseUrl`: Optional API override
- `env`: Environment variables for CLI (filtered per allowlist)
- `config`: Flat object passed as `--config key=value` flags to CLI

### Thread Creation

- `startThread(options?)` returns a `Thread` object
- `workingDirectory`: Absolute path (from `cfg.workspace_root`)
- `skipGitRepoCheck`: Should be `false` by default (enforce Git requirement)
- `model`: Model string (passed to CLI via `--model`)
- `sandboxMode`: One of `"read-only" | "workspace-write" | "danger-full-access"`
- `modelReasoningEffort`: One of `"minimal" | "low" | "medium" | "high" | "xhigh"`

---

## 4. Tool Registry API

**CRITICAL ARCHITECTURAL NOTE:** Codex SDK does **NOT** have a traditional "tool registry" like OpenHands SDK.

### Codex Built-in Tools (Implicit)

The Codex CLI ships with built-in tools that are **automatically available** when the thread runs:

- `file_editor`: Edit, create, delete files
- `terminal`: Execute shell commands
- `mcp`: MCP (Model Context Protocol) tool invocation
- `web_search`: Web search queries
- `artifacts`: Code/output storage

### No Tool Configuration in SDK Layer

Unlike OpenHands SDK (`register_tool()` pattern), Codex does **not** expose tool registration in the TypeScript SDK.
Tools are:

1. **Built-in to the CLI** and always available
2. **Configured via CLI flags** (passed through `config` option or `--config` flags)
3. **MCP tools discovered dynamically** by the CLI at runtime

**Implication for harness:** The `tools` array in `ProviderConfig` is advisory/documentation only.
The adapter passes it as metadata but cannot control which tools are available — the CLI decides.
Tool filtering/control would need to happen at the CLI config level (sandboxMode, approval policies, etc.).

---

## 5. Event Stream & Response Shape

### Multi-turn Message Flow

```typescript
// scripts/framework/providers/codex_sdk/event_extractor.ts
import type { Thread, ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { TurnResult, ToolCallRecord } from "../_contract";

export async function extractTurnResult(
  thread: Thread,
  message: string,
): Promise<TurnResult> {
  try {
    const turn = await thread.run(message);

    // Extract text from agent message items
    const text =
      turn.items
        .filter((item) => item.type === "agent_message")
        .map((item) => item.text)
        .join("\n") || "";

    // Extract tool calls from MCP/command/file items
    const toolCalls = extractToolCalls(turn.items);

    return {
      text,
      tool_calls: toolCalls,
      error: null,
    };
  } catch (err) {
    return {
      text: "",
      tool_calls: [],
      error: {
        code: classifyError(err),
        message: sanitizeErrorMessage(err),
        retryable: isRetryable(err),
      },
    };
  }
}

function extractToolCalls(items: ThreadItem[]): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];

  for (const item of items) {
    if (item.type === "command_execution") {
      records.push({
        name: "terminal",
        arguments: { command: item.command },
        result_truncated: (item.aggregated_output || "").slice(0, 1024),
        error:
          item.status === "failed" && item.exit_code
            ? `exit code ${item.exit_code}`
            : undefined,
      });
    } else if (item.type === "file_change") {
      records.push({
        name: "file_editor",
        arguments: {
          changes: item.changes,
        },
        result_truncated: item.status === "completed" ? "OK" : "FAILED",
        error: item.status === "failed" ? "Patch failed" : undefined,
      });
    } else if (item.type === "mcp_tool_call") {
      records.push({
        name: item.tool,
        arguments: item.arguments as Record<string, unknown>,
        result_truncated: item.result ? JSON.stringify(item.result).slice(0, 1024) : "",
        error: item.error?.message,
      });
    } else if (item.type === "web_search") {
      records.push({
        name: "web_search",
        arguments: { query: item.query },
        result_truncated: "OK",
      });
    }
  }

  return records;
}
```

### Event Stream (Async Generator)

**Streaming alternative (non-buffering):**

```typescript
// For real-time event handling:
const { events } = await thread.runStreamed(message);

for await (const event of events) {
  switch (event.type) {
    case "turn.started":
      // Turn begins
      break;
    case "item.started":
    case "item.updated":
    case "item.completed":
      // Process intermediate items
      break;
    case "turn.completed":
      // Turn finishes, usage available
      console.log(event.usage);
      break;
    case "turn.failed":
      // Error occurred
      console.error(event.error.message);
      break;
    case "error":
      // Stream-level error
      console.error(event.message);
      break;
  }
}
```

### Response Shape (Turn)

```typescript
type Turn = {
  items: ThreadItem[];  // All items processed during turn
  finalResponse: string;  // Last agent_message.text
  usage: Usage | null;  // Token usage if available
};

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};
```

---

## 6. Multi-turn Semantics

### Session Persistence

```typescript
// Thread is the session container (like LocalConversation in OpenHands)
const thread = codex.startThread();

// Multiple turns on same thread
const turn1 = await thread.run("Diagnose the issue");
const turn2 = await thread.run("Implement the fix");  // Same context as turn1

// Thread ID persists and can be resumed later
const threadId = thread.id;  // Populated after first turn
const resumedThread = codex.resumeThread(threadId);
await resumedThread.run("Continue from here");
```

### Conversation State

- **First-class Thread object** — maintains conversation history
- **Stateful** — calling `run()` multiple times accumulates context
- **Resumable** — thread ID can be stored and resumed via `codex.resumeThread(id)`
- **No explicit conversation reset** — each `run()` appends to history

**Implication for harness:** Each test case gets a fresh `Thread` instance (per case isolation, spec §7.3).
Multi-turn is supported via repeated `thread.run()` calls on the same instance.

---

## 7. Error Taxonomy & Retryable Patterns

### SDK Error Handling

```typescript
// Error classification for Codex SDK
export function classifyError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    // Network/rate limit
    if (msg.includes("429") || msg.includes("rate limit")) return "rate_limit";

    // Authentication
    if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized"))
      return "auth";

    // Timeout
    if (msg.includes("timeout") || msg.includes("exceeded")) return "timeout";

    // Workspace/SDK error
    if (msg.includes("git repository") || msg.includes("workspace"))
      return "workspace_error";

    // Tool execution error
    if (msg.includes("command failed") || msg.includes("tool error"))
      return "tool_error";
  }

  return "sdk_error";
}

export function isRetryable(err: unknown): boolean {
  const code = classifyError(err);
  return ["rate_limit", "timeout"].includes(code);
}
```

### Async Cancellation

```typescript
// Codex SDK supports AbortSignal via turnOptions
const controller = new AbortController();

// Cancel turn if it takes too long
const timeoutId = setTimeout(() => controller.abort(), 300_000); // 5 min

try {
  const turn = await thread.run(message, { signal: controller.signal });
} catch (err) {
  if (err instanceof Error && err.name === "AbortError") {
    return {
      code: "timeout",
      message: "Turn execution exceeded timeout",
      retryable: true,
    };
  }
  throw err;
} finally {
  clearTimeout(timeoutId);
}
```

---

## 8. Mock SDK Strategy

### Node Mock Pattern (Cross-reference OpenCode SDK spike)

```typescript
// tests/_mock_provider/codex-sdk.ts
export class MockCodex {
  startThread() {
    return new MockThread();
  }
}

export class MockThread {
  async run(input: string): Promise<Turn> {
    // Deterministic, fast response
    return {
      items: [
        {
          id: "msg-1",
          type: "agent_message",
          text: `Mock response to: ${input.slice(0, 50)}`,
        },
      ],
      finalResponse: `Mock response to: ${input.slice(0, 50)}`,
      usage: {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    };
  }

  async runStreamed(input: string) {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "mock-thread-1" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: { id: "msg-1", type: "agent_message", text: "Mock" },
      },
      {
        type: "item.completed",
        item: {
          id: "msg-1",
          type: "agent_message",
          text: `Mock: ${input.slice(0, 50)}`,
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    ];

    async function* generateEvents() {
      for (const event of events) {
        yield event;
      }
    }

    return { events: generateEvents() };
  }
}

// Inject mock at test time
jest.doMock("@openai/codex-sdk", () => ({
  Codex: MockCodex,
}));
```

### Mock at Test Time

```typescript
// Integration test (L3, mock SDK)
import { Codex } from "@openai/codex-sdk";

// Mock injected by jest.doMock() before import
const codex = new Codex();  // Returns MockCodex instance
const thread = codex.startThread();
const turn = await thread.run("Test prompt");  // Fast, deterministic

expect(turn.finalResponse).toContain("Mock");
```

---

## 9. Provider Tree Mapping — Node Files

For each of the 4 Python modules in `scripts/framework/providers/openhands_sdk/`, propose
equivalent Node/TypeScript modules in `scripts/framework/providers/codex_sdk/`:

| Python Module | Node/TS Equivalent | 1-Paragraph Purpose |
|---|---|---|
| `model_resolver.py` | `model_resolver.ts` | Resolve litellm slug (e.g. `anthropic/claude-sonnet-4-6`) to Codex `model` parameter. Codex accepts bare model strings like `gpt-4o` or `o1-preview`. The resolver must map framework slugs to Codex-compatible strings or pass-through if already compatible. Validates model is supported by Codex CLI. |
| `event_extractor.py` | `event_extractor.ts` | Extract `TurnResult` (text, tool_calls, error) from Codex SDK's Turn object and async event stream. Codex items (agent_message, command_execution, file_change, mcp_tool_call, etc.) map to our ToolCallRecord union. Sanitizes error messages per spec §7.1. |
| `tool_registry.py` | `tool_registry.ts` | Declarative registry of available tools. In Codex, tools are built-in (terminal, file_editor, web_search, mcp). This module documents which tools are safe to use and provides metadata (name, description, required env vars). No tool registration happens here — the SDK's CLI owns tool availability. |
| `agent_factory.py` | `agent_factory.ts` | Factory to construct a Codex SDK instance and Thread. Takes ProviderConfig (model, workspace, permissions, etc.) and returns a Thread ready for turns. Sets up environment filtering per allowlist, applies CLI config overrides, and enforces workspace constraints (Git repo, sandbox mode). |

---

## 10. Per-Provider Concurrency Cap Design (Phase 4 Bonus)

### Proposed Schema

```typescript
// config/sdk-pins.toml
[codex_sdk]
version = "0.133.0"
node = ">=18"
# CLI shipped as peer dep
cli_version = "0.133.0"

# Per-provider concurrency cap (Phase 4, §1085)
max_concurrent_threads = 2

# Env allowlist (spec §7.1)
env_allowlist = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "PATH",
  "HOME",
]
```

### Enforcement Point (Node Bridge)

```typescript
// scripts/framework/_node_bridge.js (or concurrent.js refactor)

class CodexSDKProvider {
  private semaphore: PLimit;

  constructor(options) {
    const cap = config.codex_sdk?.max_concurrent_threads ?? 4;
    this.semaphore = pLimit(cap);
  }

  async callApi(prompt: string, context: Context, options?: CallApiOptions) {
    // Wrap turn execution in semaphore
    return this.semaphore(async () => {
      const session = this.sessions.get(caseId);
      const turn = await session.thread.run(prompt);
      return this.formatResult(turn);
    });
  }
}
```

**Alternative: Env var override**

```bash
# CLI override
AD_EVALS_CODEX_SDK_CONCURRENCY=2 ad-evals run
```

```typescript
// Inside provider init
const cap = parseInt(
  process.env.AD_EVALS_CODEX_SDK_CONCURRENCY ||
  config.codex_sdk?.max_concurrent_threads ||
  "4"
);
this.semaphore = pLimit(cap);
```

**Recommendation:** Use both `sdk-pins.toml` (default) + env override (testing).
Semaphore enforces at the provider level (inside the bridge's per-case handler).

---

## 11. Contract YAML Generator (Phase 4 Bonus, Recommend Defer)

### Justification for Deferral

Spec §1550 lists "contract YAML generator" as Phase 4+. The OpenHands + Codex providers
now both ship with hand-maintained `test_contract.{py,ts}` files. A shared YAML generator
would:

1. Extract TypeScript interfaces from `_contract.ts`
2. Generate JSON schema from those interfaces
3. Emit a YAML template for new providers

**Reason to defer to Phase 5+:**

- Phase 4's primary goal is **to ship the Codex provider**, not infrastructure.
- Hand-written tests for each new provider (L2 layer, §8.2) are lightweight and catch real issues.
- YAML generator is a nice-to-have for Phase 4 v1.3.0 but not blocking Phase 4 scope.
- Recommends: v1.3.0 ships Codex provider + per-provider caps; v1.4.0+ adds YAML generator.

---

## 12. Environment Allowlist

### Codex SDK Required / Recommended Env Vars

```toml
# config/sdk-pins.toml [codex_sdk] section

env_allowlist = [
  # Required for Codex SDK
  "OPENAI_API_KEY",           # API authentication (required)
  
  # Optional but recommended
  "OPENAI_BASE_URL",          # Custom base URL for Codex API endpoint
  "OPENAI_ORG_ID",            # Organization ID for multi-tenant setups
  
  # Required for CLI subprocess
  "PATH",                      # Command lookup (file_editor, terminal tools need it)
  "HOME",                      # User home (~/ expansion for Git repos, workdir resolution)
  "USER",                      # Username for audit logs
  
  # Workspace operations
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  
  # Debug/optional
  "CODEX_DEBUG",               # CLI debug output (optional, for troubleshooting)
]
```

### Secret Redaction

The adapter's secret redactor (_secret_redactor.py / TypeScript equivalent) must strip:
- `*_API_KEY`
- `*_TOKEN`
- `*_SECRET`
- `*_PASSWORD`

...from error messages and logs (spec §7.1).

---

## 13. sdk-pins.toml Entry (Recommended Format)

```toml
[codex_sdk]
# TypeScript SDK version (the harness pins this globally)
version = "0.133.0"

# Node version requirement
node = ">=18"

# Peer dependency: Codex CLI (installed by SDK)
# The SDK depends on @openai/codex@0.133.0 which installs the CLI binary.
# Harness verifies `codex --version` matches expected CLI version.
cli_version = "0.133.0"

# No extras group for Codex SDK (unlike openhands which may have future extras)
extras = []

# Per-provider concurrency cap (Phase 4, spec §1085)
max_concurrent_threads = 4

# Environment variable allowlist (spec §7.1)
env_allowlist = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "PATH",
  "HOME",
  "USER",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "CODEX_DEBUG",
]
```

---

## 14. Open Questions / Blockers

### Q1: CLI Ownership — Adapter vs. SDK (RESOLVED, NOT A BLOCKER)

**Q:** Should the Node adapter spawn the Codex CLI subprocess, or does the SDK own it?

**A:** The **SDK owns subprocess management**. Unlike OpenCode SDK (which is a pure Node wrapper
  over a remote API or local binary), Codex SDK spawns the CLI internally and manages its lifecycle.
  The Node adapter will import Codex SDK, not spawn subprocess directly. This is **simpler** than
  the OpenCode pattern and does **not** require NDJSON subprocess communication — the adapter talks
  to the Codex object via `thread.run()` / `thread.runStreamed()`.

**Impact on design:** No subprocess IPC layer needed for Codex. The adapter is **in-process**.

---

### Q2: Model Slug Mapping (NEEDS USER DECISION)

**Q:** Codex accepts bare model strings (`gpt-4o`, `o1-preview`). Our framework uses litellm slugs
  (`anthropic/claude-sonnet-4-6`). How should `model_resolver.ts` handle this?

**Options:**

1. **Pass-through:** If the slug is unrecognized, pass it as-is to Codex (risky — may silently fail).
2. **Strict mapping:** Define a hardcoded map of known slugs → Codex model strings. Reject unknown slugs.
3. **Hybrid:** Map known slugs, pass-through with a warning for unknown. Log to stderr.

**Recommendation:** **Option 2 (strict mapping)**. The harness owns the slug → model mapping centrally.
If a tier config uses an unknown slug, fail early during `init` with a clear validation error.

**Mapping example:**
```typescript
const SLUG_TO_CODEX_MODEL: Record<string, string> = {
  "openai/gpt-4o": "gpt-4o",
  "openai/gpt-4-turbo": "gpt-4-turbo",
  "openai/o1-preview": "o1-preview",
  "openai/o1": "o1",
  // Codex is OpenAI-only; Anthropic models would fail
};
```

---

### Q3: Sandbox Mode & Permissions (NEEDS USER DECISION)

**Q:** Codex ThreadOptions includes `sandboxMode` and `approvalPolicy`. How do these map to
  harness `permissions` from ProviderConfig?

**Options:**

1. **Direct mapping:** `cfg.permissions.sandbox_mode` → `threadOptions.sandboxMode`
2. **Hardcoded:** All test cases use `sandboxMode = "workspace-write"` (default)
3. **Config-driven:** `config/eval-tiers.toml` specifies per-tier sandbox mode

**Recommendation:** **Option 3 (config-driven)**. Add `sandbox_mode` to tier config:

```toml
[[tiers.standard.providers]]
provider_kind = "codex_sdk"
model = "openai/gpt-4o"
sandbox_mode = "workspace-write"  # or "read-only" | "danger-full-access"
```

The adapter passes this to `thread.startThread({ sandboxMode })`.

---

### Q4: CLI Version Pinning (NEEDS USER DECISION)

**Q:** The SDK ships with a peer dependency on `@openai/codex@0.133.0`. Should the harness:

1. Let npm auto-resolve the CLI version (whatever `@openai/codex` resolves to)?
2. Pin the CLI version explicitly in `package.json`?
3. Pin in `sdk-pins.toml` and verify at runtime?

**Recommendation:** **Option 3 (pin in sdk-pins.toml + runtime verify)**. Add to Phase 4 CLI setup:

```bash
# In ad-evals.js startup
const expectedCliVersion = config['codex_sdk'].cli_version;
const actual = execSync('codex --version').toString().trim();
if (!actual.startsWith(expectedCliVersion)) {
  throw new Error(
    `Codex CLI version mismatch. Expected ${expectedCliVersion}, got ${actual}`
  );
}
```

---

### Q5: Workspace Isolation (SPEC §7.3) (RESOLVED)

**Q:** Codex requires a Git repo working directory. The harness creates per-case tmpdir.
Can we ensure isolation?

**A:** Yes. Pass `cfg.workspace_root` to `thread.startThread({ workingDirectory })`.
Each case gets its own tmpdir via the bridge's case setup. Codex will use that directory,
initialize a Git repo if needed (or skip check with `skipGitRepoCheck: true`).

**Recommendation:** Enforce Git repo by setting `skipGitRepoCheck: false` (default).
If a test needs to skip the check, add `extra.skip_git_check: true` in tier config.

---

## 15. Provider Kind & Kebab-Snake Naming

**Confirm:** `provider_kind = "codex_sdk"` (kebab-snake, matches OpenCode pattern)

This matches the dispatch table in spec §6.1:

```
| `codex_sdk` (Phase 4) | `spawn('node', ['_node_adapter.js', 'codex_sdk'])` | Node | Yes |
```

---

## Summary: Phase 4 Implementation Readiness

| Aspect | Status | Notes |
|---|---|---|
| **SDK exists & published** | ✅ PASS | `@openai/codex-sdk@0.133.0` on npm |
| **Node version** | ✅ PASS | ≥18, compatible with harness (Node 18+) |
| **Types available** | ✅ PASS | `dist/index.d.ts` included, TypeScript-ready |
| **Multi-turn semantics** | ✅ PASS | `Thread` object stateful, supports repeated `run()` |
| **Event extraction** | ✅ PASS | Turn/items/events well-structured, mappable to TurnResult |
| **Error handling** | ✅ PASS | Error types documented, classifiable per spec §1.3 |
| **Workspace support** | ✅ PASS | `workingDirectory` param, Git repo enforcement via option |
| **Concurrency caps** | ✅ REQUIRES DECISION | Design proposed, needs config schema choice (env var vs. config file) |
| **CLI ownership** | ✅ RESOLVED | SDK owns subprocess, adapter is in-process (simpler than OpenCode) |
| **Sandbox modes** | ⚠️ NEEDS DECISION | How to wire tier config → threadOptions sandbox_mode |
| **Model slug mapping** | ⚠️ NEEDS DECISION | Strict mapping vs. pass-through for unknown slugs |
| **YAML generator** | ⏭️ DEFER | Recommend Phase 5+ after Codex ships |

---

## Recommended Phase 4 Scope

```
Phase 4 v1.3.0 (minimal):
  ✅ Codex SDK provider (in-process, via agent_factory.ts)
  ✅ Event extraction + tool call mapping (event_extractor.ts)
  ✅ Per-provider concurrency caps (semaphore in bridge)
  ✅ Model resolver (slug → Codex model string)
  ✅ L2 contract tests (scripts/framework/providers/codex_sdk/test_contract.ts)
  ✅ L3 integration test (mock SDK)

Phase 5+ (deferred):
  ⏭️ Contract YAML generator
  ⏭️ Advanced config schema for sandbox modes / tool filtering
  ⏭️ Structured output (JSON schema) support in tier config
```

---

## Sources & References

| Reference | URL |
|---|---|
| **Official SDK Repo** | https://github.com/openai/codex |
| **npm Package** | https://www.npmjs.com/package/@openai/codex-sdk |
| **SDK TypeScript Types** | https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/index.ts |
| **Thread API** | https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/thread.ts |
| **Events Types** | https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/events.ts |
| **Items Types** | https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/items.ts |
| **Codex Options** | https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/codexOptions.ts |
| **Thread Options** | https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/threadOptions.ts |
| **Official Docs** | https://developers.openai.com/codex |
| **Spec (this harness)** | `spec.md` (lines 224–229, 481–483, 1085, 1550) |

---

**Status:** DONE
**Summary:** Codex SDK (@openai/codex-sdk@0.133.0) is confirmed as a real, published Node/TypeScript SDK for agentic coding. The SDK spawns the Codex CLI internally and exposes a clean async API (Thread.run / runStreamed). Three architectural decisions needed before Phase 4 implementation can begin: model slug mapping strategy, sandbox mode configuration wiring, and concurrency cap enforcement point.
**Concerns/Blockers:** None blocking implementation. Three design decisions (Q2, Q3, Q4) must be resolved via user input before Phase 4 plan is drafted. Deferring YAML generator to Phase 5+ is recommended to keep Phase 4 scope tight.
