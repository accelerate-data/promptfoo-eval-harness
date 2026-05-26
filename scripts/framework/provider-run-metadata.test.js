const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  writeProviderRunMetadata,
  writeTrajectory,
} = require('./provider-run-metadata');

function mkWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prm-test-'));
}

test('writeProviderRunMetadata writes .eval-run/provider.json', () => {
  const ws = mkWorkspace();
  const meta = { provider: 'codex-sdk', agent_id: 'demo' };
  writeProviderRunMetadata(ws, meta);
  const written = fs.readFileSync(
    path.join(ws, '.eval-run', 'provider.json'),
    'utf8',
  );
  assert.equal(written, `${JSON.stringify(meta, null, 2)}\n`);
});

test('writeTrajectory writes .eval-run/trajectory.json', () => {
  const ws = mkWorkspace();
  const traj = [{ role: 'user', content: 'hi' }];
  writeTrajectory(ws, traj);
  const written = fs.readFileSync(
    path.join(ws, '.eval-run', 'trajectory.json'),
    'utf8',
  );
  assert.equal(written, `${JSON.stringify(traj, null, 2)}\n`);
});

test('both writers are idempotent across multiple calls', () => {
  const ws = mkWorkspace();
  writeProviderRunMetadata(ws, { a: 1 });
  writeProviderRunMetadata(ws, { a: 2 });
  writeTrajectory(ws, []);
  writeTrajectory(ws, [{ role: 'tool', content: 'x' }]);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(ws, '.eval-run', 'provider.json'), 'utf8'),
    ),
    { a: 2 },
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(ws, '.eval-run', 'trajectory.json'), 'utf8'),
    ),
    [{ role: 'tool', content: 'x' }],
  );
});
