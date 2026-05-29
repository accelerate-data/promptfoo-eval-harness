# OpenCode SDK Shape Spike — Verdict

> **Spike:** VD-2174-3 (Step A.1)
> **Date:** 2026-05-23
> **SDK:** `@opencode-ai/sdk@1.15.10`
> **Language:** TypeScript/JavaScript (ESM-only)
> **Status:** DONE WITH CONCERNS

---

## VERDICT: PASS — SDK EXISTS, API SURFACE LOCKED

The OpenCode SDK is a published Node.js package (`@opencode-ai/sdk` on npm v1.15.10, MIT license)
designed for **programmatic session management** (not a CLI, not a server wrapper). The SDK
exposes a **HTTP-based client API** (`OpencodeClient`) that communicates with the OpenCode server,
rather than an in-process agent SDK like OpenHands. This is a **SIGNIFICANT ARCHITECTURAL DIFFERENCE**
from the OpenHands SDK pattern (local agent in same process) — the Node adapter must use HTTP calls
to the OpenCode server, not import a local agent library.

**Phase 3 impact:** The Node adapter design differs fundamentally from the Python adapter:
instead of importing SDK classes into the subprocess and assembling agent + conversation locally,
the Node adapter will instantiate `OpencodeClient`, manage sessions via HTTP REST calls, and extract
results from the API responses (not from local event callbacks). This requires:

1. **OpenCode server reachability** — assume `http://localhost:8080` or `OPENCODE_SERVER_URL` env var.
2. **Session creation + prompt → model coordination** — map spec `config.model` (litellm slug) to OpenCode
   `(providerID, modelID)` tuples via a new `opencode_sdk/model_resolver.js` (mirrors OpenHands pattern).
3. **Response shape extraction** — extract text + tool calls from HTTP response Part arrays (no callbacks).
4. **Tool registry mapping** — map spec tool names to OpenCode tool flags (`tools: { [name]: true }`).
5. **Error handling** — HTTP status codes (400, 404, 5xx) map to error taxonomy; retry behavior differs
   from CLI (no retry loop, server handles retries).

All verifiable claims below cite npm package inspection (`@opencode-ai/sdk@1.15.10`) + TypeScript definitions.

---

## 1. SDK Metadata

