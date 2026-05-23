/**
 * Phase 11 — mock @opencode-ai/sdk implementation (VD-2174-10).
 *
 * Loaded by tests via ESM `Module.register()` (see loader.mjs + register.mjs).
 * Mirrors the public surface of `@opencode-ai/sdk@1.15.10` that the provider
 * uses: createOpencodeServer, createOpencodeClient, plus a session API that
 * supports list/create/get/delete/prompt with deterministic responses.
 *
 * Scenario control via env `OPENCODE_SDK_MOCK_SCENARIO`:
 *   - `happy` (default): server boots, responds with deterministic text
 *   - `startup_timeout`: client.session.list always rejects so readiness probe fails
 *   - `auth`: createOpencodeClient throws an auth error synchronously
 *
 * Multi-turn dependency: the mock keeps per-session prompt history; if a
 * turn asks "what number" after a prior turn said "remember <N>", the mock
 * echoes <N> back so harness scenarios can assert cross-turn state.
 */

const _scenario = () => (process.env.OPENCODE_SDK_MOCK_SCENARIO || 'happy').trim();

const _sessions = new Map();
let _nextId = 1;

function _matchRemember(input) {
  const m = (input || '').match(/remember\s+(\d+)/i);
  return m ? m[1] : null;
}

function _asksWhatNumber(input) {
  return /what\s+number/i.test(input || '');
}

function _respondTo(state, input) {
  const remembered = _matchRemember(input);
  if (remembered) {
    state.remembered = remembered;
    return `Okay, I'll remember ${remembered}.`;
  }
  if (_asksWhatNumber(input)) {
    return state.remembered ? `It was ${state.remembered}.` : `I don't have a number stored.`;
  }
  if (/^hello\b/i.test(input || '')) return 'Hi there!';
  return `[mock-opencode-sdk] ${input}`;
}

export async function createOpencodeServer(options = {}) {
  if (_scenario() === 'auth') {
    // Server still boots; auth surfaces in client constructor below.
  }
  const port = 40000 + Math.floor(Math.random() * 20000);
  const hostname = options.hostname || '127.0.0.1';
  let closed = false;
  return {
    url: `http://${hostname}:${port}`,
    close() { closed = true; },
    _isClosed() { return closed; },
  };
}

export function createOpencodeClient(_config = {}) {
  const scenario = _scenario();
  if (scenario === 'auth') {
    const err = new Error('mock auth error: missing OPENCODE_API_KEY');
    err.status = 401;
    throw err;
  }
  // v1.3.2 hotfix: real SDK v1.15.10 wraps every session.* response in
  // `{data, request, response}` (or `{error, request, response}` on failure)
  // and requires `session.prompt({body: {model}})` to be a `{providerID, modelID}`
  // object — not a "providerID/modelID" string. The mock now mirrors that
  // wire shape so the provider's reader paths and model parser stay honest.
  const _wrap = (data) => ({ data, request: {}, response: { status: 200 } });

  return {
    session: {
      async list(_args = {}) {
        if (scenario === 'startup_timeout') {
          throw Object.assign(new Error('mock server not ready'), { status: 503 });
        }
        return _wrap({ items: [] });
      },
      async create(args = {}) {
        const id = `mock-session-${_nextId++}`;
        const title = (args.body && args.body.title) || 'mock-session';
        const directory = args.query && args.query.directory;
        _sessions.set(id, {
          id,
          title,
          directory: directory || null,
          remembered: null,
          turns: [],
          cost: 0,
          tokens: { input: 0, output: 0 },
        });
        return _wrap({ id, title, directory: directory || null });
      },
      async get(args = {}) {
        const id = args.path && args.path.id;
        const state = _sessions.get(id);
        if (!state) {
          const err = new Error(`mock session ${id} not found`);
          err.status = 404;
          throw err;
        }
        return _wrap({
          id: state.id,
          title: state.title,
          cost: state.cost,
          tokens: { ...state.tokens },
        });
      },
      async delete(args = {}) {
        const id = args.path && args.path.id;
        _sessions.delete(id);
        return _wrap({ ok: true });
      },
      async prompt(args = {}) {
        const id = args.path && args.path.id;
        const state = _sessions.get(id);
        if (!state) {
          const err = new Error(`mock session ${id} not found`);
          err.status = 404;
          throw err;
        }
        const body = args.body || {};
        if (body.model !== undefined) {
          if (typeof body.model === 'string' || !body.model.providerID || !body.model.modelID) {
            return {
              error: { name: 'BadRequest', data: { message: `Expected {providerID,modelID} object, got ${JSON.stringify(body.model)}`, kind: 'Payload' } },
              request: {},
              response: { status: 400 },
            };
          }
        }
        const parts = Array.isArray(body.parts) ? body.parts : [];
        const userText = parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
        state.turns.push(userText);
        const text = _respondTo(state, userText);
        state.cost += 0.0001;
        state.tokens.input += Math.max(1, userText.split(/\s+/).filter(Boolean).length);
        state.tokens.output += Math.max(1, text.split(/\s+/).filter(Boolean).length);
        return _wrap({
          info: {
            id: `mock-msg-${_nextId++}`,
            sessionID: id,
            role: 'assistant',
          },
          parts: [
            { type: 'step-start' },
            { type: 'text', text, messageID: `mock-msg-${_nextId}`, sessionID: id },
            { type: 'step-finish' },
          ],
        });
      },
    },
  };
}

export async function createOpencode(options = {}) {
  const server = await createOpencodeServer(options);
  const client = createOpencodeClient({ baseUrl: server.url });
  return { server, client };
}

export class OpencodeClient {
  constructor(config = {}) {
    const inner = createOpencodeClient(config);
    this.session = inner.session;
  }
}
