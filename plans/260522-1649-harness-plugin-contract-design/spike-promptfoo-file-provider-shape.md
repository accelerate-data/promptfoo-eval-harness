# Spike: Promptfoo `file://` Provider Option-Shape (VD-2174-1B)

> Date: 2026-05-23
> Promptfoo version: 0.121.11 (pinned in package.json)
> Working directory: repo root (`promptfoo-eval-harness/`)
> Probe config: `spikes/promptfoo-file-provider-shape/promptfooconfig.yaml`

---

## Verdict

**PASS WITH SPEC EDITS**

The `config:` block IS forwarded verbatim (nested objects, arrays, all types preserved), BUT via
the **constructor** (`new ProbeProvider(options)`) — **not** via the `callApi` third argument.
The third argument to `callApi(prompt, context, options)` only carries `{ abortSignal }`.

Spec §2.6 pseudo-code relies on `options?.config` being present at `callApi` time:
```js
const cfg = parseProviderConfig(options?.config || this.options.config);
```
The `|| this.options.config` fallback already handles this correctly, but the spec comment
says "Promptfoo passes the *final* options here; we prefer it over constructor options" — that
comment is wrong. The constructor options ARE the final config; the `callApi` options argument
only carries runtime signals (abort). Spec edits needed to clarify.

Additionally: **`vars.turns: [...]` arrays are expanded into separate rows by Promptfoo's test
matrix engine**, not passed as a single array to one `callApi` invocation. Each element of the
array becomes an independent test case row with `context.vars.turns = <string element>`. The
bridge NEVER sees `context.vars.turns` as an array.

---

## Discrepancy Table

| # | Spec assumption (§ reference) | Actual behavior | Spec edit needed? |
|---|-------------------------------|-----------------|:-----------------:|
| 1 | §2.2 + §2.6: `options.config.*` forwarded to `callApi` third arg | `callApi` third arg = `{ abortSignal }` only. Config arrives in **constructor** `options` arg. | **Y** |
| 2 | §2.6 comment: "Promptfoo passes the *final* options here; we prefer it over constructor options" | Constructor options = the final/only source. `callApi` options never contains config. | **Y** |
| 3 | §3.1 + §3.2: `context.vars.turns` is a `string[]` array at `callApi` time | Promptfoo expands array vars into separate matrix rows. `context.vars.turns` is a **single string** per `callApi` invocation, not an array. | **Y** |
| 4 | §2.6: `const cfg = parseProviderConfig(options?.config \|\| this.options.config)` | The `\|\| this.options.config` fallback DOES work correctly as written — config is always available via `this.options.config`. Runtime behavior is fine; only the comment is wrong. | Y (comment only) |
| 5 | §2.2: `options.config.provider_kind` and `options.config.provider_label` at callApi time | Both keys present at constructor time. Config block preserved verbatim: nested objects not flattened, arrays preserve order and types, integers/strings preserved. `basePath` key added by Promptfoo. | N (config shape PASS) |
| 6 | §4 (parallelism): bridge semaphore wraps every `callApi` | `callApi` is still called once per case — semaphore works. Array vars → matrix rows are scheduled independently by Promptfoo, each triggering a separate `callApi`. | N |
| 7 | `context.vars` reachable | Yes. `context.vars` present with correct per-row values. `context.test.vars`, `context.test.description` also present. | N |

**Rows with "spec edit needed: Y" = 4 (rows 1, 2, 3, 4)**. Rows 1–3 are load-bearing design
edits; row 4 is a comment-only fix.

---

## Raw JSON Dump (truncated to ≤200 lines)

### Constructor options (what Promptfoo passes to `new ProbeProvider(options)`)

```json
{
  "constructorOptions": {
    "id": "file://./probe.js",
    "config": {
      "provider_kind": "openhands_sdk",
      "provider_label": "probe-openhands",
      "model": "anthropic/claude-sonnet-4-6",
      "top_level_string": "hello from config",
      "top_level_integer": 42,
      "nested": {
        "level1": {
          "level2_string": "deep-value",
          "level2_int": 99
        },
        "sibling_key": "sibling"
      },
      "array_of_strings": ["alpha", "beta", "gamma"],
      "array_of_objects": [
        { "name": "tool-a", "allow": true },
        { "name": "tool-b", "allow": false }
      ],
      "basePath": "spikes/promptfoo-file-provider-shape"
    },
    "env": {}
  }
}
```

