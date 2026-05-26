const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

const { loadEvalTierConfig, resolveEvalTier, parseTierConfig } = require('./eval-tier-config');
const { EVAL_ROOT, FRAMEWORK_ROOT } = require('./roots');

const FRAMEWORK_SCHEME = 'framework://';

const TMP_ROOT = path.join(EVAL_ROOT, '.tmp', 'resolved-configs');

function readYaml(relativePath) {
  const normalizedPath = normalizeConfigPath(relativePath);
  return yaml.load(fs.readFileSync(path.join(EVAL_ROOT, normalizedPath), 'utf8'));
}

function resolveProviderBlock(evalTier) {
  const suiteConfig = loadEvalTierConfig();
  const resolvedTier = resolveEvalTier(suiteConfig, evalTier);

  return {
    id: resolveProviderId(suiteConfig.runtime.providerId),
    config: {
      agent: resolvedTier.agent,
      opencode_config: suiteConfig.runtime.opencodeConfig,
      project_dir: suiteConfig.runtime.projectDir,
      format: suiteConfig.runtime.format,
      log_level: suiteConfig.runtime.logLevel,
      print_logs: suiteConfig.runtime.printLogs,
      empty_output_retries: suiteConfig.runtime.emptyOutputRetries,
      agent_id: suiteConfig.runtime.agentId,
      agent_entrypoint_file: suiteConfig.runtime.agentEntrypointFile,
      bootstrap_prompt: suiteConfig.runtime.bootstrapPrompt,
      auto_reply_text: suiteConfig.runtime.autoReplyText,
      max_auto_replies: suiteConfig.runtime.maxAutoReplies,
      idle_turn_stop: suiteConfig.runtime.idleTurnStop,
      plugin_subdirs: suiteConfig.runtime.pluginSubdirs,
      opencode_runner_command: suiteConfig.runtime.opencodeRunnerCommand,
      opencode_plugin_link_path: suiteConfig.runtime.opencodePluginLinkPath,
      model: suiteConfig.runtime.model,
      capture_on_failure: suiteConfig.runtime.captureOnFailure,
      write_run_metadata: suiteConfig.runtime.writeRunMetadata,
      load_local_env: suiteConfig.runtime.loadLocalEnv,
      opencode_parser_module: suiteConfig.runtime.opencodeParserModule,
    },
  };
}

function resolveProviderId(providerId) {
  if (providerId.startsWith(FRAMEWORK_SCHEME)) {
    const providerPath = providerId.slice(FRAMEWORK_SCHEME.length);
    return `file://${path.join(FRAMEWORK_ROOT, providerPath)}`;
  }

  if (!providerId.startsWith('file://')) {
    return providerId;
  }

  const providerPath = providerId.slice('file://'.length);
  if (path.isAbsolute(providerPath)) {
    return providerId;
  }

  return `file://${path.join(EVAL_ROOT, providerPath)}`;
}

function resolveConfigFile(relativePath) {
  const normalizedPath = normalizeConfigPath(relativePath);
  const parsed = readYaml(normalizedPath);
  const evalTier = parsed?.metadata?.eval_tier;
  if (!evalTier) {
    throw new Error(`${normalizedPath} is missing metadata.eval_tier`);
  }

  const sourceConfigDir = path.dirname(path.join(EVAL_ROOT, normalizedPath));
  const targetConfigDir = path.dirname(path.join(TMP_ROOT, normalizedPath));

  return {
    ...rewriteRelativeFileUrls(parsed, sourceConfigDir, targetConfigDir),
    providers: [resolveProviderBlock(evalTier)],
  };
}

function writeResolvedConfig(
  relativePath,
  {
    fsImpl = fs,
    outputRoot = TMP_ROOT,
  } = {},
) {
  const normalizedPath = normalizeConfigPath(relativePath);
  const normalizedOutputRoot = normalizeOutputRoot(outputRoot);

  fsImpl.mkdirSync(normalizedOutputRoot, { recursive: true });
  const resolved = resolveConfigFile(normalizedPath);
  const outputPath = resolveWithinRoot(
    normalizedOutputRoot,
    normalizedPath,
    `Refusing to write resolved config outside output root: ${normalizedPath}`,
  );
  fsImpl.mkdirSync(path.dirname(outputPath), { recursive: true });
  fsImpl.writeFileSync(outputPath, yaml.dump(resolved), 'utf8');
  return path.relative(EVAL_ROOT, outputPath);
}

function normalizeConfigPath(relativePath) {
  const resolvedPath = resolveWithinRoot(
    EVAL_ROOT,
    relativePath,
    `Refusing to access config outside eval root: ${relativePath}`,
  );
  return path.relative(EVAL_ROOT, resolvedPath);
}

function normalizeOutputRoot(outputRoot) {
  const resolvedRoot = path.resolve(outputRoot);
  ensureWithinRoot(
    resolvedRoot,
    TMP_ROOT,
    `Refusing to write resolved configs outside ${path.relative(EVAL_ROOT, TMP_ROOT)}`,
  );
  return resolvedRoot;
}

function resolveWithinRoot(root, candidatePath, errorMessage) {
  const resolvedPath = path.resolve(root, candidatePath);
  ensureWithinRoot(resolvedPath, root, errorMessage);
  return resolvedPath;
}

function ensureWithinRoot(candidatePath, root, errorMessage) {
  const normalizedRoot = path.resolve(root);
  const rootWithSeparator = `${normalizedRoot}${path.sep}`;
  if (candidatePath !== normalizedRoot && !candidatePath.startsWith(rootWithSeparator)) {
    throw new Error(errorMessage);
  }
}

