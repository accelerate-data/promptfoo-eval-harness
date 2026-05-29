// Claude Agent SDK provider for promptfoo (Node-side, in-process).
// Lives inside the harness so consumers can reference it via
// `framework://claude-agent-sdk-provider.js`.
//
// Transport name: `claude_agent_sdk_node` — distinct from the existing
// bridge-routed Python transport `claude_agent_sdk` (which lives under
// `scripts/framework/providers/claude_agent_sdk/`). These are TWO separate
// transports; consumers pick by `provider_id` (this Node-side wrapper) vs
// `provider_kind` (Python bridge). See `docs/design.md` for the comparison
// table.
//
// Why a Node wrapper instead of routing through the Python bridge:
//   - Uses `@anthropic-ai/claude-agent-sdk` (Node) streaming-input mode so we
//     can auto-reply to AskUserQuestion / approval-gate turns.
//   - Maintains a `qa-log.jsonl` artifact with `event: 'auto-reply' |
//     'idle-stop' | 'auto-reply-cap-hit'` entries.
//   - Implements an idle-turn stop so coordinator workflows exit cleanly.
//
// Streaming-input behavior:
//   - The SDK terminates after one turn when `prompt` is a string. We pass an
//     async iterable and push auto-reply user messages from a controller queue.
//   - After each successful agent turn the wrapper inspects whether the turn
//     used any tool / asked an AskUserQuestion. If the turn is idle (no tool,
//     no question), `consecutiveIdleTurns` increments; we stop after
//     `idle_turn_stop` consecutive idle turns. Otherwise we push
//     `auto_reply_text` and continue, up to `max_auto_replies`.
//
// Workspace resolution (per-call):
//   1. `ctx.vars.workspace` (Promptfoo per-row override)
//   2. Prompt regex `/(?:Workspace:|operating in workspace)\s*(\S+)/i`
//   3. `cfg.project_dir` resolved against EVAL_ROOT
//   4. EVAL_ROOT (final fallback — matches consumer behavior)
//
// SDK path discovery:
//   1. `require.resolve('@anthropic-ai/claude-agent-sdk/sdk.mjs', { paths: [EVAL_ROOT, FRAMEWORK_ROOT] })`
//   2. Fallback: `EVAL_ROOT/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`
//   3. Throw actionable error if neither exists.
//
// Concurrency: wraps `_runAgent` in `concurrency.acquire('claude_agent_sdk_node')`
// so the kind shares the framework's gating registry alongside other transports.
//
// Abort propagation: `opts.abortSignal` (Promptfoo) is forwarded to an
// `AbortController` passed via SDK `options.abortController`. On abort we also
// call `endInput()` to drain the input stream.
//
// Security note: `permissionMode: 'bypassPermissions'` +
// `allowDangerouslySkipPermissions: true` are intentional in eval runs — the
// agent operates inside a per-case workspace, no human-in-the-loop.
//
// Env overrides:
//   CLAUDE_CODE_EXECUTABLE — path to the `claude` binary. If unset, the
//     wrapper probes `~/.local/bin/claude`, `/usr/local/bin/claude`,
//     `/usr/bin/claude` and forwards the first hit; if no match found,
//     omits `pathToClaudeCodeExecutable` so the SDK uses its PATH lookup.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { EVAL_ROOT, FRAMEWORK_ROOT } = require('./roots');
const { writeProviderRunMetadata } = require('./provider-run-metadata');
const concurrency = require('./concurrency');

const TRANSPORT_NAME = 'claude_agent_sdk_node';
const PROVIDER_ID = 'framework://claude-agent-sdk-provider.js';

const DEFAULT_AUTO_REPLY_TEXT =
  '✅ Approved. If the original request is now complete, write a one-paragraph summary of what was built/changed and STOP — do not start new work, do not run git/commit/push, do not explore the broader project, do not invoke nested evals. If a real next phase of the original request remains, continue with just that phase.';
const DEFAULT_MAX_AUTO_REPLIES = 5;
const DEFAULT_IDLE_TURN_STOP = 2;

function extractWorkspace(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/(?:Workspace:|operating in workspace)\s*(\S+)/i);
  return m ? m[1].replace(/\.$/, '') : null;
}

function makeUserMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  };
}