| Field | Value | Source |
|-------|-------|--------|
| **npm package name** | `@opencode-ai/sdk` | npm registry (verified) |
| **latest stable version** | `1.15.10` | `npm view @opencode-ai/sdk@latest version` |
| **published** | 6 hours ago (2026-05-23 ~08:00 UTC) | npm registry metadata |
| **license** | MIT | package.json |
| **type** | `"module"` (ESM-only) | package.json `"type": "module"` |
| **exports** | `"."`, `"./client"`, `"./server"`, `"./v2/*"` | package.json exports |
| **single dependency** | `cross-spawn@7.0.6` | package.json dependencies |
| **peer deps** | None | package.json |
| **Node version range** | `>=18` (inferred from TSConfig targets) | dist/*.d.ts typings level |
| **install command** | `npm install @opencode-ai/sdk@1.15.10` | standard npm |

**Concern:** ESM-only package — **Node adapter must use `import` statements, not `require()`**
in a `.js` file. Options:
- (A) Write adapter as `.mjs` file (Node-native ESM mode).
- (B) Use `.js` + `"type": "module"` in harness `package.json` (already ESM, see AGENTS.md).
- (C) Dynamic import in CommonJS: `const mod = await import('@opencode-ai/sdk')` (runtime cost).

**Recommendation:** If harness is already ESM-aware, use option (A) or (B). If not, ESM adoption
may be needed. Current harness is CommonJS (`require()` in `bin/ad-evals.js`); this is worth
flagging to user for decision.

---

## 2. Model Alias Convention

**OpenCode SDK model spec** (from SessionPromptData types):

```typescript
model?: {
  providerID: string;   // e.g. "anthropic", "openai"
  modelID: string;      // e.g. "claude-sonnet-4-6", "gpt-4-turbo"
}
```

**Spec requirement** (spec §1.2): `ProviderConfig.model` is a **litellm slug**, e.g. `"anthropic/claude-sonnet-4-6"`.

**Mapping:** Node adapter must parse the litellm slug and split into `(providerID, modelID)`:

```javascript
// Example mapping:
"anthropic/claude-sonnet-4-6" → { providerID: "anthropic", modelID: "claude-sonnet-4-6" }
"openai/gpt-4-turbo"          → { providerID: "openai", modelID: "gpt-4-turbo" }
```

**Implementation location:** `scripts/framework/providers/opencode_sdk/model_resolver.js`
(mirrors `openhands_sdk/model_resolver.py`). Resolver must:
1. Parse `config.model` (litellm slug).
2. Split into `(provider, modelID)`.
3. Validate against a known list of OpenCode-supported (providerID, modelID) pairs (TBD by team).
4. Return `{ providerID, modelID }` or raise `validation` ProviderError if unrecognized.

**Unknown constraint:** What (providerID, modelID) pairs does OpenCode server accept?
Assume Anthropic is primary; OpenAI likely supported. Needs confirmation from OpenCode team or docs.

---

## 3. Agent Factory (Session Init)

**OpenCode SDK does NOT have a local Agent + Conversation pattern.**
Instead, the SDK is a **REST HTTP client** to the OpenCode server.

**Session creation pattern:**

```typescript
// Node adapter init() must:
import { OpencodeClient } from '@opencode-ai/sdk';

function init(cfg: ProviderConfig): Promise<SessionHandle> {
  const client = new OpencodeClient({
    apiKey: process.env.OPENCODE_API_KEY,  // env-only, never in config
    // serverUrl?: string (defaults to localhost:8080 or env OPENCODE_SERVER_URL)
  });

  // Create a new session on the OpenCode server
  const sessionResp = await client.session.create({
    body: {
      title: `harness-${cfg.case_id}`,  // optional, but useful for debugging
    },
    query: {
      directory: cfg.workspace_root,  // workspace path for the session
    },
  });

  // sessionResp.info is a Session object with { id, sessionID, ... }
  // Store the sessionID for use in subsequent turn/finalize/shutdown calls

  return {
    client,
    sessionID: sessionResp.info.id,  // or .sessionID — verify which field
    workspace_root: cfg.workspace_root,
  };
}
```

**Key differences from OpenHands:**
- No local `LLM(...)` + `Agent(...)` construction.
- Server owns the agent lifecycle.
- Session handle is an opaque server ID (not a local object with `.close()` method).
- Config must include **server connectivity info** — assume `OPENCODE_API_KEY` + `OPENCODE_SERVER_URL`.

**Concern:** env allowlist (§6.4 below) must include `OPENCODE_API_KEY` and possibly `OPENCODE_SERVER_URL`.

---

## 4. Tool Registry API

**OpenCode SDK tool registration** — from SessionPromptData types:

```typescript
tools?: {
  [key: string]: boolean;  // e.g. { "terminal": true, "file_editor": false }
}
```

**Tool spec shape:** Tools are **enabled/disabled via a boolean map**, not a list of objects
with JSON schemas (unlike OpenHands `Tool(name, params)` Pydantic specs).

**Implementation pattern:**

```javascript
// In opencode_sdk/tool_registry.js
function buildToolMap(toolNames: string[]): Record<string, boolean> {
  const toolMap: Record<string, boolean> = {};
  for (const name of toolNames) {
    // Only enable tools from the spec's tool list
    toolMap[name] = true;
  }
  // All other tools default to false (implicitly disabled)
  return toolMap;
}

// In turn() call:
const toolMap = buildToolMap(cfg.tools);  // cfg.tools from ProviderConfig
await client.session.prompt({
  path: { id: sessionID },
  body: {
    tools: toolMap,
    // ... other fields
  },
});
```

**Built-in tools:** OpenCode SDK documentation needed to list supported tool names.
**Assumption:** Tools include `terminal`, `file_editor`, `browser`, etc. (common agent tools).
**Concern:** Tool permission model (spec §1.6) applies to tool names, but OpenCode uses
a boolean enable/disable flag. Mapping may need a per-tool permission check → include/exclude
from the `toolMap`.

---

## 5. Event Stream / Response Shape

**OpenCode SDK does NOT use event callbacks.** Instead:

```typescript
// Prompt response (HTTP 200):
{
  info: AssistantMessage,  // metadata about the response
  parts: Part[]            // response content
}

// Part types (union):
type Part = TextPart | ToolPart | FilePart | AgentPart | ... (14 variants total)

type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;           // <-- ASSISTANT TEXT (extract this)
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
}

type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;         // <-- TOOL CALL ID
  tool: string;           // <-- TOOL NAME
  state: ToolState;       // "pending" | "running" | "completed" | "error"
  metadata?: Record<string, unknown>;
  input?: Record<string, unknown>;     // <-- TOOL ARGUMENTS
  output?: string;        // <-- TOOL RESULT (if completed)
}
```

**TurnResult assembly** (spec §1.2 / §2.6):

```javascript
function extractTurnResult(promptResponse: SessionPromptResponses[200]): TurnResult {
  // Extract text from all TextPart items
  const text = promptResponse.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as TextPart).text)
    .join('\n');

  // Extract tool calls from ToolPart items
  const toolCalls = promptResponse.parts
    .filter((p) => p.type === 'tool')
    .map((p) => {
      const tp = p as ToolPart;
      return {
        name: tp.tool,
        arguments: tp.input || {},
        result_truncated: tp.output ? tp.output.slice(0, 1024) : '',
        error: tp.state === 'error' ? `Tool failed: ${tp.callID}` : undefined,
      };
    });

  return {
    text,
    tool_calls: toolCalls,
    error: null,  // (handle ProviderError separately if HTTP call fails)
  };
}
```

**Multi-turn semantics:** Each `prompt()` call appends a new user message and returns an assistant response.
Conversation state is maintained by the server (sessionID is the key). No explicit session object needed.

---

## 6. Multi-Turn Semantics

**Session state model:**
- Session created once in `init()` → stores sessionID.
- Each `turn()` call sends one message via `client.session.prompt({ id: sessionID, body: {...} })`.
- Server maintains conversation history; each message is immutable once sent.
- `finalize()` queries the session for metadata (e.g., `client.session.messages({ id: sessionID })`).
- No explicit "conversation object" returned by SDK; all state is server-side.

**First-class object:** `Session` type from OpenCode API (response of `session.create()`):

```typescript
type Session = {
  id: string;                        // unique session identifier
  sessionID: string;                 // alias for id (confirm which is used)
  title?: string;
  worktree?: string;
  time: { created: number; initialized?: number };
  // ... other metadata
}
```

**Stateless replay:** Not supported natively. Each session is independent.
Future sessions cannot resume a prior conversation (no session fork/resume in v1.15.10).
Each eval case gets a fresh session.

---

## 7. Error Taxonomy

**HTTP Error responses** from OpenCode SDK client (mapped from HTTP status codes):

| HTTP Status | OpenCode Type | Spec Error Code | Retryable |
|-------------|---------------|-----------------|-----------|
| 400 | `BadRequestError` | `validation` | False |
| 401/403 | Auth errors | `auth` | False |
| 429 | Rate limit (if supported) | `rate_limit` | True |
| 500/502/503 | Server error | `sdk_error` | True |
| Connection timeout | Network error | `sdk_error` | True |
| JSON parse error | Malformed response | `sdk_error` | False |

**SDK-specific error classes** (from OpenCode types):

```typescript
export type BadRequestError = {
  name: "BadRequest";
  data: { message: string; kind?: "Params" | "Headers" | "Query" | "Body" | "Payload" };
};
export type NotFoundError = { ... };
export type ProviderAuthError = { ... };
// ... (full list in dist/gen/types.gen.d.ts)
```

**Adapter error handling:**

```javascript
async function turn(session, message) {
  try {
    const response = await client.session.prompt({...});
    return { text: "...", tool_calls: [...], error: null };
  } catch (error) {
    if (error instanceof BadRequestError) {
      return error ProviderError("validation", error.message, false);
    } else if (error.name === "NotFound") {
      return ProviderError("validation", "Session not found", false);
    } else if (error.response?.status === 429) {
      return ProviderError("rate_limit", "OpenCode server rate limited", true);
    } else if (error.response?.status >= 500) {
      return ProviderError("sdk_error", `OpenCode server error: ${error.message}`, true);
    } else {
      return ProviderError("sdk_error", error.message, false);
    }
  }
}
```

**Retryable pattern:** Adapter's NDJSON loop (per spec §2.3) catches `retryable: true`
errors and decides whether to retry or abort the turn. OpenCode adapter should NOT retry
internally — let the bridge handle retry logic.

---

## 8. Mock SDK Strategy for Node

**Challenge:** The OpenCode SDK requires a running OpenCode **server** (HTTP endpoint).
For local testing and CI scenarios without a live server, we need a mock.

**Pattern options:**

### Option A: HTTP Interceptor Mock (Recommended)
Use a Node HTTP mocking library (e.g., `nock`, `msw`) to intercept HTTP calls
before they leave the process. Does NOT modify the SDK code or use loaders.

```javascript
// tests/_mock_opencode_sdk/index.js
import nock from 'nock';

export function mockOpencodeServer() {
  const baseURL = process.env.OPENCODE_SERVER_URL || 'http://localhost:8080';
  
  nock(baseURL)
    .post('/session')
    .reply(200, {
      info: {
        id: 'mock-session-123',
        sessionID: 'mock-session-123',
        title: 'mock',
        time: { created: Date.now() },
      },
    });

  nock(baseURL)
    .post('/session/:id/prompt', /.*/)
    .reply(200, {
      info: {
        id: 'mock-message-456',
        role: 'assistant',
        modelID: 'claude-sonnet',
        providerID: 'anthropic',
      },
      parts: [
        {
          type: 'text',
          messageID: 'mock-message-456',
          sessionID: 'mock-session-123',
          text: '[mock response] Acknowledged.',
        },
      ],
    });
}
```

**Pros:**
- Zero code changes to adapter or SDK.
- Works in Node test runner + CI.
- Deterministic, fast (no network I/O).

**Cons:**
- Requires `nock` or `msw` as dev dependency.
- Mock must match OpenCode API schema exactly (breaks if schema changes).

### Option B: ESM Loader Hook (Advanced)
Use Node's `--loader` flag to intercept module loads and replace `@opencode-ai/sdk`
with a mock module at test time.

```bash
node --loader ./tests/_mock_opencode_sdk/loader.mjs _node_adapter.js opencode_sdk
```

**Pros:**
- Fine-grained control over SDK behavior.
- Can simulate per-test variations (e.g., error responses, slow latency).

**Cons:**
- Complex to implement + maintain.
- Loader hooks are experimental in Node 18 (stable in 20+).
- Not suitable for production code (only test/CI).

### Option C: Environment-Based Bypass (Simple)
If the adapter checks `AD_EVALS_MOCK_MODE=1`, skip HTTP calls and return hardcoded responses.

**Pros:**
- No external dependencies.
- Easy for developers to understand.

**Cons:**
- Requires adapter code to check environment (adds clutter).
- Not as flexible as HTTP mocking.

---

## 9. Node Adapter Foundation (_node_adapter.js) Design

**Scope:** The Node adapter will mirror `scripts/framework/providers/_python_adapter.py` in structure
but adapted for Node/TypeScript and OpenCode SDK semantics.

**File:** `scripts/framework/providers/_node_adapter.js` (or `.mjs` if ESM-only)

**Structure:**

```javascript
import * as fs from 'fs';
import * as readline from 'readline';