function rewriteRelativeFileUrls(value, sourceConfigDir, targetConfigDir) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteRelativeFileUrls(item, sourceConfigDir, targetConfigDir));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        rewriteRelativeFileUrls(entryValue, sourceConfigDir, targetConfigDir),
      ]),
    );
  }

  if (typeof value !== 'string' || !value.startsWith('file://')) {
    return value;
  }

  const match = /^file:\/\/([^:]+)(:.*)?$/.exec(value);
  if (!match) {
    return value;
  }

  const [, fileTarget, suffix = ''] = match;
  if (path.isAbsolute(fileTarget)) {
    return value;
  }

  const absoluteTarget = path.resolve(sourceConfigDir, fileTarget);
  ensureWithinRoot(
    absoluteTarget,
    EVAL_ROOT,
    `Refusing to rewrite file reference outside eval root: ${value}`,
  );
  const rewrittenTarget = path.relative(targetConfigDir, absoluteTarget).split(path.sep).join('/');
  return `file://${rewrittenTarget}${suffix}`;
}

// ---------------------------------------------------------------------------
// Single bridge URL emitter — v1 multi-provider tier support (spec §2.2, §4.3)
// ---------------------------------------------------------------------------

/**
 * The canonical bridge URL (spec §2.2).
 * All provider entries point here regardless of provider_kind.
 */
const BRIDGE_FILE_URL = `file://${path.join(FRAMEWORK_ROOT, '_node_bridge.js')}`;

/**
 * Build a stable run_id for a single ad-evals invocation.
 * Stable per process (generated once, cached).
 */
let _runId = null;
function getRunId() {
  if (!_runId) {
    _runId = crypto.randomUUID();
  }
  return _runId;
}

/**
 * Reset run_id (for testing only).
 */
function _resetRunId() {
  _runId = null;
}

/**
 * Build a deterministic case_id for a (tier × provider_index × scenario_index) tuple.
 *
 * @param {string} tierName
 * @param {number} providerIndex
 * @param {number} scenarioIndex
 * @param {string} runId
 * @returns {string}
 */
function _buildCaseId(tierName, providerIndex, scenarioIndex, runId) {
  return `${runId}:${tierName}:p${providerIndex}:s${scenarioIndex}`;
}

/**
 * Build a single Promptfoo provider entry for one (tier × provider) combination.
 *
 * @param {string} tierName
 * @param {object} providerEntry - One entry from tiers.<name>.providers[]
 * @param {number} providerIndex
 * @param {number} scenarioIndex
 * @param {string} runId
 * @returns {object} Promptfoo provider object
 */
function _buildBridgeProviderEntry(tierName, providerEntry, providerIndex, scenarioIndex, runId) {
  const { provider_kind, model, label, agent_config, ...rest } = providerEntry;
  // Build provider_options from remaining fields (not provider_kind / model / label)
  const provider_options = Object.keys(rest).length > 0 ? rest : undefined;

  const config = {
    provider_kind,
    model: model || null,
    run_id: runId,
    case_id: _buildCaseId(tierName, providerIndex, scenarioIndex, runId),
    ...(label ? { provider_label: label } : {}),
    ...(provider_options ? { provider_options } : {}),
  };

  return {
    id: BRIDGE_FILE_URL,
    label: label || `${tierName}/${provider_kind}/${model || 'unknown'}`,
    config,
  };
}

/**
 * Resolve a Promptfoo config from a v1 tier config + scenarios list.
 * Emits exactly ONE bridge URL per (tier × provider × scenario).
 *
 * Per spec §4.1: --compare semantics are deferred to Phase 2.
 * This function does NOT emit --compare or per-provider fan-out.
 *
 * @param {object} tierConfig - v1 tier config (or v0, will be normalized via parseTierConfig).
 * @param {Array<object>} scenarios - Array of Promptfoo test case objects.
 * @param {string} [tierName] - If specified, only emit providers for this tier.
 * @param {object} [opts]
 * @param {string} [opts.runId] - Override run_id (default: stable per-process UUID).
 * @returns {{ providers: object[], tests: object[] }} Promptfoo config fragment.
 */
function resolveMultiProviderConfig(tierConfig, scenarios, tierName, opts = {}) {
  const normalized = parseTierConfig(tierConfig, opts.sourcePath || '<input>');
  const runId = opts.runId || getRunId();

  const tiersToProcess = tierName
    ? { [tierName]: normalized.tiers[tierName] }
    : normalized.tiers;

  if (tierName && !normalized.tiers[tierName]) {
    throw new Error(`resolveMultiProviderConfig: unknown tier "${tierName}"`);
  }

  const providers = [];

  for (const [tName, tier] of Object.entries(tiersToProcess)) {
    for (let pIdx = 0; pIdx < tier.providers.length; pIdx++) {
      for (let sIdx = 0; sIdx < scenarios.length; sIdx++) {
        providers.push(
          _buildBridgeProviderEntry(tName, tier.providers[pIdx], pIdx, sIdx, runId),
        );
      }
    }
  }

  return {
    providers,
    tests: scenarios,
  };
}

module.exports = {
  TMP_ROOT,
  BRIDGE_FILE_URL,
  resolveConfigFile,
  resolveProviderBlock,
  resolveProviderId,
  writeResolvedConfig,
  resolveMultiProviderConfig,
  getRunId,
  _resetRunId,
};
