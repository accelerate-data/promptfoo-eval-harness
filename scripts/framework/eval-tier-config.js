const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('smol-toml');

const { EVAL_ROOT, REPO_ROOT } = require('./roots');
const CONFIG_PATH = path.join(EVAL_ROOT, 'config', 'eval-tiers.toml');
const REQUIRED_TIERS = ['light', 'standard', 'high', 'x_high'];
const REQUIRED_RUNTIME_FIELDS = [
  'provider_id',
  'opencode_config',
  'project_dir',
  'format',
  'log_level',
  'print_logs',
];
const ALLOWED_RUNTIME_FIELDS = new Set([
  ...REQUIRED_RUNTIME_FIELDS,
  'empty_output_retries',
]);
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
  loadEvalTierConfig,
  resolveEvalTier,
};
