const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('smol-toml');

const { EVAL_ROOT, REPO_ROOT } = require('./roots');
const CONFIG_PATH = path.join(EVAL_ROOT, 'config', 'eval-tiers.toml');
const REQUIRED_TIERS = ['light', 'standard', 'high', 'x_high'];

// ---------------------------------------------------------------------------
// parseTierConfig — accept v0 (legacy OpenCode-only) OR v1 (multi-provider)
// ---------------------------------------------------------------------------

/**
 * Parse a tier config object (already deserialized from TOML or JSON) and
 * normalize it to the internal v1 representation.
 *
 * v0 shape: { runtime: {...}, tiers: { light: { agent: "..." }, ... } }
 * v1 shape: { version: "v1", tiers: { low: { providers: [...] } } }
 *
 * The returned object always has:
 *   { version: "v1" | "v1-normalized", tiers: { <name>: { providers: [...] } } }
 *
 * @param {object} raw - Deserialized config (TOML or JSON).
 * @param {string} [sourcePath] - Path hint for error messages.
 * @returns {{ version: string, tiers: object, concurrency?: object }}
 * @throws {Error} if the config is malformed.
 */
function parseTierConfig(raw, sourcePath = '<unknown>') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`parseTierConfig: expected a plain object at ${sourcePath}`);
  }

  // Detect v1: has explicit version:"v1" OR has tiers.X.providers arrays
  if (_isV1Shape(raw)) {
    _validateV1Shape(raw, sourcePath);
    return { ...raw, version: raw.version || 'v1' };
  }

  // Detect v0: has tiers.X.agent strings (legacy OpenCode-only shape)
  if (_isV0Shape(raw)) {
    return _normalizeV0ToV1(raw, sourcePath);
  }

  throw new Error(
    `parseTierConfig: cannot determine tier config version at ${sourcePath}. ` +
    'Expected either v0 shape (tiers.<name>.agent) or v1 shape (tiers.<name>.providers[]).',
  );
}

function _isV1Shape(raw) {
  if (raw.version === 'v1') return true;
  if (!raw.tiers || typeof raw.tiers !== 'object') return false;
  // Check if ANY tier has a providers array
  return Object.values(raw.tiers).some(
    (t) => t && Array.isArray(t.providers),
  );
}

function _isV0Shape(raw) {
  if (!raw.tiers || typeof raw.tiers !== 'object') return false;
  // All tiers have an agent field (v0 shape)
  return Object.values(raw.tiers).every(
    (t) => t && typeof t.agent === 'string',
  );
}

function _validateV1Shape(raw, sourcePath) {
  if (!raw.tiers || typeof raw.tiers !== 'object') {
    throw new Error(`parseTierConfig: missing tiers field at ${sourcePath}`);
  }
  for (const [tierName, tier] of Object.entries(raw.tiers)) {
    if (!tier || typeof tier !== 'object') {
      throw new Error(`parseTierConfig: tier "${tierName}" must be an object at ${sourcePath}`);
    }
    if (!Array.isArray(tier.providers)) {
      throw new Error(
        `parseTierConfig: tiers.${tierName}.providers must be an array at ${sourcePath}`,
      );
    }
    for (let i = 0; i < tier.providers.length; i++) {
      const p = tier.providers[i];
      if (!p || typeof p !== 'object') {
        throw new Error(
          `parseTierConfig: tiers.${tierName}.providers[${i}] must be an object at ${sourcePath}`,
        );
      }
      if (!p.provider_kind || typeof p.provider_kind !== 'string') {
        throw new Error(
          `parseTierConfig: tiers.${tierName}.providers[${i}].provider_kind is required at ${sourcePath}`,
        );
      }
    }
  }
}

