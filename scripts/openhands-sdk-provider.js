// OpenHands SDK provider for promptfoo. Lives inside the harness so consumers
// can reference it via `framework://scripts/openhands-sdk-provider.js`.
//
// Receives the standard v0-shape harness config from resolveProviderBlock
// ({ agent, opencode_config, project_dir, format, ... }) and translates it
// to the v1 bridge config shape ({ provider_kind, model, run_id, case_id })
// before invoking the framework's _node_bridge.js factory.
//
// Why this wrapper exists: the multi-sdk plugin contract branch ships a
// KIND_REGISTRY in _node_bridge.js with openhands_sdk dispatch, but
// resolveProviderBlock (the path consumer's run-evals-local.js uses) still
// emits v0 config without `provider_kind`. This file bridges the gap until
// resolveMultiProviderConfig is wired into the materialization pipeline.
//
// Env overrides (see framework agent_factory.py):
//   OPENHANDS_MODEL_OVERRIDE — swap model per-run without editing tier config.
//   OPENAI_API_KEY            — required for openai/* model routing via LiteLLM.

const crypto = require('node:crypto');

const makeBridge = require('./framework/_node_bridge.js');

const TIER_TO_MODEL = {
  eval_light: 'openai/gpt-4o-mini',
  eval_standard: 'openai/gpt-4o-mini',
  eval_high: 'openai/gpt-4o-mini',
  eval_x_high: 'openai/gpt-4o-mini',
};

const RUN_ID = crypto.randomUUID();

module.exports = function makeOpenHandsSdkProvider(options = {}) {
  const v0 = options.config || {};
  const tier = v0.agent || 'eval_light';
  const model = TIER_TO_MODEL[tier] || 'openai/gpt-4o-mini';

  return makeBridge({
    ...options,
    config: {
      provider_kind: 'openhands_sdk',
      model,
      run_id: RUN_ID,
      case_id: `${tier}/${model}`,
      provider_label: `openhands_sdk/${tier}`,
    },
  });
};