`basePath` is injected by Promptfoo (relative path to the config file's directory). All
other keys match the YAML `config:` block exactly — nested objects preserved, arrays
preserve order and types, no string coercion.

### `callApi(prompt, context, options)` — `options` arg (ALL cases)

```json
{
  "options": {
    "abortSignal": "[AbortSignal]"
  },
  "options_keys": ["abortSignal"]
}
```

`options.config` is `undefined` for every case. The third arg carries only runtime signals.

### `callApi` — `context` for multi-turn case (vars.turns length 3)

Promptfoo creates **3 separate callApi invocations** (one per array element):

```json
{
  "prompt": "probe-prompt",
  "context": {
    "vars": { "turns": "turn one message", "extra_var": "per-row-extra" },
    "test": { "description": "multi-turn length-3 via vars.turns", "vars": { "turns": "turn one message" } }
  }
}
```
```json
{
  "context": {
    "vars": { "turns": "turn two message", "extra_var": "per-row-extra" }
  }
}
```
```json
{
  "context": {
    "vars": { "turns": "turn three message", "extra_var": "per-row-extra" }
  }
}
```

`context.vars.turns` is a **string** (the individual element), not the original array.

---

## Recommended Spec Edits

### Edit 1 — §2.2 and §2.6: `options.config` → `this.options.config` (load-bearing)

**Section:** §2.2 (callout), §2.6 (`HarnessBridgeProvider.callApi` pseudo-code)

**Current §2.6 comment:**
```
// Promptfoo passes the *final* options here; we prefer it over constructor options.
const cfg = parseProviderConfig(options?.config || this.options.config);
```

**Corrected §2.6 comment:**
```
// Promptfoo passes only { abortSignal } as the callApi third arg.
// Provider config is exclusively available via this.options.config (constructor arg).
const cfg = parseProviderConfig(this.options.config);
```

**Corrected §2.2 callout:** Replace "Promptfoo passes these through to `callApi(prompt, context,
options)` as `options.config.*`" with "Promptfoo passes the per-provider `config:` block to the
**constructor** as `options.config.*`. The `callApi` third argument only carries runtime signals
(`{ abortSignal }`). The bridge reads config from `this.options.config` (constructor-time)."

The OR fallback `options?.config || this.options.config` still works at runtime (the left side
is always `undefined` so it falls through), but it is misleading. Replace with just
`this.options.config`.

### Edit 2 — §3.1 and §3.2: `vars.turns` is NOT an array at `callApi` time (load-bearing)

**Section:** §3.1, §3.2, §3.2.1

**Current assumption (§3.1 example + §3.2 rule #1):**
`vars.turns` is a `[string, ...]` array in the YAML test, and the bridge reads
`context.vars.turns` as an array at `callApi` time.

**Actual behavior:**
Promptfoo's test-matrix engine expands YAML array vars into separate rows before scheduling.
Each `callApi` invocation receives a **single string** in `context.vars.turns`, not the full
array. A `vars.turns: ["t1","t2","t3"]` YAML block produces 3 separate cases, each with
`context.vars.turns = "t1"` (or `"t2"`, or `"t3"`).

**Required redesign for multi-turn:**
The bridge cannot implement multi-turn by reading `context.vars.turns` as an array. Options:

1. **Single-string encoding** (simplest): Consumer passes `vars.turns` as a single JSON-encoded
   string (e.g., `vars.turns: '["t1","t2","t3"]'`); bridge calls `JSON.parse`. The YAML becomes
   less readable, but no Promptfoo internals are fought.

2. **Separate vars per turn** (explicit, Promptfoo-idiomatic): Consumer declares `vars.turn_1`,
   `vars.turn_2`, etc. Bridge reads `context.vars` for keys `turn_1..turn_N`. Requires knowing
   turn count in YAML. Less flexible.

3. **File-based turns list** (ref file): `vars.turns` is a path to a YAML/JSON file listing
   turns. Bridge reads the file. Adds a file dependency per test case.

4. **`providerOptions` override** (not usable for multi-turn): Per-test `providerOptions` are
   not passed through to `callApi` either (same constructor-only model).

**Recommendation:** Option 1 (JSON-encoded string). Wrap in a small helper `parseTurns(value)`
that accepts either a JSON-encoded string array OR a single plain string (single-turn fallback).
Update §3.1 YAML examples to use the encoded form.

**Update §2.6 bridge precedence logic:**
```js
// context.vars.turns arrives as a JSON-encoded string (array) or plain string (single turn).
// Promptfoo's matrix engine expands YAML arrays into rows; we never see a JS Array here.
function parseTurns(raw, promptFallback) {
  if (!raw && !promptFallback) return null;
  if (!raw) return [promptFallback];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch (_) { /* not JSON-encoded */ }
  // Treat as single-turn string
  return [raw];
}
const turns = parseTurns(context?.vars?.turns, prompt);
```

**Update §3.2 precedence rules:** Add note that `vars.turns` must be JSON-encoded when
multi-turn; plain string is treated as single turn. Update §3.1 YAML example accordingly.

---

## Verification Notes

- Eval exit code: 0 (all 5 test cases PASS).
- Provider path resolution: `file://./probe.js` resolves relative to the config file's
  directory, not the repo root. The bridge in `resolve-promptfoo-config.js` must emit an
  absolute path or repo-root-relative path prefixed correctly. `file://scripts/framework/_node_bridge.js`
  must be verified — if Promptfoo resolves relative to config location, the path in
  `resolve-promptfoo-config.js` must be an absolute path or account for config CWD.
- Promptfoo adds `basePath` key to the constructor config. `parseProviderConfig` must not reject
  unknown keys (or explicitly allow/strip `basePath`).