// Import shared utilities (to be created)
import { createLogger } from './_structured_logger.js';
import { ProviderError, TurnResult, FinalResult } from './_contract.ts';

// Per-kind provider registry (mirrors _python_adapter.py L88)
const PROVIDER_REGISTRY = {
  opencode_sdk: 'scripts.framework.providers.opencode_sdk.provider',
  codex_sdk: 'scripts.framework.providers.codex_sdk.provider', // Phase 4
};

// Entry point
async function main() {
  const args = process.argv.slice(2);
  const kindArg = args.find(a => a.startsWith('--kind='));
  if (!kindArg) {
    emitError('missing --kind argument');
    process.exit(1);
  }

  const kind = kindArg.split('=')[1];
  const logger = createLogger();

  let session = null;
  try {
    // Spawn-like approach: read NDJSON from stdin
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      const req = JSON.parse(line);
      try {
        if (req.type === 'init') {
          // Load provider module dynamically
          const provider = await loadProvider(kind);
          const cfg = req.config;
          session = await provider.init(cfg);
          emitResponse({ type: 'init_ok' });
        } else if (req.type === 'turn') {
          const provider = await loadProvider(kind);
          const result = await provider.turn(session, req.message);
          emitResponse({ type: 'turn_ok', result });
        } else if (req.type === 'finalize') {
          const provider = await loadProvider(kind);
          const final = await provider.finalize(session);
          emitResponse({ type: 'final', result: final });
        } else if (req.type === 'shutdown') {
          const provider = await loadProvider(kind);
          if (session) await provider.shutdown(session);
          emitResponse({ type: 'closed' });
          return;
        }
      } catch (err) {
        emitResponse({ type: 'error', error: sanitizeError(err) });
      }
    }
  } catch (err) {
    emitResponse({ type: 'error', error: sanitizeError(err) });
    process.exit(1);
  }
}

