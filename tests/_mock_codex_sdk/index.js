'use strict';

/**
 * Phase 12 — mock @openai/codex-sdk implementation (VD-2174-11).
 *
 * Loaded into Node's CJS module cache via tests/_mock_codex_sdk/register.js
 * (NODE_OPTIONS=--require ...). Mirrors the constructor + Thread surface the
 * codex_sdk provider uses:
 *
 *   const { Codex } = require('@openai/codex-sdk');
 *   const codex = new Codex({ apiKey, baseUrl, env });
 *   const thread = codex.startThread({ workingDirectory, skipGitRepoCheck,
 *                                       model, sandboxMode, modelReasoningEffort });
 *   const { items, usage } = await thread.run(message);
 *
 * Scenario control via env `CODEX_SDK_MOCK_SCENARIO`:
 *   - `happy` (default): deterministic agent_message responses
 *   - `auth`: thread.run rejects with status=401
 *   - `rate_limit`: thread.run rejects with status=429
 *   - `unsupported_model`: codex.startThread throws UNSUPPORTED_MODEL
 *
 * Multi-turn dependency: Thread keeps per-instance "remembered" state so
 * turn 2 ("what number…") can recall a value set in turn 1 ("remember N").
 *
 * Side channel for tests: every ctor/startThread/run call is recorded onto
 * `globalThis.__codexMockState` so provider.test.js can assert HOME
 * isolation, workingDirectory continuity, and skipGitRepoCheck plumbing.
 */

const fs = require('node:fs');
const path = require('node:path');

function _scenario() {
  return (process.env.CODEX_SDK_MOCK_SCENARIO || 'happy').trim();
}

function _ensureState() {
  if (!globalThis.__codexMockState) {
    globalThis.__codexMockState = { events: [] };
  }
  return globalThis.__codexMockState;
}

function _record(event) {
  _ensureState().events.push(event);
}

function _matchRemember(input) {
  const m = (input || '').match(/remember\s+(\d+)/i);
  return m ? m[1] : null;
}

function _asksWhatNumber(input) {
  return /what\s+number/i.test(input || '');
}

class Thread {
  constructor(ctorOpts, threadOpts) {
    this._ctorOpts = ctorOpts || {};
    this._threadOpts = threadOpts || {};
    this._remembered = null;
    this._turns = 0;
    const workDir = threadOpts && threadOpts.workingDirectory;
    this._gitExists = workDir ? fs.existsSync(path.join(workDir, '.git')) : false;
    _record({
      event: 'startThread',
      workingDirectory: workDir || null,
      skipGitRepoCheck: !!(threadOpts && threadOpts.skipGitRepoCheck),
      model: (threadOpts && threadOpts.model) || null,
      sandboxMode: (threadOpts && threadOpts.sandboxMode) || null,
      modelReasoningEffort: (threadOpts && threadOpts.modelReasoningEffort) || null,
      home: (ctorOpts && ctorOpts.env && ctorOpts.env.HOME) || null,
      gitExists: this._gitExists,
    });
  }

  async run(message) {
    const sc = _scenario();
    if (sc === 'auth') {
      const err = new Error('mock codex auth error: missing OPENAI_API_KEY');
      err.status = 401;
      throw err;
    }
    if (sc === 'rate_limit') {
      const err = new Error('mock codex rate limit');
      err.status = 429;
      throw err;
    }

    this._turns += 1;
    _record({
      event: 'run',
      message,
      turn: this._turns,
      workingDirectory: this._threadOpts.workingDirectory || null,
      home: (this._ctorOpts.env && this._ctorOpts.env.HOME) || null,
    });

    const remembered = _matchRemember(message);
    let text;
    if (remembered) {
      this._remembered = remembered;
      text = `Okay, I'll remember ${remembered}.`;
    } else if (_asksWhatNumber(message)) {
      text = this._remembered ? `It was ${this._remembered}.` : `I don't have a number stored.`;
    } else if (/^hello\b/i.test(message || '')) {
      text = 'Hi there!';
    } else {
      text = `[mock-codex-sdk] ${message}`;
    }

    const wordCount = Math.max(1, String(message || '').split(/\s+/).filter(Boolean).length);
    const outCount = Math.max(1, text.split(/\s+/).filter(Boolean).length);
    return {
      items: [{ type: 'agent_message', text }],
      usage: { input_tokens: wordCount, output_tokens: outCount },
    };
  }
}

class Codex {
  constructor(opts) {
    this._opts = opts || {};
    _record({
      event: 'ctor',
      apiKey: this._opts.apiKey ? '[PRESENT]' : null,
      baseUrl: this._opts.baseUrl || null,
      home: (this._opts.env && this._opts.env.HOME) || null,
    });
  }

  startThread(threadOpts) {
    const sc = _scenario();
    if (sc === 'unsupported_model') {
      const err = new Error('mock codex unsupported model');
      err.code = 'UNSUPPORTED_MODEL';
      throw err;
    }
    return new Thread(this._opts, threadOpts);
  }
}

module.exports = { Codex };
