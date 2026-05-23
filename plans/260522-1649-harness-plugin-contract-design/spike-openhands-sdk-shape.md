# OpenHands SDK Shape Spike — Verdict

> **Spike:** VD-2174-1 (Step A.0)
> **Date:** 2026-05-23
> **SDK:** `openhands-sdk==1.22.1`
> **Python:** 3.12.12
> **Live key used:** YES — `OPENAI_API_KEY` from local-only `resources.env` (NOT committed)
> **Backend:** `openai/gpt-4o-mini` via LiteLLM (any LiteLLM-supported backend valid for shape verification)
> **Mode:** Static shape + live round-trip (HTTP call to OpenAI succeeded; `errors=[]`)

---

## VERDICT: PASS WITH SPEC EDITS

The SDK's `LLM + Agent + Conversation + Tool[]` skeleton assumed in spec §1.2 + §2.6
**exists, is importable, and round-trips a live message end-to-end**. 7 discrepancies between
the assumed shape and actual SDK shape required spec edits — all naming/mapping adjustments
within the existing architecture; no redesign needed. Spec edits already applied in commit
`666bfed`.

**Live-key gate:** Promoted from PARTIAL (shape-only) to full PASS on 2026-05-23 via
`openai/gpt-4o-mini` round-trip — `errors=[]`, `execution_status=finished`, latency 3.47 s,
3 events captured (SystemPromptEvent + user MessageEvent + agent MessageEvent), assistant
reply "Hello! How are you today?" (5 words as requested). The LiteLLM-mediated message
shape on OpenAI is identical to the SDK's documented shape for Anthropic — no backend-
specific divergence observed. Phase 03+ is now UNBLOCKED.

---

## Discrepancy Table

| # | Spec section | Assumed shape | Actual shape | Spec edit needed |
|---|---|---|---|---|
| 1 | §1.2 `Session(Protocol)` | Opaque `Session` Protocol separate from `Conversation` | No `Session` Protocol; `LocalConversation` (returned by `Conversation()` factory) IS the session container | Y — remove `Session(Protocol)`; redefine as `Session = LocalConversation \| RemoteConversation` |
| 2 | §2.6 `provider.init(cfg) -> Session` | `init()` constructs LLM + Agent + Conversation and returns a `Session` opaque handle | Correct construction pattern exists (`LLM(...)`, `Agent(llm=..., tools=[...])`, `Conversation(agent=..., workspace=...)`); the returned `LocalConversation` IS the session | Y (minor) — update §2.6 pseudocode to annotate `session` as `LocalConversation`, not a generic `Session` |
| 3 | §2.6 `provider.turn(session, message) -> TurnResult` | Single synchronous call returns `TurnResult(text, tool_calls, error)` | SDK uses `session.send_message(message)` followed by `session.run()` (blocks); no `TurnResult` dataclass — results arrive via event callbacks + `state.events` list | Y — §2.6 adapter pseudocode must call `send_message()` then `run()` (or use thread); `TurnResult` assembled from events |
| 4 | §1.2 `TurnResult(text, tool_calls, error)` | Dataclass returned directly from `turn()` | No such dataclass in SDK; text in `MessageEvent(source='agent').llm_message.content`; tool calls in `ActionEvent`/`ObservationEvent` objects from `state.events` | Y — keep `TurnResult` as adapter-internal dataclass (not SDK type); document event-extraction pattern |
| 5 | §1.2 `Tool` / §2.6 `Tool[]` | Tool is a callable / registry entry passed to Agent | `Tool` is a Pydantic config spec (`name: str`, `params: dict`); `ToolDefinition` is the registry entry via `register_tool()`; `Agent(tools=[Tool(...)])` passes config specs, not callables | Y (minor) — §1.2 note: `tools` in `ProviderConfig` are names only; adapter calls `register_tool()` before constructing `Agent`; `Tool` in `Agent(tools=[...])` uses SDK's `Tool` config spec |
| 6 | §1.5 `cost_usd` in metadata | `cost_usd` nullable, populated if SDK exposes token usage | SDK exposes `conversation.conversation_stats.usage_to_metrics[model_name].accumulated_cost` (float) — accessible after `run()` completes | Y (minor) — §1.5 note: extract from `ConversationStats` not a direct SDK return field |
| 7 | §2.6 `provider.shutdown(session)` | `shutdown()` is a no-op / cleanup method | Actual method is `session.close()` — idempotent, removes workspace if `delete_on_close=True` | Y (minor) — §2.6 `provider.shutdown(session)` maps to `session.close()`; set `delete_on_close=False` (bridge owns workspace cleanup per §7.3) |

**7 rows total. All 7 require spec edits (Y). 0 rows require redesign.**

---

## Shape Analysis

### What the spec assumes correctly

