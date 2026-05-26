// Codex SDK provider for promptfoo. Lives inside the harness so consumers
// can reference it via `framework://codex-sdk-provider.js` (resolves to
// <FRAMEWORK_ROOT>/codex-sdk-provider.js, i.e. this file).
//
// Receives the standard v0-shape harness config from resolveProviderBlock
// ({ agent, opencode_config, project_dir, bootstrap_prompt, agent_id, ... })
// and translates it to the v1 bridge config shape
// ({ provider_kind: 'codex_sdk', model, run_id, case_id, extra, workspace_root })
// before invoking the framework's _node_bridge.js factory.
//
// Bootstrap_prompt (when set) is prepended to the prompt INSIDE the overridden
// callApi so the bridged provider (`providers/codex_sdk/provider.js`) stays
// scenario-agnostic.
//
// Workspace resolution (per-call, inside callApi):
//   1. Prompt regex `/(?:Workspace:|operating in workspace)\s*(\S+)/i` match
//   2. `cfg.project_dir` resolved against EVAL_ROOT
//   3. undefined → bridge mkdtemps a per-case workspace
//
// Tier-config fallback: when `cfg.model` is unset, the wrapper reads
// `cfg.opencode_config` (a JSON tier file shaped like
// `{ agent: { [tier]: { model, sandboxMode, modelReasoningEffort, approvalPolicy } } }`)
// and reuses its values. Camel → snake_case translation happens here so the
// downstream `providers/codex_sdk/provider.js` only sees its expected
// `cfg.extra.sandbox_mode` / `cfg.extra.reasoning_effort` keys.
//
// Env overrides:
//   OPENAI_API_KEY   — required (consumed by providers/codex_sdk/provider.js)
//   OPENAI_BASE_URL  — optional override

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const makeBridge = require('./_node_bridge.js');
const { EVAL_ROOT } = require('./roots');

const RUN_ID = crypto.randomUUID();
const WORKSPACE_REGEX = /(?:Workspace:|operating in workspace)\s*(\S+)/i;

function extractWorkspace(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(WORKSPACE_REGEX);
  return m ? m[1].replace(/\.$/, '') : null;
}

function resolveTierConfig(configPath, agent) {
  if (!configPath || !agent) return {};
  try {
    const abs = path.resolve(EVAL_ROOT, configPath);
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return (parsed && parsed.agent && parsed.agent[agent]) || {};
  } catch (_) {
    return {};
  }
}

module.exports = function makeCodexSdkProvider(options = {}) {
  const v0 = options.config || {};
  const agent = v0.agent || 'eval_light';
  const tierCfg = resolveTierConfig(v0.opencode_config, agent);
  const model = v0.model || tierCfg.model || 'gpt-5.4';
  const providerLabel = v0.agent_id
    ? `codex_sdk/${v0.agent_id}/${agent}`
    : `codex_sdk/${agent}`;

  const bridgeTemplate = {
    provider_kind: 'codex_sdk',
    model,
    run_id: RUN_ID,
    case_id: `${agent}/${model}`,
    provider_label: providerLabel,
    extra: {
      sandbox_mode: tierCfg.sandboxMode || 'danger-full-access',
      reasoning_effort: tierCfg.modelReasoningEffort || 'medium',
      approval_policy: tierCfg.approvalPolicy || 'never',
    },
  };

  function prefixPrompt(prompt) {
    if (typeof v0.bootstrap_prompt === 'string' && v0.bootstrap_prompt) {
      return `${v0.bootstrap_prompt}\n\n${prompt}`;
    }
    return prompt;
  }

  function resolveWorkspaceRoot(prefixed) {
    const extracted = extractWorkspace(prefixed);
    if (extracted) return path.resolve(extracted);
    if (v0.project_dir) return path.resolve(EVAL_ROOT, v0.project_dir);
    return undefined;
  }

  const providerId = `framework://codex-sdk-provider.js`;

  return {
    id: () => providerId,
    label: providerLabel,
    async callApi(prompt, ctx, opts) {
      const prefixed = prefixPrompt(prompt);
      const workspaceRoot = resolveWorkspaceRoot(prefixed);

      const bridgeConfig = {
        ...bridgeTemplate,
        ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
      };

      const bridge = makeBridge({
        ...options,
        config: bridgeConfig,
      });

      return bridge.callApi(prefixed, ctx, opts);
    },
  };
};

module.exports.__private = {
  RUN_ID,
  extractWorkspace,
  resolveTierConfig,
};