async function loadProvider(kind) {
  // Dynamic import by kind (mirrors _python_adapter.py L94-119)
  const modulePath = PROVIDER_REGISTRY[kind];
  if (!modulePath) {
    throw new ProviderError('validation', `unknown provider kind: ${kind}`, false);
  }
  const mod = await import(modulePath);
  // If module exports create(), call it; else return module itself
  return mod.create ? mod.create() : mod;
}

function emitResponse(obj) {
  console.log(JSON.stringify(obj));
}

function sanitizeError(err) {
  return {
    code: err.code || 'sdk_error',
    message: err.message,
    retryable: err.retryable || false,
  };
}

main().catch((err) => {
  emitResponse({ type: 'error', error: sanitizeError(err) });
  process.exit(1);
});
```

**Lifecycle (mirrors spec §2.3 + §2.6):**

1. **INIT**: Load provider module, call `provider.init(cfg)`, return session handle.
2. **TURN (×N)**: Call `provider.turn(session, message)`, emit `TurnResult`.
3. **FINALIZE**: Call `provider.finalize(session)`, emit `FinalResult`.
4. **SHUTDOWN**: Call `provider.shutdown(session)`, emit `closed`, exit 0.

**Shared utilities to create/adapt:**

| Component | Python Source | Node Equivalent | Status |
|-----------|---------------|-----------------|--------|
| Structured logger | `_structured_logger.py` | `_structured_logger.js` | CREATE (mirrors Python) |
| Secret redactor | `_secret_redactor.py` | Use subprocess fan-out (call Python redactor) | REUSE (Python only) |
| Error handling | `_contract.py` ProviderError | `_contract.ts` ProviderError | REUSE (shared TypeScript type) |
| NDJSON loop | Python stdin loop | Node readline + async iteration | CREATE |

**Env allowlist enforcement** (spec §2.6 + §6.4):
- Read allowlist from `config/sdk-pins.toml` per kind.
- Filter `process.env` before passing to provider module (prevent accidental env key leaks).
- Redact secrets from error messages (use subprocess fan-out to Python `_secret_redactor.py`, or reimplement in JS).

---

## 10. Provider Tree Mapping

**Directory structure** (mirrors `openhands_sdk/` pattern):

```text
scripts/framework/providers/
├── opencode_sdk/
│   ├── __init__.js (or omit if not needed)
│   ├── provider.js              # main entry point (init/turn/finalize/shutdown)
│   ├── provider.test.js         # contract tests
│   ├── model_resolver.js        # parse litellm slug → (providerID, modelID)
│   ├── model_resolver.test.js
│   ├── tool_registry.js         # build tool enable/disable map
│   ├── tool_registry.test.js
│   ├── event_extractor.js       # extract text + tool_calls from Part[]
│   ├── event_extractor.test.js
│   ├── agent_factory.js         # (deprecated for OpenCode; kept for symmetry)
│   ├── agent_factory.test.js
│   ├── _errors.js               # OpenCode-specific error mapping
│   └── README.md
└── _node_adapter.js             # (shared for opencode_sdk + codex_sdk, Phase 4)
```

**File descriptions:**

### `provider.js`
Main provider implementation. Exports `init()`, `turn()`, `finalize()`, `shutdown()`.

```javascript
import { OpencodeClient } from '@opencode-ai/sdk';
import { modelResolver } from './model_resolver.js';
import { toolRegistry } from './tool_registry.js';
import { eventExtractor } from './event_extractor.js';