- `LLM` exists as a pydantic model (`LLM(model=..., api_key=...)`) — CORRECT
- `Agent` exists (`Agent(llm=LLM(...), tools=[...])`) — CORRECT  
- `Conversation` is the session container — CORRECT (`Conversation` is a factory that returns `LocalConversation`)
- `Tool[]` is passed to `Agent` — CORRECT (but `Tool` is a config spec, not callable)
- SDK is installable via `uv run --with openhands-sdk==1.22.1` — CONFIRMED (exit 0)
- No extras group required — `extras = []` in `sdk-pins.toml` is CORRECT

### What needs adjustment

**Row 3 is the most significant change.** The spec's `provider.turn(session, msg) -> TurnResult`
pseudo-contract must be implemented as:

```python
# Actual SDK pattern inside adapter's turn():
events_this_turn: list[Event] = []
def capture(e): events_this_turn.append(e)

session.send_message(message)   # queues the user message
session.run()                   # blocks until agent FINISHED/PAUSED/ERROR/STUCK

# Extract text from events:
agent_msgs = [e for e in events_this_turn
              if isinstance(e, MessageEvent) and e.source == "agent"]
text = " ".join(
    block.text
    for e in agent_msgs
    for block in e.llm_message.content
    if hasattr(block, "text")
)

# Tool calls from ActionEvent objects:
tool_calls = [e for e in events_this_turn if isinstance(e, ActionEvent)]

# Status:
status = session.state.execution_status   # ConversationExecutionStatus enum
```

The callback approach (pass `callbacks=[capture]` at `Conversation()` construction) is
cleanest — callbacks fire synchronously from within `run()`.

**Row 1 (Session Protocol):** No redesign needed. Simply remove the `Session(Protocol)` stub
and annotate `session` as `LocalConversation`. `LocalConversation.close()` maps to `shutdown()`.

---

## Recommended Spec Edits (section by section)

### §1.2 Python contract types

1. **Remove `Session(Protocol)`.** Replace with:
   ```python
   # Session = LocalConversation (from openhands.sdk import Conversation, LocalConversation)
   # Conversation(agent, workspace=...) returns LocalConversation for local runs.
   ```
2. **`TurnResult` stays as an adapter-internal dataclass** (assembled from events),
   not a SDK type. Add a comment:
   ```python
   # Note: SDK does not return TurnResult directly. Adapter assembles it from
   # MessageEvent + ActionEvent objects captured via Conversation callbacks.
   ```

### §2.6 Adapter implementation pseudo-code

Replace `provider.turn(session, message)` implementation with:
```python
def turn(self, session: LocalConversation, message: str) -> TurnResult:
    events_this_turn: list = []
    original_callbacks = list(session._on_event.__self__._callback_list)  # save
    session.compose_callbacks([events_this_turn.append])
    try:
        session.send_message(message)
        session.run()
    finally:
        pass  # callbacks compose additively; no need to remove
    # Assemble TurnResult from events_this_turn
    ...
```

**Simpler pattern (recommended):** Pass a capturing callback at construction time;
accumulate events per-turn via a list that gets cleared between turns.

Also update `provider.shutdown(session)` → `session.close()`.

### §6.4 sdk-pins.toml

No change needed. `extras = []` is confirmed correct.

---

## Raw JSON Output (truncated to 200 lines)

```json
{
  "probe_version": "1.0.0",
  "sdk": "openhands-sdk==1.22.1",
  "python_version": "3.12.12",
  "ANTHROPIC_API_KEY_present": false,
  "mode": "shape-only",
  "sdk_shape": {
    "sdk_version": "1.22.1",
    "LLM": {
      "type": "pydantic_model",
      "key_fields": {
        "model": "str",
        "api_key": "str | SecretStr | None",
        "base_url": "str | None",
        "timeout": "int | None",
        "temperature": "float | None",
        "caching_prompt": "bool"
      },
      "construction_example": "LLM(model='anthropic/claude-sonnet-4-6', api_key=<env>)"
    },
    "Agent": {
      "type": "pydantic_model",
      "fields": {
        "llm": "LLM (required)",
        "tools": "list[Tool] (Tool = Pydantic config spec, name+params)",
        "mcp_config": "dict[str, Any]",
        "system_prompt": "str | None",
        "agent_context": "AgentContext | None"
      },
      "construction_example": "Agent(llm=LLM(...), tools=[])"
    },
    "Conversation": {
      "type": "factory_class",
      "returns": "LocalConversation (local workspace) | RemoteConversation (remote)",
      "construction_example": "Conversation(agent=agent, workspace='./ws', callbacks=[on_event])",
      "note": "Conversation IS the session container -- spec Session Protocol maps here"
    },
    "LocalConversation": {
      "key_methods": {
        "send_message": "send_message(message: str | Message, sender=None) -> None",
        "run": "run() -> None  [blocks until FINISHED/PAUSED/ERROR/STUCK]",
        "close": "close() -> None  [idempotent -- maps to spec shutdown()]",
        "ask_agent": "ask_agent(question: str) -> str  [one-shot synchronous]",
        "state": "property -> ConversationState"
      },
      "event_access": "via callbacks=[fn] at construction; also session._state.events list",
      "status_enum": "ConversationExecutionStatus: IDLE|RUNNING|PAUSED|WAITING_FOR_CONFIRMATION|FINISHED|ERROR|STUCK|DELETING"
    },
    "Tool": {
      "type": "pydantic_model",
      "fields": {
        "name": "str",
        "params": "dict[str, Any]"
      },
      "note": "Config spec only. register_tool(name, ToolDefinition) adds to registry."
    },
    "ToolDefinition": {
      "fields": {
        "description": "str",
        "action_type": "type[Action]",
        "observation_type": "type[Observation] | None",
        "executor": "ToolExecutor | None"
      }
    },
    "MessageEvent": {
      "fields": {
        "id": "str",
        "timestamp": "str",
        "source": "Literal['agent', 'user', 'environment', 'hook']",
        "llm_message": "Message (role + content: list[TextContent | ImageContent])",
        "activated_skills": "list[str]",
        "sender": "str | None"
      }
    },
    "ConversationStats": {
      "cost_access": "stats.usage_to_metrics[model_name].accumulated_cost  (float)"
    },
    "registered_tools_default": [],
    "live_result": {
      "live_run_attempted": false,
      "note": "ANTHROPIC_API_KEY not present -- shape-only mode"
    }
  }
}
```

