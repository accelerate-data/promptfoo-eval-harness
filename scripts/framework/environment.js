function buildHarnessEnv({ baseEnv = process.env, paths }) {
  return {
    ...baseEnv,
    AD_EVALS_ROOT: paths.evalRoot,
    PROMPTFOO_CONFIG_DIR: paths.sharedPromptfooDir,
    PROMPTFOO_CACHE_PATH: paths.promptfooCachePath,
    PROMPTFOO_LOG_DIR: paths.promptfooLogDir,
    PROMPTFOO_MEDIA_PATH: paths.promptfooMediaPath,
    PROMPTFOO_EVAL_TIMEOUT_MS: baseEnv.PROMPTFOO_EVAL_TIMEOUT_MS || '900000',
    PROMPTFOO_SCHEDULER_QUEUE_TIMEOUT_MS: baseEnv.PROMPTFOO_SCHEDULER_QUEUE_TIMEOUT_MS || '900000',
    CLAUDE_PLUGIN_ROOT: paths.repoRoot,
    TMPDIR: paths.tmpDir,
    TMP: paths.tmpDir,
    TEMP: paths.tmpDir,
    XDG_STATE_HOME: paths.sharedOpenCodeStateDir,
  };
}

module.exports = { buildHarnessEnv };