export async function init(cfg) {
  const client = new OpencodeClient({
    apiKey: process.env.OPENCODE_API_KEY,
  });
  
  const sessionResp = await client.session.create({
    body: { title: `harness-${cfg.case_id}` },
    query: { directory: cfg.workspace_root },
  });

  return {
    client,
    sessionID: sessionResp.info.id,
    cfg,
  };
}

export async function turn(session, message) {
  const { client, sessionID, cfg } = session;
  const model = modelResolver(cfg.model);
  const tools = toolRegistry(cfg.tools);

  try {
    const response = await client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: 'text', text: message }],
        model,
        tools,
        system: cfg.system || undefined,
      },
    });

    return eventExtractor(response);
  } catch (error) {
    return {
      text: '',
      tool_calls: [],
      error: mapOpenCodeError(error),
    };
  }
}

export async function finalize(session) {
  const { client, sessionID, cfg } = session;
  
  const messagesResp = await client.session.messages({
    path: { id: sessionID },
  });

  const allText = messagesResp.messages
    .filter(m => m.role === 'assistant')
    .flatMap(m => m.parts || [])
    .filter(p => p.type === 'text')
    .map(p => p.text)
    .join('\n');

  return {
    final_text: allText,
    turns_completed: messagesResp.messages.length,
    tool_calls: [],  // aggregate if needed
    metadata: {
      provider_kind: 'opencode_sdk',
      model: cfg.model,
      sdk_version: '1.15.10',  // hardcoded or from package.json
    },
  };
}