function _normalizeV0ToV1(raw, sourcePath) {
  const normalizedTiers = {};
  for (const [tierName, tier] of Object.entries(raw.tiers)) {
    if (!tier || typeof tier.agent !== 'string' || tier.agent.trim() === '') {
      throw new Error(
        `parseTierConfig: v0 tier "${tierName}" missing valid agent field at ${sourcePath}`,
      );
    }
    normalizedTiers[tierName] = {
      providers: [
        {
          provider_kind: 'opencode_cli',
          label: tier.agent,
          model: null,
          agent_config: raw.runtime && raw.runtime.opencode_config
            ? raw.runtime.opencode_config
            : null,
        },
      ],
    };
  }
  return {
    version: 'v1-normalized',
    tiers: normalizedTiers,
    ...(raw.runtime ? { runtime: raw.runtime } : {}),
  };
}
const REQUIRED_RUNTIME_FIELDS = [
  'provider_id',
  'opencode_config',
  'project_dir',
  'format',
  'log_level',
  'print_logs',
];
// Optional runtime fields consumed by the ported glue providers
// (codex-sdk, claude-agent-sdk Node-side, opencode-cli-plugin sibling).
// Each field is OPTIONAL — absent fields surface as `undefined` and the
// consuming provider supplies its own default.
//   agent_id              string                       — phase-02/03/04 metadata
//   agent_entrypoint_file string                       — phase-02/03/04 metadata
//   bootstrap_prompt      string                       — phase-02/03/04 prompt prefix
//   auto_reply_text       string                       — phase-03 AskUserQuestion auto-reply
//   max_auto_replies      integer >= 0                 — phase-03 reply cap
//   idle_turn_stop        integer >= 0                 — phase-03 idle-turn detector
//   plugin_subdirs        array of non-empty strings   — phase-03 plugin discovery
//   opencode_runner_command  string                    — phase-04 OpenCode CLI override
//   opencode_plugin_link_path string                   — phase-04 symlink target
//   model                 non-empty string             — phase-02/03 model override
//   capture_on_failure    boolean                      — phase-04 stdout-on-failure
//   write_run_metadata    boolean                      — phase-04 emit .eval-run/provider.json
//   load_local_env        boolean                      — phase-04 load EVAL_ROOT/.env
//   opencode_parser_module string (require-path)       — phase-04 parser hook
const OPTIONAL_RUNTIME_FIELDS = [
  'empty_output_retries',
  'agent_id',
  'agent_entrypoint_file',
  'bootstrap_prompt',
  'auto_reply_text',
  'max_auto_replies',
  'idle_turn_stop',
  'plugin_subdirs',
  'opencode_runner_command',
  'opencode_plugin_link_path',
  'model',
  'capture_on_failure',
  'write_run_metadata',
  'load_local_env',
  'opencode_parser_module',
];
const ALLOWED_RUNTIME_FIELDS = new Set([
  ...REQUIRED_RUNTIME_FIELDS,
  ...OPTIONAL_RUNTIME_FIELDS,
]);
const STRING_OPTIONAL_FIELDS = [
  'agent_id',
  'agent_entrypoint_file',
  'bootstrap_prompt',
  'auto_reply_text',
  'opencode_runner_command',
  'opencode_plugin_link_path',
];
const NON_EMPTY_STRING_OPTIONAL_FIELDS = [
  'model',
  'opencode_parser_module',
];
const NON_NEGATIVE_INTEGER_OPTIONAL_FIELDS = [
  'max_auto_replies',
  'idle_turn_stop',
];
const BOOLEAN_OPTIONAL_FIELDS = [
  'capture_on_failure',
  'write_run_metadata',
  'load_local_env',
];
const ALLOWED_TIER_FIELDS = new Set(['agent']);
const REQUIRED_AGENT_PERMISSION = {
  read: 'allow',
  write: 'allow',
  edit: 'allow',
  bash: 'allow',
  grep: 'allow',
  glob: 'allow',
  list: 'allow',
  webfetch: 'deny',
};

