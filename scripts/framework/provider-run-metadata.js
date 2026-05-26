const fs = require('node:fs');
const path = require('node:path');

function writeProviderRunMetadata(workspace, metadata) {
  writeRunArtifact(workspace, 'provider.json', metadata);
}

function writeTrajectory(workspace, trajectory) {
  writeRunArtifact(workspace, 'trajectory.json', trajectory);
}

function writeRunArtifact(workspace, fileName, payload) {
  const runDir = path.join(workspace, '.eval-run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, fileName),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

module.exports = { writeProviderRunMetadata, writeTrajectory };