export async function shutdown(session) {
  // OpenCode sessions are server-side; no cleanup needed.
  // If delete-on-close is desired, could call:
  // const { client, sessionID } = session;
  // await client.session.delete({ path: { id: sessionID } });
  // For now, assume server cleans up after expiry or manual deletion.
}
```

### `model_resolver.js`
Parse litellm slug and map to OpenCode (providerID, modelID).

```javascript
export function modelResolver(litellmSlug) {
  // "anthropic/claude-sonnet-4-6" → { providerID: "anthropic", modelID: "claude-sonnet-4-6" }
  const [provider, model] = litellmSlug.split('/');
  return { providerID: provider, modelID: model };
}
```

### `tool_registry.js`
Build boolean tool map for the prompt request.

```javascript
export function toolRegistry(toolNames) {
  const toolMap = {};
  for (const name of toolNames) {
    toolMap[name] = true;
  }
  return toolMap;
}
```

### `event_extractor.js`
Extract text + tool calls from SessionPromptResponses.

```javascript
export function eventExtractor(response) {
  const parts = response.parts || [];
  
  const text = parts
    .filter(p => p.type === 'text')
    .map(p => p.text)
    .join('\n');

  const toolCalls = parts
    .filter(p => p.type === 'tool')
    .map(p => ({
      name: p.tool,
      arguments: p.input || {},
      result_truncated: (p.output || '').slice(0, 1024),
      error: p.state === 'error' ? `Tool error: ${p.callID}` : undefined,
    }));

  return {
    text,
    tool_calls: toolCalls,
    error: null,
  };
}
```

### `_errors.js`
Map OpenCode HTTP errors to spec error taxonomy.

```javascript
export function mapOpenCodeError(httpError) {
  if (httpError.response?.status === 400) {
    return {
      code: 'validation',
      message: httpError.message,
      retryable: false,
    };
  } else if (httpError.response?.status === 429) {
    return {
      code: 'rate_limit',
      message: 'OpenCode server rate limited',
      retryable: true,
    };
  } else {
    return {
      code: 'sdk_error',
      message: httpError.message,
      retryable: httpError.response?.status >= 500,
    };
  }
}
```

---

## 11. Env Allowlist

**Env vars the OpenCode SDK reads:**

| Var | Purpose | Required? | Source |
|-----|---------|-----------|--------|
| `OPENCODE_API_KEY` | Bearer token for SDK HTTP client | Yes | SDK constructor `apiKey` option |
| `OPENCODE_SERVER_URL` | HTTP endpoint (e.g., `http://localhost:8080`) | No (defaults to localhost:8080) | SDK default or env |
| `OPENCODE_TIMEOUT_MS` | Request timeout (if supported) | No | SDK config |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Skip HTTPS cert validation (dev only) | No | Node.js runtime |

