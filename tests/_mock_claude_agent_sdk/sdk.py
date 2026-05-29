"""
Mock Claude Agent SDK symbols for Layer 3 provider tests (spec §8.3).

Loaded via sys.modules monkey-patching — never on the production import path.
Provides deterministic, no-network implementations of the SDK classes observed
in spike A.2 (claude-agent-sdk==0.2.85).

Determinism keyed on prompt prefix
----------------------------------
- "__auth_error__..."  → raises ProcessError on iteration (auth failure)
- "__malformed__..."   → yields a message whose .type the extractor ignores
- "__tool_error__..."  → emits ToolCallMessage + ToolResultMessage(is_error=True)
- "remember <N>..."    → ClaudeSDKClient stores <N> in history for later turns
- "what number..."     → ClaudeSDKClient replays the remembered <N>
- "hello"              → AssistantMessage("Hi there!")
- anything else        → AssistantMessage(f"Echo: <prompt>")

All emissions terminate with a ResultMessage so the provider's finalize() path
captures cost / token metadata.

Multi-turn state lives on ClaudeSDKClient instance (not module global) so the
Skeptic #3 dependency test verifies turn 2 sees turn 1's client identity.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

# ---------------------------------------------------------------------------
# Exception hierarchy (mirrors spike A.2 §6 — claude_agent_sdk public exports)
# ---------------------------------------------------------------------------


class ClaudeSDKError(Exception):
    """Base exception for the Claude Agent SDK."""


class CLINotFoundError(ClaudeSDKError):
    """Claude Code CLI not installed."""


class CLIConnectionError(ClaudeSDKError):
    """Connection to Claude Code failed."""


class ProcessError(ClaudeSDKError):
    """SDK process failed (auth, exit code, etc.)."""

    def __init__(
        self, message: str, exit_code: int | None = None, stderr: str | None = None
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stderr = stderr


class CLIJSONDecodeError(ClaudeSDKError):
    """JSON parsing error from CLI output."""

    def __init__(self, line: str, original_error: Exception | None = None) -> None:
        super().__init__(str(original_error or "JSON decode failed"))
        self.line = line
        self.original_error = original_error


# ---------------------------------------------------------------------------
# Content blocks + message classes (provider routes on .type strings)
# ---------------------------------------------------------------------------


class TextBlock:
    def __init__(self, text: str) -> None:
        self.text = text


class SystemMessage:
    def __init__(self, subtype: str = "init", data: dict | None = None) -> None:
        self.type = "system"
        self.subtype = subtype
        self.data = data or {}


class AssistantMessage:
    def __init__(self, content: list) -> None:
        self.type = "assistant"
        self.content = content


class ToolCallMessage:
    def __init__(self, tool_use_id: str, tool_name: str, input: dict | None = None) -> None:
        self.type = "tool_call"
        self.tool_use_id = tool_use_id
        self.tool_name = tool_name
        self.input = input or {}


class ToolResultMessage:
    def __init__(
        self, tool_use_id: str, content: str = "", is_error: bool = False
    ) -> None:
        self.type = "tool_result"
        self.tool_use_id = tool_use_id
        self.content = content
        self.is_error = is_error


class ResultMessage:
    def __init__(
        self,
        status: str = "ok",
        total_cost_usd: float = 0.0,
        usage: dict | None = None,
        session_id: str = "mock-session",
    ) -> None:
        self.type = "result"
        self.status = status
        self.total_cost_usd = total_cost_usd
        self.usage = usage or {"input_tokens": 10, "output_tokens": 5}
        self.session_id = session_id


class _WeirdMessage:
    """Sentinel for the malformed-message test (provider must ignore)."""

    def __init__(self) -> None:
        self.type = "weird"


# ---------------------------------------------------------------------------
# Options dataclass — accept any kwargs so SDK schema drift doesn't crash mock
# ---------------------------------------------------------------------------


class ClaudeAgentOptions:
    """Lightweight stand-in. Captures constructor kwargs for test assertions."""

    def __init__(self, **kwargs: Any) -> None:
        self.model = kwargs.pop("model", "claude-sonnet-4-6")
        self.allowed_tools = list(kwargs.pop("allowed_tools", []) or [])
        self.permission_mode = kwargs.pop("permission_mode", "acceptEdits")
        self.system_prompt = kwargs.pop("system_prompt", "")
        self.cwd = kwargs.pop("cwd", ".")
        self.max_turns = kwargs.pop("max_turns", 10)
        self.extra = dict(kwargs)


# ---------------------------------------------------------------------------
# Message stream builders
# ---------------------------------------------------------------------------


def _extract_remember_value(text: str) -> str | None:
    """If text contains "remember <value>", return <value>; else None.

    Handles both 'remember 42' and 'remember the number 42'. Strips trailing
    punctuation so 'remember 42.' yields '42'.
    """
    tokens = text.split()
    for i, tok in enumerate(tokens):
        if tok.lower() == "remember":
            for candidate in tokens[i + 1 :]:
                stripped = candidate.rstrip(".?!,").strip()
                if stripped.isdigit():
                    return stripped
    for tok in tokens:
        stripped = tok.rstrip(".?!,").strip()
        if stripped.isdigit():
            return stripped
    return None


def _build_messages_stateless(prompt: str, *, session_id: str = "mock-session") -> list[Any]:
    """Stateless message sequence for query()."""
    msgs: list[Any] = [SystemMessage(subtype="init", data={"session_id": session_id})]
    p = prompt.lower()

    if p.startswith("__auth_error__"):
        return ["__AUTH_ERROR__"]
    if p.startswith("__malformed__"):
        msgs.append(_WeirdMessage())
        msgs.append(AssistantMessage(content=[TextBlock("ok")]))
        msgs.append(ResultMessage(total_cost_usd=0.01))
        return msgs
    if p.startswith("__tool_error__"):
        msgs.append(ToolCallMessage(tool_use_id="tu_1", tool_name="Read", input={"path": "/etc/x"}))
        msgs.append(ToolResultMessage(tool_use_id="tu_1", content="permission denied", is_error=True))
        msgs.append(AssistantMessage(content=[TextBlock("I could not read.")]))
        msgs.append(ResultMessage(total_cost_usd=0.01))
        return msgs

    text = "Hi there!" if "hello" in p else f"Echo: {prompt}"
    msgs.append(AssistantMessage(content=[TextBlock(text)]))
    msgs.append(ResultMessage(total_cost_usd=0.01))
    return msgs


# ---------------------------------------------------------------------------
# query() — stateless async generator (single-turn path)
# ---------------------------------------------------------------------------


async def query(
    prompt: str, options: ClaudeAgentOptions | None = None
) -> AsyncIterator[Any]:
    """Stateless: each call starts a new session."""
    for m in _build_messages_stateless(prompt):
        if m == "__AUTH_ERROR__":
            raise ProcessError("authentication failed", exit_code=2, stderr="invalid api key")
        yield m


# ---------------------------------------------------------------------------
# ClaudeSDKClient — stateful (multi-turn path)
# ---------------------------------------------------------------------------


class ClaudeSDKClient:
    """Stateful client. Maintains conversation history across `query()` calls."""

    def __init__(self, options: ClaudeAgentOptions | None = None) -> None:
        self.options = options or ClaudeAgentOptions()
        self.session_id = f"mock-client-{id(self)}"
        self.history: list[str] = []
        self.queries: list[str] = []
        self.entered = False
        self.closed = False
        self._next_response: list[Any] = []

    async def __aenter__(self) -> "ClaudeSDKClient":
        self.entered = True
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self.closed = True
        return None

    async def query(self, prompt: str) -> None:
        self.queries.append(prompt)
        p = prompt.lower()
        text: str | None

        recall = None
        for hist in self.history:
            v = _extract_remember_value(hist)
            if v is not None:
                recall = v

        if p.startswith("__auth_error__"):
            text = None
        elif p.startswith("__tool_error__"):
            text = "__tool_error__"
        elif p.startswith("__malformed__"):
            text = "__malformed__"
        elif "what number" in p or "recall" in p:
            text = f"The number was {recall}." if recall else "I don't remember any number."
        elif "hello" in p:
            text = "Hi there!"
        else:
            text = f"Echo: {prompt}"

        self.history.append(prompt)
        self._next_response = self._build_response(text)

    def _build_response(self, text: str | None) -> list[Any]:
        msgs: list[Any] = [SystemMessage(subtype="status", data={"session_id": self.session_id})]
        if text == "__tool_error__":
            msgs.append(ToolCallMessage(tool_use_id="tu_e", tool_name="Read", input={"path": "/x"}))
            msgs.append(ToolResultMessage(tool_use_id="tu_e", content="permission denied", is_error=True))
            msgs.append(AssistantMessage(content=[TextBlock("I could not read.")]))
        elif text == "__malformed__":
            msgs.append(_WeirdMessage())
            msgs.append(AssistantMessage(content=[TextBlock("ok")]))
        elif text is None:
            msgs.append("__AUTH_ERROR__")
        else:
            msgs.append(AssistantMessage(content=[TextBlock(text)]))
        msgs.append(
            ResultMessage(
                status="ok",
                total_cost_usd=0.01,
                usage={"input_tokens": 7, "output_tokens": 3},
                session_id=self.session_id,
            )
        )
        return msgs

    async def receive_messages(self) -> AsyncIterator[Any]:
        pending = self._next_response
        self._next_response = []
        for m in pending:
            if m == "__AUTH_ERROR__":
                raise ProcessError("authentication failed", exit_code=2, stderr="invalid api key")
            yield m
