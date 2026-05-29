"""
Mock OpenHands SDK symbols for Layer 3 provider tests.

Loaded via sys.modules monkey-patching — never on the production import path.
Provides deterministic, no-network implementations of the SDK classes observed
in spike A.0 (openhands-sdk==1.22.1).

Key behaviours
--------------
- MockConversation.send_message() + .run() emit a deterministic event sequence
  keyed on the input text:
    "hello"    → SystemPromptEvent + user MessageEvent + agent MessageEvent("Hi there!")
    "use bash" → SystemPromptEvent + user MessageEvent + ActionEvent + ObservationEvent
                 + agent MessageEvent("Done.")
    any other  → SystemPromptEvent + user MessageEvent + agent MessageEvent("Echo: <input>")
- MockConversation.run() raises TimeoutError if the input starts with "__timeout__".
- All invocations are recorded on the instance for test assertions.
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Event stubs — class names must match what EventExtractor.on_event() routes on.
# ---------------------------------------------------------------------------


class SystemPromptEvent:
    def __init__(self, content: str = "") -> None:
        self.source = "agent"
        self.content = content


class TextContent:
    def __init__(self, text: str) -> None:
        self.text = text


class LLMMessage:
    def __init__(self, role: str, content) -> None:
        self.role = role
        self.content = content if isinstance(content, list) else [TextContent(content)]


class MessageEvent:
    def __init__(self, source: str, content: str) -> None:
        self.source = source
        self.llm_message = LLMMessage(role=source, content=content)


class ActionEvent:
    def __init__(self, call_id: str, tool_name: str, tool_params: dict) -> None:
        self.id = call_id
        self.tool_name = tool_name
        self.tool_params = tool_params


class ObservationEvent:
    def __init__(self, cause: str, content: str, error: str | None = None) -> None:
        self.cause = cause
        self.content = content
        self.error = error


# ---------------------------------------------------------------------------
# Tool stub
# ---------------------------------------------------------------------------


class Tool:
    def __init__(self, name: str, params: dict | None = None) -> None:
        self.name = name
        self.params = params or {}


class Terminal(Tool):
    def __init__(self) -> None:
        super().__init__(name="terminal")


class TaskTracker(Tool):
    def __init__(self) -> None:
        super().__init__(name="task_tracker")


class FileEditor(Tool):
    def __init__(self) -> None:
        super().__init__(name="file_editor")


# ---------------------------------------------------------------------------
# LLM stub
# ---------------------------------------------------------------------------


class LLM:
    """Records construction args; makes no network calls."""

    def __init__(
        self,
        model: str,
        api_key: str | None = None,
        temperature: float = 0.0,
        max_tokens: int = 4096,
        **kwargs: Any,
    ) -> None:
        self.model = model
        self.api_key = api_key
        self.temperature = temperature
        self.max_tokens = max_tokens


# ---------------------------------------------------------------------------
# Agent stub
# ---------------------------------------------------------------------------


class Agent:
    def __init__(
        self,
        llm: LLM,
        tools: list[Tool] | None = None,
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> None:
        self.llm = llm
        self.tools = tools or []
        self.system_prompt = system_prompt


# ---------------------------------------------------------------------------
# Conversation / LocalConversation stub
# ---------------------------------------------------------------------------


class Conversation:
    """Factory function stand-in — returns a MockConversation (LocalConversation)."""

    def __new__(
        cls,
        agent: Agent,
        workspace: str = "./workspace",
        callbacks: list | None = None,
        delete_on_close: bool = False,
        **kwargs: Any,
    ) -> "MockConversation":  # type: ignore[misc]
        return MockConversation(
            agent=agent,
            workspace=workspace,
            callbacks=callbacks,
            delete_on_close=delete_on_close,
        )


class MockConversation:
    """Simulates LocalConversation.  Deterministic event emission."""

    def __init__(
        self,
        agent: Agent,
        workspace: str = "./workspace",
        callbacks: list | None = None,
        delete_on_close: bool = False,
    ) -> None:
        self.agent = agent
        self.workspace = workspace
        self._callbacks: list = list(callbacks or [])
        self.delete_on_close = delete_on_close
        self.closed = False

        # Invocation log for test assertions
        self.messages_sent: list[str] = []
        self.run_calls: int = 0
        self.close_calls: int = 0

        # Injected overrides (tests can set these)
        self._force_timeout: bool = False
        self._force_tool_error: str | None = None  # set to error text to inject

    # ------------------------------------------------------------------
    # SDK interface
    # ------------------------------------------------------------------

    def send_message(self, message: str, sender: str | None = None) -> None:
        self.messages_sent.append(message)

    def run(self) -> None:
        """Emit deterministic events then return (blocks synchronously)."""
        self.run_calls += 1
        if not self.messages_sent:
            return

        last_msg = self.messages_sent[-1]

        # Timeout injection
        if last_msg.startswith("__timeout__") or self._force_timeout:
            raise TimeoutError(f"mock timeout for message: {last_msg!r}")

        events = self._build_events(last_msg)
        for evt in events:
            for cb in self._callbacks:
                cb(evt)

    def close(self) -> None:
        """Idempotent close."""
        self.close_calls += 1
        self.closed = True

    def add_callback(self, cb) -> None:
        self._callbacks.append(cb)

    # ------------------------------------------------------------------
    # Event generation
    # ------------------------------------------------------------------

    def _build_events(self, message: str) -> list:
        events: list = [
            SystemPromptEvent("You are a helpful assistant."),
            MessageEvent(source="user", content=message),
        ]

        if message == "use bash":
            call_id = "mock-action-1"
            events.append(
                ActionEvent(
                    call_id=call_id,
                    tool_name="terminal",
                    tool_params={"cmd": "echo hello"},
                )
            )
            tool_error = self._force_tool_error
            events.append(
                ObservationEvent(
                    cause=call_id,
                    content="" if tool_error else "hello\n",
                    error=tool_error,
                )
            )
            events.append(MessageEvent(source="agent", content="Done."))
        else:
            reply = f"Echo: {message}" if message != "hello" else "Hi there!"
            events.append(MessageEvent(source="agent", content=reply))

        return events
