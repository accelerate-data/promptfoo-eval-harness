"""
probe.py — OpenHands SDK 1.22.1 shape spike (throwaway).

Outputs JSON: { session_class, turn_result_shape, tool_call_events,
                raw_events_truncated, errors }

Usage (with live key):
    set -a; source .env; set +a
    uv run --python 3.12 --with openhands-sdk==1.22.1 python \\
        spikes/openhands-sdk-shape/probe.py \\
        --message "Say hello in one sentence"

Usage (shape-only, no live key — captures construction shape only):
    uv run --python 3.12 --with openhands-sdk==1.22.1 python \\
        spikes/openhands-sdk-shape/probe.py --shape-only

NOTE: This is a throwaway spike. Do NOT import into runtime paths.
"""

import argparse
import inspect
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Any


def redact(s: str) -> str:
    """Redact API key patterns from any string."""
    import re
    s = re.sub(r'sk-[A-Za-z0-9_-]{10,}', '***REDACTED***', s)
    s = re.sub(r'(api[_-]key|ANTHROPIC_API_KEY)[=:]\s*\S+',
               r'\1=***REDACTED***', s, flags=re.IGNORECASE)
    return s


def capture_sdk_shape() -> dict[str, Any]:
    """Capture the static SDK shape without making any API calls."""
    import openhands.sdk as sdk

    shape: dict[str, Any] = {}

    # --- SDK version ---
    shape["sdk_version"] = getattr(sdk, "__version__", "unknown")

    # --- Exported names ---
    shape["exported_names"] = [
        n for n in dir(sdk) if not n.startswith("_")
    ]

    # --- LLM shape ---
    try:
        llm_fields = {
            k: str(v.annotation)
            for k, v in sdk.LLM.model_fields.items()
        }
        shape["LLM"] = {
            "type": "pydantic_model",
            "fields": llm_fields,
            "construction_example": "LLM(model='anthropic/claude-sonnet-4-6', api_key=<env>)",
        }
    except Exception as e:
        shape["LLM"] = {"error": str(e)}

    # --- Agent shape ---
    try:
        agent_fields = {
            k: str(v.annotation)
            for k, v in sdk.Agent.model_fields.items()
        }
        shape["Agent"] = {
            "type": "pydantic_model",
            "fields": agent_fields,
            "construction_example": "Agent(llm=LLM(...), tools=[...])",
            "note": "Agent is NOT a class hierarchy base — it IS the concrete SDK agent.",
        }
    except Exception as e:
        shape["Agent"] = {"error": str(e)}

    # --- Tool shape ---
    try:
        tool_fields = {
            k: str(v.annotation)
            for k, v in sdk.Tool.model_fields.items()
        }
        shape["Tool"] = {
            "type": "pydantic_model",
            "fields": tool_fields,
            "note": "Tool is a config spec (name + params), not a callable. "
                    "register_tool() adds ToolDefinition to registry.",
        }
        shape["ToolDefinition"] = {
            "fields": {
                k: str(v.annotation)
                for k, v in sdk.ToolDefinition.model_fields.items()
            }
        }
    except Exception as e:
        shape["Tool"] = {"error": str(e)}

    # --- Conversation / Session shape ---
    try:
        shape["Conversation"] = {
            "abstract_base": "BaseConversation (ABC)",
            "concrete_local": "LocalConversation",
            "concrete_remote": "RemoteConversation",
            "note": "Conversation is the session container — spec's 'Session' maps "
                    "directly onto LocalConversation (not a separate opaque handle).",
        }

        lc_sig = str(inspect.signature(sdk.LocalConversation.__init__))
        shape["LocalConversation"] = {
            "constructor_signature": lc_sig,
            "key_args": {
                "agent": "AgentBase (required)",
                "workspace": "str | Path | LocalWorkspace (required)",
                "callbacks": "list[Callable[[Event], None]] | None",
                "persistence_dir": "str | Path | None",
                "max_iteration_per_run": "int = 500",
            },
            "methods": {
                "send_message": "send_message(message: str | Message, sender=None) -> None",
                "run": "run() -> None  [blocks until agent FINISHED/IDLE/PAUSED]",
                "close": "close() -> None  [idempotent cleanup]",
                "ask_agent": "ask_agent(question: str) -> str  [synchronous one-shot]",
                "state": "property -> ConversationState",
            },
            "event_access": "conversation._state.events  (list[Event], populated via callbacks)",
            "session_lifecycle": "send_message() -> run() -> close()",
        }
    except Exception as e:
        shape["LocalConversation"] = {"error": str(e)}

    # --- Event shape ---
    try:
        event_fields = {
            k: str(v.annotation)
            for k, v in sdk.Event.model_fields.items()
        }
        msg_fields = {
            k: str(v.annotation)
            for k, v in sdk.MessageEvent.model_fields.items()
        }
        shape["Event"] = {
            "base_fields": event_fields,
            "MessageEvent_fields": msg_fields,
            "subtypes_in_sdk": [
                "MessageEvent", "ActionEvent (actions)", "ObservationEvent (tool results)",
                "HookExecutionEvent", "CondensationRequest", "ConversationErrorEvent",
            ],
        }
    except Exception as e:
        shape["Event"] = {"error": str(e)}

    # --- ConversationExecutionStatus ---
    try:
        shape["ConversationExecutionStatus"] = [
            s.value for s in sdk.ConversationExecutionStatus
        ]
    except Exception as e:
        shape["ConversationExecutionStatus"] = {"error": str(e)}

    # --- Registered tools (empty by default) ---
    try:
        shape["registered_tools_default"] = sdk.list_registered_tools()
    except Exception as e:
        shape["registered_tools_default"] = {"error": str(e)}

    # --- LLMRegistry ---
    try:
        shape["LLMRegistry"] = {
            "exists": True,
            "note": "LLMRegistry is not required for basic usage — LLM() constructed directly.",
        }
    except Exception as e:
        shape["LLMRegistry"] = {"error": str(e)}

    return shape