function findSdkPath() {
  try {
    return require.resolve('@anthropic-ai/claude-agent-sdk/sdk.mjs', {
      paths: [EVAL_ROOT, FRAMEWORK_ROOT],
    });
  } catch (_) {
    /* fall through */
  }
  const evalPath = path.resolve(
    EVAL_ROOT,
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  );
  if (fs.existsSync(evalPath)) return evalPath;
  throw new Error(
    '@anthropic-ai/claude-agent-sdk not found. Install it in tests/evals/package.json or the harness.',
  );
}

function findClaudeExecutable() {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return process.env.CLAUDE_CODE_EXECUTABLE;
  return [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ].find((p) => fs.existsSync(p));
}

function resolveTierConfig(cfg) {
  if (!cfg.opencode_config || !cfg.agent) return {};
  try {
    const abs = path.resolve(EVAL_ROOT, cfg.opencode_config);
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return (parsed && parsed.agent && parsed.agent[cfg.agent]) || {};
  } catch (_) {
    return {};
  }
}

function buildSdkRunMetadata({ providerId, cfg, projectDir, plugins }) {
  return {
    provider_id: providerId,
    transport: TRANSPORT_NAME,
    agent: cfg.agent_id || null,
    agent_tier: cfg.agent || null,
    agent_runtime: 'claude-agent-sdk plugin agent',
    agent_identity_source: 'claude-agent-sdk options.agent',
    agent_entrypoint_identity: cfg.agent_id || null,
    agent_entrypoint_file: cfg.agent_entrypoint_file || null,
    agent_semantics: 'real plugin agent entrypoint',
    plugin_runtime_loaded: plugins.length > 0,
    plugins: plugins.map((plugin) => path.relative(projectDir, plugin.path)),
    opencode_config: cfg.opencode_config || null,
  };
}

function resolveWorkspace(cfg, context, prompt, projectDir) {
  const varsWorkspace = context && context.vars && context.vars.workspace;
  return varsWorkspace || extractWorkspace(prompt) || projectDir;
}

function buildPlugins(cfg, projectDir) {
  const subdirs = Array.isArray(cfg.plugin_subdirs) ? cfg.plugin_subdirs : [];
  return subdirs
    .map((subdir) => ({ type: 'local', path: path.resolve(projectDir, subdir) }))
    .filter((p) => fs.existsSync(p.path));
}

function openQaLog(workspace) {
  const qaLogPath = path.join(workspace, '.eval-run', 'qa-log.jsonl');
  try {
    fs.mkdirSync(path.dirname(qaLogPath), { recursive: true });
  } catch (_) {
    /* best-effort */
  }
  return (entry) => {
    try {
      fs.appendFileSync(qaLogPath, `${JSON.stringify(entry)}\n`);
    } catch (_) {
      /* best-effort */
    }
  };
}

