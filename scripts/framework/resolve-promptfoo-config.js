const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { parse: parseToml } = require('smol-toml');

const {
  CONFIG_PATH: TIER_CONFIG_PATH,
  loadEvalTierConfig,
  resolveEvalTier,
  parseTierConfig,
} = require('./eval-tier-config');
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

function _readRawTierConfig(configPath = TIER_CONFIG_PATH, { fsImpl = fs } = {}) {
  return parseToml(fsImpl.readFileSync(configPath, 'utf8'));
}

/**
 * True when a single Promptfoo test declares a multi-turn sequence (vars.turns).
 * Accepts the JSON-encoded string form (what consumers write) and the legacy
 * JS-array form.
 *
 * @param {object} testObj
 * @returns {boolean}
 */
function _hasTurnsVar(testObj) {
  const turns = testObj && testObj.vars && testObj.vars.turns;
  if (Array.isArray(turns)) return turns.length > 0;
  return typeof turns === 'string' && turns.trim().length > 0;
}

/**
 * True when a parsed config declares ANY multi-turn test (in tests[] or
 * defaultTest). Multi-turn needs the persistent SDK session in _node_bridge.js,
 * which the v0 CLI provider cannot drive — so the resolver auto-routes such a
 * package through the bridge using the [multiturn] block (see
 * resolveMultiTurnProviderBlock).
 *
 * @param {object} parsed - Parsed promptfooconfig.
 * @returns {boolean}
 */
function _hasMultiTurnTest(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (_hasTurnsVar(parsed.defaultTest)) return true;
  if (Array.isArray(parsed.tests)) return parsed.tests.some(_hasTurnsVar);
  return false;
}

/**
 * Build a single bridge provider block from the top-level [multiturn] table of
 * eval-tiers.toml. Emitted in place of the v0 CLI provider when a package has a
 * multi-turn test, so the package config needs no package-local providers block
 * — declaring metadata.eval_tier is enough.
 *
 * Fields land at config TOP LEVEL because _node_bridge.js#parseProviderConfig
 * reads them directly (it only strips Promptfoo's injected basePath). The shape
 * mirrors a hand-written opencode_sdk/openhands_sdk providers block.
 *
 * @param {object} rawTier - Raw tier config (TOML/JSON); may carry .multiturn.
 * @returns {{ id: string, label: string, config: object }}
 * @throws if [multiturn] is missing or malformed.
 */
function resolveMultiTurnProviderBlock(rawTier) {
  const mt = rawTier && rawTier.multiturn;
  if (!mt || typeof mt !== 'object' || Array.isArray(mt)) {
    throw new Error(
      'Config declares a multi-turn test (vars.turns) but config/eval-tiers.toml has no ' +
        '[multiturn] block. Multi-turn needs the SDK bridge, which the tier CLI provider ' +
        'cannot drive — add a [multiturn] table with provider_kind and model (see docs/setup.md).',
    );
  }
  if (!mt.provider_kind || typeof mt.provider_kind !== 'string') {
    throw new Error('[multiturn].provider_kind is required (e.g. "opencode_sdk")');
  }
  if (!mt.model || typeof mt.model !== 'string') {
    throw new Error('[multiturn].model is required (e.g. "opencode-go/qwen3.5-plus")');
  }

  const label = mt.label || `${mt.provider_kind}/${mt.model}`;
  const config = {
    provider_kind: mt.provider_kind,
    provider_label: label,
    model: mt.model,
  };
  // opencode_sdk picks its agent from extra.opencode_agent, falling back to a
  // top-level `agent`. Python subprocess SDK kinds (openhands_sdk, codex_sdk)
  // build their own SDK agent and their ProviderConfig has no `agent` field, so
  // a top-level `agent` is silently dropped for those — it only affects opencode_sdk.
  if (mt.opencode_agent) {
    config.extra = { opencode_agent: mt.opencode_agent };
  }
  if (mt.agent) {
    config.agent = mt.agent;
  }
  return { id: BRIDGE_FILE_URL, label, config };
}