def run_live_probe(message: str, workspace_dir: str) -> dict[str, Any]:
    """
    Attempt a live round-trip through the SDK.

    Returns shape info + any errors. Never commits ANTHROPIC_API_KEY to output.
    """
    import openhands.sdk as sdk

    result: dict[str, Any] = {
        "live_run_attempted": True,
        "session_class": None,
        "turn_result_shape": None,
        "tool_call_events": [],
        "raw_events_truncated": [],
        "errors": [],
    }

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        result["errors"].append("ANTHROPIC_API_KEY not set — live run skipped")
        result["live_run_attempted"] = False
        return result

    events_captured: list[dict] = []

    def on_event(event) -> None:
        """Collect events without recording secrets."""
        try:
            ev_type = type(event).__name__
            ev_dict: dict[str, Any] = {"type": ev_type}

            if hasattr(event, "source"):
                ev_dict["source"] = event.source
            if hasattr(event, "timestamp"):
                ev_dict["timestamp"] = event.timestamp

            # MessageEvent
            if isinstance(event, sdk.MessageEvent):
                llm_msg = event.llm_message
                ev_dict["role"] = llm_msg.role
                # Extract text from content blocks
                texts = []
                for block in (llm_msg.content or []):
                    if hasattr(block, "text"):
                        texts.append(redact(block.text[:500]))
                ev_dict["content_preview"] = texts[:3]
                ev_dict["activated_skills"] = list(event.activated_skills or [])

            events_captured.append(ev_dict)
        except Exception as exc:
            events_captured.append({"type": "capture_error", "error": str(exc)})

    try:
        # Construct LLM — reads api_key from env automatically via LiteLLM
        llm = sdk.LLM(
            model="anthropic/claude-haiku-4-5",  # cheapest for spike
            api_key=api_key,
        )

        # Construct Agent with no extra tools (default tools = empty)
        agent = sdk.Agent(llm=llm, tools=[])

        result["session_class"] = "LocalConversation"
        result["agent_class"] = type(agent).__name__

        # Construct LocalConversation — this is the "Session" container
        conv = sdk.LocalConversation(
            agent=agent,
            workspace=workspace_dir,
            callbacks=[on_event],
            max_iteration_per_run=10,  # cap for spike
        )

        # Record which classes we actually used
        result["session_class"] = type(conv).__name__
        result["session_init_ok"] = True

        # --- Send one user message and run ---
        t_start = time.time()
        send_err = None
        run_err = None

        try:
            conv.send_message(message)
        except Exception as e:
            send_err = redact(traceback.format_exc())
            result["errors"].append({"phase": "send_message", "error": redact(str(e))})

        if not send_err:
            # run() blocks until agent finishes
            run_done = threading.Event()
            run_exception: list[Exception] = []

            def _run():
                try:
                    conv.run()
                except Exception as exc:
                    run_exception.append(exc)
                finally:
                    run_done.set()

            t = threading.Thread(target=_run, daemon=True)
            t.start()
            finished = run_done.wait(timeout=60.0)

            if not finished:
                result["errors"].append({
                    "phase": "run",
                    "error": "timeout after 60s — agent did not finish",
                })
            elif run_exception:
                run_err = redact(traceback.format_exc())
                result["errors"].append({
                    "phase": "run",
                    "error": redact(str(run_exception[0])),
                })

        t_end = time.time()
        result["latency_ms"] = int((t_end - t_start) * 1000)
        result["execution_status"] = conv.state.execution_status.value

        # --- Capture turn result shape ---
        all_events = list(events_captured)
        result["raw_events_truncated"] = all_events[:50]  # truncate at 50
        result["total_events_captured"] = len(all_events)

        # Extract assistant reply
        assistant_msgs = [
            e for e in all_events
            if e.get("type") == "MessageEvent" and e.get("source") == "agent"
        ]
        result["assistant_messages"] = assistant_msgs[:5]

        # Describe TurnResult shape from what we captured
        result["turn_result_shape"] = {
            "text": assistant_msgs[-1].get("content_preview", []) if assistant_msgs else None,
            "note": "Text is inside MessageEvent.llm_message.content[].text (NOT a TurnResult dataclass)",
            "tool_calls_in": "ActionEvent objects (not TurnResult.tool_calls directly)",
            "status_field": "ConversationExecutionStatus enum on LocalConversation.state",
        }

        # Collect tool-call events
        action_events = [
            e for e in all_events
            if e.get("type") in ("ActionEvent", "ObservationEvent", "HookExecutionEvent")
        ]
        result["tool_call_events"] = action_events[:20]

        # Close conversation
        try:
            conv.close()
        except Exception as e:
            result["errors"].append({"phase": "close", "error": redact(str(e))})

    except Exception as outer_exc:
        result["errors"].append({
            "phase": "construction_or_outer",
            "error": redact(str(outer_exc)),
            "traceback": redact(traceback.format_exc()[-2000:]),
        })

    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="OpenHands SDK 1.22.1 shape probe (throwaway spike)"
    )
    parser.add_argument(
        "--message",
        default="Say hello in one sentence.",
        help="User message to send (live mode only)",
    )
    parser.add_argument(
        "--shape-only",
        action="store_true",
        help="Capture static SDK shape only; do not attempt a live API call",
    )
    args = parser.parse_args()

    output: dict[str, Any] = {
        "probe_version": "1.0.0",
        "sdk": "openhands-sdk==1.22.1",
        "python_version": sys.version.split()[0],
        "ANTHROPIC_API_KEY_present": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "mode": "shape-only" if args.shape_only else "live",
    }

    # Always capture static shape
    try:
        output["sdk_shape"] = capture_sdk_shape()
    except Exception as e:
        output["sdk_shape_error"] = redact(traceback.format_exc())

    # Live run if key present and not shape-only
    if not args.shape_only:
        with tempfile.TemporaryDirectory(prefix="oh_probe_") as tmpdir:
            live_result = run_live_probe(args.message, tmpdir)
        output["live_result"] = live_result
    else:
        output["live_result"] = {
            "live_run_attempted": False,
            "note": "--shape-only flag set",
        }

    print(json.dumps(output, indent=2, default=str))


if __name__ == "__main__":
    main()