function loadEvalTierConfig(configPath = CONFIG_PATH) {
  const parsed = parse(fs.readFileSync(configPath, 'utf8'));
  const runtime = parsed.runtime || {};
  const tiers = parsed.tiers || {};
  const baseDir = configPath === CONFIG_PATH ? EVAL_ROOT : path.dirname(configPath);
  const projectRoot = configPath === CONFIG_PATH ? REPO_ROOT : path.resolve(baseDir, '..');

  validateRuntime(runtime);

  const opencodeConfig = resolveWithinRoot(
    baseDir,
    runtime.opencode_config,
    `Refusing to access OpenCode config outside eval root: ${runtime.opencode_config}`,
  );
  const agents = loadOpenCodeAgents(opencodeConfig);

  for (const tier of REQUIRED_TIERS) {
    if (!tiers[tier] || typeof tiers[tier].agent !== 'string') {
      throw new Error(`Missing required eval tier: ${tier}`);
    }
  }

  for (const [tierName, tier] of Object.entries(tiers)) {
    if (typeof tier.agent !== 'string' || tier.agent.trim() === '') {
      throw new Error(`Invalid eval tier field: ${tierName}.agent`);
    }
    for (const field of Object.keys(tier)) {
      if (!ALLOWED_TIER_FIELDS.has(field)) {
        throw new Error(`Unexpected eval tier field: ${tierName}.${field}`);
      }
    }
    if (!agents[tier.agent]) {
      throw new Error(`Eval tier ${tierName} references missing OpenCode agent: ${tier.agent}`);
    }
    validateOpenCodeEvalAgent(tier.agent, agents[tier.agent]);
  }

  return {
    runtime: {
      providerId: runtime.provider_id,
      opencodeConfig,
      projectDir: resolveWithinRoot(
        baseDir,
        runtime.project_dir,
        projectRoot,
        `Refusing to use project directory outside eval root: ${runtime.project_dir}`,
      ),
      format: runtime.format,
      logLevel: runtime.log_level,
      printLogs: runtime.print_logs,
      emptyOutputRetries: normalizeEmptyOutputRetries(runtime.empty_output_retries),
      agentId: runtime.agent_id,
      agentEntrypointFile: runtime.agent_entrypoint_file,
      bootstrapPrompt: runtime.bootstrap_prompt,
      autoReplyText: runtime.auto_reply_text,
      maxAutoReplies: runtime.max_auto_replies,
      idleTurnStop: runtime.idle_turn_stop,
      pluginSubdirs: runtime.plugin_subdirs,
      opencodeRunnerCommand: runtime.opencode_runner_command,
      opencodePluginLinkPath: runtime.opencode_plugin_link_path,
      model: runtime.model,
      captureOnFailure: runtime.capture_on_failure,
      writeRunMetadata: runtime.write_run_metadata,
      loadLocalEnv: runtime.load_local_env,
      opencodeParserModule: runtime.opencode_parser_module,
    },
    tiers: Object.fromEntries(
      Object.entries(tiers).map(([tierName, tier]) => [tierName, { agent: tier.agent }]),
    ),
    agents,
  };
}

function resolveEvalTier(config, tierName) {
  const tier = config.tiers[tierName];
  if (!tier) {
    throw new Error(`Unknown eval tier: ${tierName}`);
  }

  return tier;
}

function validateRuntime(runtime) {
  for (const field of REQUIRED_RUNTIME_FIELDS) {
    if (field === 'print_logs') {
      if (typeof runtime[field] !== 'boolean') {
        throw new Error(`Missing required eval runtime field: ${field}`);
      }
      continue;
    }

    if (typeof runtime[field] !== 'string') {
      throw new Error(`Missing required eval runtime field: ${field}`);
    }
  }

  for (const field of Object.keys(runtime)) {
    if (!ALLOWED_RUNTIME_FIELDS.has(field)) {
      throw new Error(`Unexpected eval runtime field: ${field}`);
    }
  }

  normalizeEmptyOutputRetries(runtime.empty_output_retries);

  for (const field of STRING_OPTIONAL_FIELDS) {
    if (runtime[field] === undefined) continue;
    if (typeof runtime[field] !== 'string') {
      throw new Error(`Invalid eval runtime field: ${field} must be a string`);
    }
  }

  for (const field of NON_EMPTY_STRING_OPTIONAL_FIELDS) {
    if (runtime[field] === undefined) continue;
    if (typeof runtime[field] !== 'string' || runtime[field].trim() === '') {
      throw new Error(
        `Invalid eval runtime field: ${field} must be a non-empty string`,
      );
    }
  }

  for (const field of NON_NEGATIVE_INTEGER_OPTIONAL_FIELDS) {
    if (runtime[field] === undefined) continue;
    if (!Number.isInteger(runtime[field]) || runtime[field] < 0) {
      throw new Error(
        `Invalid eval runtime field: ${field} must be a non-negative integer`,
      );
    }
  }

  for (const field of BOOLEAN_OPTIONAL_FIELDS) {
    if (runtime[field] === undefined) continue;
    if (typeof runtime[field] !== 'boolean') {
      throw new Error(`Invalid eval runtime field: ${field} must be a boolean`);
    }
  }

  if (runtime.plugin_subdirs !== undefined) {
    if (!Array.isArray(runtime.plugin_subdirs)) {
      throw new Error(
        'Invalid eval runtime field: plugin_subdirs must be an array of non-empty strings',
      );
    }
    for (const entry of runtime.plugin_subdirs) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new Error(
          'Invalid eval runtime field: plugin_subdirs must be an array of non-empty strings',
        );
      }
    }
  }
}