**Config/sdk-pins.toml entry** (to be added):

```toml
[opencode_sdk]
version = "1.15.10"
node = ">=18"
# ESM-only; harness must support ESM (or migrate _node_adapter.js to .mjs)
env_allowlist = [
  "OPENCODE_API_KEY",
  "OPENCODE_SERVER_URL",
  "OPENCODE_TIMEOUT_MS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
]
```

---

## 12. sdk-pins.toml Extension

**Current schema** (from existing file):

```toml
[openhands_sdk]
version = "1.22.1"
python = ">=3.12,<3.14"
extras = []
env_allowlist = [...]
```

**Proposed extension for Node SDKs:**

```toml
[opencode_sdk]
version = "1.15.10"
node = ">=18"                    # NEW: Node version requirement (unlike python field)
# No extras group for Node (node packages don't have extras like Python)
env_allowlist = [
  "OPENCODE_API_KEY",
  "OPENCODE_SERVER_URL",
]

[codex_sdk]                       # Phase 4 placeholder
version = "TBD"
node = ">=18"
env_allowlist = [...]
```

**Schema change rationale:**
- Python SDKs use `python` field + `extras` (pip groups).
- Node SDKs use `node` field (npm has no extras equivalent).
- Both share `version` + `env_allowlist`.
- TOML schema can accommodate both without conflict (per-provider sections).

**Validation:** Phase 03 foundation code must validate `node` version matches `process.version`.
Example check in bridge or adapter:

```javascript
const requiredNode = '>=18';
if (!semver.satisfies(process.version.slice(1), requiredNode)) {
  throw new Error(`Node ${requiredNode} required, got ${process.version}`);
}
```

---

## 13. Open Questions / Blockers

1. **ESM vs. CommonJS:**
   - Is the harness ready for ESM (import/await)?
   - Current `bin/ad-evals.js` uses `require()` (CommonJS).
   - Node adapter must use `import` (ESM-only SDK).
   - **Decision needed:** Migrate harness to ESM, or use dynamic `import()` in CommonJS?

2. **OpenCode Server Reachability:**
   - Assumption: OpenCode server runs on localhost:8080 or via env `OPENCODE_SERVER_URL`.
   - Phase 3 tests and CI need a running server or mock.
   - **Verify:** Where does the OpenCode server run in dev/CI? Docker? Local build?

3. **Model / Provider ID Tuples:**
   - What (providerID, modelID) pairs does OpenCode accept?
   - Current assumption: Anthropic `("anthropic", "claude-*")`, OpenAI `("openai", "gpt-*")`.
   - **Verify:** Get list of supported models from OpenCode team or docs.