async function runAgent(cfg, providerId, prompt, context, signal) {
  const sdkPath = findSdkPath();
  const { query } = await import(sdkPath);

  const projectDir = cfg.project_dir
    ? path.resolve(EVAL_ROOT, cfg.project_dir)
    : EVAL_ROOT;
  const plugins = buildPlugins(cfg, projectDir);
  const workspace = resolveWorkspace(cfg, context, prompt, projectDir);

  writeProviderRunMetadata(
    workspace,
    buildSdkRunMetadata({ providerId, cfg, projectDir, plugins }),
  );

  const appendQaLog = openQaLog(workspace);

  const tierCfg = resolveTierConfig(cfg);
  const model = tierCfg.model;
  const maxTurns = tierCfg.steps || 100;

  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const pathToClaudeCodeExecutable = findClaudeExecutable();

  // ---- Streaming-input controller -----------------------------------------
  const inputQueue = [makeUserMessage(prompt)];
  let resolveNextInput = null;
  let inputEnded = false;

  const pushAutoReply = (text) => {
    inputQueue.push(makeUserMessage(text));
    if (resolveNextInput) {
      resolveNextInput();
      resolveNextInput = null;
    }
  };
  const endInput = () => {
    inputEnded = true;
    if (resolveNextInput) {
      resolveNextInput();
      resolveNextInput = null;
    }
  };
  if (signal) {
    signal.addEventListener('abort', endInput, { once: true });
  }

  async function* inputStream() {
    while (true) {
      while (inputQueue.length > 0) yield inputQueue.shift();
      if (inputEnded) return;
      await new Promise((r) => {
        resolveNextInput = r;
      });
    }
  }

  const q = query({
    prompt: inputStream(),
    options: {
      cwd: workspace,
      model,
      maxTurns,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(cfg.agent_id ? { agent: cfg.agent_id } : {}),
      plugins,
      persistSession: false,
      abortController,
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    },
  });

  // ---- Output collection + turn-end detection ----------------------------
  const autoReplyText =
    typeof cfg.auto_reply_text === 'string' && cfg.auto_reply_text
      ? cfg.auto_reply_text
      : DEFAULT_AUTO_REPLY_TEXT;
  const maxAutoReplies = Number.isInteger(cfg.max_auto_replies)
    ? cfg.max_auto_replies
    : DEFAULT_MAX_AUTO_REPLIES;
  const idleTurnStop = Number.isInteger(cfg.idle_turn_stop)
    ? cfg.idle_turn_stop
    : DEFAULT_IDLE_TURN_STOP;

  const textParts = [];
  let currentTurnText = '';
  let currentTurnHasTool = false;
  let lastAskUserQuestion = null;
  let lastSuccessResult = null;
  let autoReplyCount = 0;
  let consecutiveIdleTurns = 0;
  let runError = null;

  try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content || []) {
          if (block.type === 'text') {
            textParts.push(block.text);
            currentTurnText += `${block.text}\n`;
          } else if (block.type === 'tool_use') {
            currentTurnHasTool = true;
            if (block.name === 'AskUserQuestion') {
              lastAskUserQuestion = block.input || null;
            }
          }
        }
      } else if (msg.type === 'result') {
        if (msg.is_error) {
          runError = new Error(
            `Agent run failed: ${msg.errors?.join('; ') || msg.subtype}`,
          );
          endInput();
          continue;
        }
        if (msg.subtype === 'success') {
          lastSuccessResult = msg.result || lastSuccessResult;
          const isIdleTurn = !currentTurnHasTool && !lastAskUserQuestion;
          if (isIdleTurn) consecutiveIdleTurns += 1;
          else consecutiveIdleTurns = 0;

          if (consecutiveIdleTurns >= idleTurnStop) {
            appendQaLog({ event: 'idle-stop', consecutive_idle: consecutiveIdleTurns });
            endInput();
            continue;
          }
          if (autoReplyCount >= maxAutoReplies) {
            appendQaLog({ event: 'auto-reply-cap-hit', cap: maxAutoReplies });
            endInput();
            continue;
          }
          autoReplyCount += 1;
          appendQaLog({
            event: 'auto-reply',
            turn: autoReplyCount,
            last_assistant_text: currentTurnText.trim().slice(0, 4000),
            ask_user_question: lastAskUserQuestion,
            auto_reply: autoReplyText,
          });
          currentTurnText = '';
          currentTurnHasTool = false;
          lastAskUserQuestion = null;
          pushAutoReply(autoReplyText);
        } else {
          endInput();
        }
      }
    }
  } finally {
    try {
      q.close?.();
    } catch (_) {
      /* best-effort */
    }
    endInput();
  }

  if (runError) throw runError;
  return lastSuccessResult ?? textParts.join('\n');
}

async function callWithRetries(cfg, providerId, prompt, context, signal) {
  const maxAttempts = 1 + Math.max(0, Number(cfg.empty_output_retries) || 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const output = await runAgent(cfg, providerId, prompt, context, signal);
    if (output && output.trim()) return output;
  }
  throw new Error(
    `Claude agent SDK returned empty output after ${maxAttempts} attempt(s)`,
  );
}

module.exports = function makeClaudeAgentSdkProvider(options = {}) {
  const cfg = options.config || {};
  const providerId = options.id || PROVIDER_ID;
  const labelTier = cfg.agent || 'default';
  const label = cfg.agent_id
    ? `${TRANSPORT_NAME}/${cfg.agent_id}/${labelTier}`
    : `${TRANSPORT_NAME}/${labelTier}`;

  return {
    id: () => providerId,
    label,
    async callApi(prompt, context, callOptions = {}) {
      const slot = await concurrency.acquire(TRANSPORT_NAME);
      try {
        const output = await callWithRetries(
          cfg,
          providerId,
          prompt,
          context,
          callOptions.abortSignal,
        );
        return { output };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      } finally {
        slot.release();
      }
    },
  };
};

module.exports.__private = {
  TRANSPORT_NAME,
  PROVIDER_ID,
  DEFAULT_AUTO_REPLY_TEXT,
  DEFAULT_MAX_AUTO_REPLIES,
  DEFAULT_IDLE_TURN_STOP,
  extractWorkspace,
  findSdkPath,
  findClaudeExecutable,
  resolveTierConfig,
  buildSdkRunMetadata,
  buildPlugins,
  resolveWorkspace,
};
