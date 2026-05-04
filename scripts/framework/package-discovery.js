const fs = require('node:fs');
const path = require('node:path');

function discoverPackageConfigs(evalRoot) {
  const packageRoot = path.join(evalRoot, 'packages');
  if (!fs.existsSync(packageRoot)) {
    return [];
  }

  return walkConfigs(evalRoot, packageRoot).sort();
}

function walkConfigs(evalRoot, currentDir) {
  return fs.readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      return walkConfigs(evalRoot, entryPath);
    }
    if (entry.isFile() && isPromptfooConfigFile(entry.name)) {
      return [path.relative(evalRoot, entryPath).split(path.sep).join('/')];
    }
    return [];
  });
}

function isPromptfooConfigFile(fileName) {
  return /^(promptfooconfig|suite)\.(json|ya?ml)$/.test(fileName);
}

module.exports = { discoverPackageConfigs, isPromptfooConfigFile };