function loadOpenCodeAgents(opencodeConfigPath) {
  const parsed = JSON.parse(fs.readFileSync(opencodeConfigPath, 'utf8'));
  const agents = parsed.agent || {};
  if (!isPlainObject(agents)) {
    throw new Error('Missing required OpenCode config field: agent');
  }

  return agents;
}

function validateOpenCodeEvalAgent(agentName, agent) {
  if (!isPlainObject(agent)) {
    throw new Error(`Invalid OpenCode eval agent: ${agentName}`);
  }

  for (const field of ['description', 'mode', 'model']) {
    if (typeof agent[field] !== 'string' || agent[field].trim() === '') {
      throw new Error(`Missing required OpenCode eval agent field: ${agentName}.${field}`);
    }
  }

  if (agent.mode !== 'primary') {
    throw new Error(`Invalid OpenCode eval agent field: ${agentName}.mode`);
  }

  if (agent.temperature !== undefined && typeof agent.temperature !== 'number') {
    throw new Error(`Invalid OpenCode eval agent field: ${agentName}.temperature`);
  }

  if (!Number.isInteger(agent.steps) || agent.steps <= 0) {
    throw new Error(`Invalid OpenCode eval agent field: ${agentName}.steps`);
  }

  if (!isPlainObject(agent.permission)) {
    throw new Error(`Missing required OpenCode eval agent field: ${agentName}.permission`);
  }

  for (const [permissionName, expectedAction] of Object.entries(REQUIRED_AGENT_PERMISSION)) {
    if (agent.permission[permissionName] !== expectedAction) {
      throw new Error(`Invalid OpenCode eval agent permission: ${agentName}.${permissionName}`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(agent, 'tools')) {
    throw new Error(`Unexpected OpenCode eval agent field: ${agentName}.tools`);
  }
}

function normalizeEmptyOutputRetries(value) {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Invalid eval runtime field: empty_output_retries');
  }

  return value;
}

function resolveWithinRoot(root, candidatePath, allowedRootOrErrorMessage, maybeErrorMessage) {
  const allowedRoot = maybeErrorMessage ? allowedRootOrErrorMessage : root;
  const errorMessage = maybeErrorMessage || allowedRootOrErrorMessage;
  const resolvedPath = path.resolve(root, candidatePath);
  ensureWithinRoot(resolvedPath, allowedRoot, errorMessage);
  return resolvedPath;
}

function ensureWithinRoot(candidatePath, root, errorMessage) {
  const normalizedRoot = path.resolve(root);
  const rootWithSeparator = `${normalizedRoot}${path.sep}`;
  if (candidatePath !== normalizedRoot && !candidatePath.startsWith(rootWithSeparator)) {
    throw new Error(errorMessage);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.getPrototypeOf(value) === Object.prototype;
}

module.exports = {
  CONFIG_PATH,
  REQUIRED_TIERS,
  ALLOWED_RUNTIME_FIELDS,
  REQUIRED_RUNTIME_FIELDS,
  OPTIONAL_RUNTIME_FIELDS,
  ALLOWED_TIER_FIELDS,
  loadEvalTierConfig,
  resolveEvalTier,
  parseTierConfig,
};