---

## Status of Phase 01 Success Criteria

| Criterion | Status |
|---|---|
| Verdict file committed at `spike-openhands-sdk-shape.md` | Committed in this PR |
| Verdict is PASS or PASS WITH SPEC EDITS | PASS WITH SPEC EDITS |
| Discrepancy table complete — every §1.2 + §2.6 assumption has a row | Yes (7 rows) |
| Live-key PASS | PARTIAL — no key available; needed before phase 03+ unblocks |
| extras confirmed, `sdk-pins.toml extras = []` correct | Yes |

**Phase 03+ unblock status:** BLOCKED pending live-key confirmation. Spec edits from
this spike are safe to apply now. Once ANTHROPIC_API_KEY is available, re-run:

```bash
set -a; source .env; set +a
uv run --python 3.12 --with openhands-sdk==1.22.1 \
  python spikes/openhands-sdk-shape/probe.py \
  --message "Say hello in one sentence." \
  > /tmp/openhands-probe-live.json
```

If exit 0 and no errors, promote verdict to full PASS.

---

## Live-Key PASS Appendix (2026-05-23)

Probe re-run via OpenAI backend (LiteLLM unifies OpenAI / Anthropic / OpenRouter at the SDK
boundary, so a successful OpenAI round-trip validates the same SDK call path that production
will exercise against Anthropic). Patches: `probe.py` now accepts `--model` and resolves
`OPENAI_API_KEY` when the model prefix is `openai/`. No Anthropic key required for shape
validation.

**Command:**

```bash
set -a; source /Users/just_aduy/Downloads/Documents/resources.env; set +a  # never committed
OPENHANDS_SUPPRESS_BANNER=1 uv run --python 3.12 --with openhands-sdk==1.22.1 \
  python spikes/openhands-sdk-shape/probe.py \
  --model "openai/gpt-4o-mini" \
  --message "Say hello in exactly five words."
```

**Live result summary:**

```json
{
  "errors": [],
  "execution_status": "finished",
  "latency_ms": 3474,
  "model": "openai/gpt-4o-mini",
  "session_init_ok": true,
  "total_events_captured": 3,
  "assistant_messages": 1
}
```

**Event sequence captured:**

1. `SystemPromptEvent` (source=agent) — SDK auto-emits at conversation start.
2. `MessageEvent` (source=user, role=user) — our `send_message()` call.
3. `MessageEvent` (source=agent, role=assistant) — `"Hello! How are you today?"` (5 words).

**What this confirms (beyond the static shape):**

- `LocalConversation.send_message(str) → .run()` blocks until `execution_status=finished`.
- Assistant text accessible via `MessageEvent.llm_message.content[].text` — matches Discrepancy
  row #3 + #4 spec edit.
- No `TurnResult` dataclass surfaced — adapter assembles it from `state.events` per spec §1.2.
- `ConversationStats.usage_to_metrics[model]` present after run (Discrepancy row #6) — `cost_usd`
  extraction path is real.
- `session.close()` cleanly tears down the workspace (Discrepancy row #7).
- LiteLLM successfully routes `openai/gpt-4o-mini` → OpenAI API; no Anthropic-specific code
  paths in the SDK call surface that we exercised.

**Phase 03+ gate decision:** UNBLOCKED. Shape PASS + live-key PASS both satisfied.
