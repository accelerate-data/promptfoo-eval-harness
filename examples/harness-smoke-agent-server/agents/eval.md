# harness-smoke eval microagent

Minimal microagent for the openhands_agent_server smoke fixture. The provider
copies this file to `<workspace>/.openhands/microagents/repo.md` so the daemon
has a workspace-resident microagent to load. The content is intentionally
trivial — the smoke only verifies daemon boot + a one-shot "reply 'ready'"
turn; it does not exercise microagent semantics.

Respond to user messages with plain text only. Do not call tools.
