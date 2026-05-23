'use strict';

/**
 * Structured NDJSON logger (spec §7.2).
 *
 * Emits one JSON record per call to stderr via synchronous fs.writeSync
 * so there are no async buffering surprises and stdout (IPC channel) is
 * never contaminated.
 *
 * Schema: { ts, level, msg, run_id, case_id, provider_kind, model, ...extra }
 *
 * Every record is run through the secret redactor before serialization.
 */

const fs = require('node:fs');
const { redact } = require('./secret_redactor');

/**
 * Create a structured logger with initial context.
 *
 * @param {{ run_id?: string, case_id?: string, provider_kind?: string, model?: string }} initialContext
 * @returns {{ info(msg: string, extra?: object): void, warn(msg: string, extra?: object): void, error(msg: string, extra?: object): void }}
 */
function createLogger(initialContext = {}) {
  const base = {
    run_id: initialContext.run_id || null,
    case_id: initialContext.case_id || null,
    provider_kind: initialContext.provider_kind || null,
    model: initialContext.model || null,
  };

  function _write(level, msg, extra) {
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: typeof msg === 'string' ? msg : String(msg),
      ...base,
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
    const redacted = redact(record);
    const line = JSON.stringify(redacted) + '\n';
    fs.writeSync(2, line);
  }

  return {
    info(msg, extra) { _write('info', msg, extra); },
    warn(msg, extra) { _write('warn', msg, extra); },
    error(msg, extra) { _write('error', msg, extra); },
  };
}

module.exports = { createLogger };