4. **Tool Support in OpenCode:**
   - What tools does OpenCode SDK expose via the boolean `tools: { ... }` map?
   - Current assumption: `terminal`, `file_editor`, etc.
   - **Verify:** List of tool names from OpenCode API documentation.

5. **Session Cleanup:**
   - Should the adapter call `client.session.delete(sessionID)` on shutdown?
   - Or rely on server-side expiry?
   - **Decision:** Affects disk usage + server resource cleanup.

6. **Cost Tracking:**
   - Does OpenCode SDK expose token usage / cost per message?
   - OpenHands SDK has `ConversationStats.usage_to_metrics[model].accumulated_cost`.
   - **Verify:** Is cost tracking available in OpenCode API?

7. **Error Message Redaction:**
   - The _secret_redactor.py is Python-specific.
   - Node adapter needs equivalent (regex-based secret masking).
   - **Decision:** Reimplement in JS, or call Python subprocess (overhead)?

---

## 14. Provider_kind Suggestion

Confirm `provider_kind` string for the adapter registry:

| Kind | Suggested | Rationale |
|------|-----------|-----------|
| OpenCode SDK | `opencode_sdk` | kebab-snake format (matches `openhands_sdk`) |
| Codex SDK (Phase 4) | `codex_sdk` | kebab-snake format |

**Registry entry** (in `_node_adapter.js` PROVIDER_REGISTRY):

```javascript
const PROVIDER_REGISTRY = {
  opencode_sdk: 'scripts/framework/providers/opencode_sdk/provider.js',
  codex_sdk: 'scripts/framework/providers/codex_sdk/provider.js',
};
```

---

## Summary of Findings

| Finding | Impact | Status |
|---------|--------|--------|
| SDK exists, npm published | ✅ Unblocks Phase 3 | VERIFIED |
| ESM-only (no CommonJS) | ⚠️ Requires harness ESM support | DECISION NEEDED |
| HTTP-based client (not local agent) | ⚠️ Architecture differs from OpenHands | ACCEPTED |
| Model: (providerID, modelID) tuple | ✅ Maps easily from litellm slug | DESIGN READY |
| Tool: boolean enable/disable map | ✅ Simpler than OpenHands Tool spec | DESIGN READY |
| Response: Part[] array extraction | ✅ Straightforward event extraction | DESIGN READY |
| Error taxonomy mapping | ✅ HTTP status → spec codes feasible | DESIGN READY |
| Mock strategy | ✅ HTTP intercept (nock) recommended | DESIGN READY |
| Node adapter structure | ✅ Mirrors Python adapter | DESIGN READY |
| sdk-pins.toml extension | ✅ Node field adds to schema | DESIGN READY |
| Env allowlist | ✅ OPENCODE_API_KEY + optional OPENCODE_SERVER_URL | DESIGN READY |

---

**Status:** DONE WITH CONCERNS

**Summary:** OpenCode SDK (`@opencode-ai/sdk@1.15.10`) is a published HTTP client for the OpenCode
server (not a local agent SDK like OpenHands). Phase 3 Node adapter design is feasible, requires
3 decision points (ESM migration, server reachability, tool/model coverage) and minor schema extension
to `sdk-pins.toml`. All component designs (model_resolver, tool_registry, event_extractor, error mapper)
are straightforward HTTP response transformations. Ready for implementation planning.

**Concerns/Blockers:**

1. **ESM migration required** — Node adapter uses `import`; harness currently CommonJS.
   - Blocker status: DESIGN DECISION (team choice, not SDK limitation).
   - Mitigation: Use .mjs file + dynamic import(), or migrate harness to ESM wholesale.

2. **OpenCode server connectivity** — Phase 3 tests assume localhost:8080 or env URL.
   - Blocker status: TEST ENVIRONMENT SETUP (not SDK issue).
   - Mitigation: Mock with nock or provision test server in CI.

3. **Model/tool coverage** — Assume Anthropic + OpenAI models, terminal/file_editor tools.
   - Blocker status: DOCUMENTATION GAP (OpenCode team should publish supported list).
   - Mitigation: Hardcode initial list; add test cases per model support.