function _isV1RawShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.version === 'v1') return true;
  if (!raw.tiers || typeof raw.tiers !== 'object') return false;
  return Object.values(raw.tiers).some(
    (t) => t && Array.isArray(t.providers),
  );
}

function resolveConfigFile(relativePath, { rawTierConfig = null } = {}) {
  const normalizedPath = normalizeConfigPath(relativePath);
  const parsed = readYaml(normalizedPath);
  const evalTier = parsed?.metadata?.eval_tier;
  if (!evalTier) {
    throw new Error(`${normalizedPath} is missing metadata.eval_tier`);
  }

  const sourceConfigDir = path.dirname(path.join(EVAL_ROOT, normalizedPath));
  const targetConfigDir = path.dirname(path.join(TMP_ROOT, normalizedPath));
  const rewritten = rewriteRelativeFileUrls(parsed, sourceConfigDir, targetConfigDir);

  const rawTier = rawTierConfig || _readRawTierConfig();
  if (_isV1RawShape(rawTier)) {
    // Phase 1: collapse scenario fan-out — Promptfoo iterates the consumer's
    // tests[] array against each emitted provider. Per-scenario provider
    // entries (--compare semantics) are deferred to Phase 2.
    const { providers: rawProviders } = resolveMultiProviderConfig(
      rawTier,
      [{}],
      evalTier,
      { sourcePath: TIER_CONFIG_PATH },
    );
    const providers = rawProviders.map((p) => ({
      ...p,
      id: resolveProviderId(p.id),
    }));
    return { ...rewritten, providers };
  }

  // v0 tier shape. A package may still need multi-turn (vars.turns), which the
  // tier CLI provider cannot drive — auto-route it through the SDK bridge using
  // the [multiturn] block, so the package needs no package-local providers.
  if (_hasMultiTurnTest(parsed)) {
    return {
      ...rewritten,
      providers: [resolveMultiTurnProviderBlock(rawTier)],
    };
  }

  return {
    ...rewritten,
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
 * Default for all provider_kinds routed through _node_bridge.js.
 */
const BRIDGE_FILE_URL = `file://${path.join(FRAMEWORK_ROOT, '_node_bridge.js')}`;

/**
 * Wrapper-style provider URL for openhands_agent_server.
 *
 * This kind owns its own daemon lifecycle (CLI-managed) and a JS provider
 * file — it does NOT route through _node_bridge.js. The resolver emits this
 * URL when provider_kind === 'openhands_agent_server'; the file lives at
 * scripts/framework/openhands-agent-server-provider.js.
 */
const AGENT_SERVER_FILE_URL = 'framework://openhands-agent-server-provider.js';

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
  const case_id = _buildCaseId(tierName, providerIndex, scenarioIndex, runId);

  if (providerEntry.provider_kind === 'openhands_agent_server') {
    // Wrapper-style provider: bypasses _node_bridge.js entirely. All consumer
    // fields (agent, openhands_config, agent_config, …) arrive at config top
    // level — there is no provider_options bag because the bridge security
    // model (env allowlist + redaction) does not apply when we never enter
    // the bridge.
    const { provider_kind, model, label, ...rest } = providerEntry;
    return {
      id: AGENT_SERVER_FILE_URL,
      label: label || `${tierName}/openhands_agent_server/${model || rest.agent || 'unknown'}`,
      config: {
        provider_kind,
        model: model || null,
        run_id: runId,
        case_id,
        ...rest,
      },
    };
  }

  const { provider_kind, model, label, agent_config, ...rest } = providerEntry;
  // Build provider_options from remaining fields (not provider_kind / model / label)
  const provider_options = Object.keys(rest).length > 0 ? rest : undefined;

  const config = {
    provider_kind,
    model: model || null,
    run_id: runId,
    case_id,
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
  resolveMultiTurnProviderBlock,
  getRunId,
  _resetRunId,
  _isV1RawShape,
  _hasMultiTurnTest,
  _readRawTierConfig,
};
