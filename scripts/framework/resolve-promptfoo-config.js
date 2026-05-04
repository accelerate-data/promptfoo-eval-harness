const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { loadEvalTierConfig, resolveEvalTier } = require('./eval-tier-config');
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

module.exports = {
  TMP_ROOT,
  resolveConfigFile,
  resolveProviderId,
  writeResolvedConfig,
};
