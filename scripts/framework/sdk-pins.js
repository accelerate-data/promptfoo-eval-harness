'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('smol-toml');

const SDK_PINS_PATH = path.join(__dirname, '..', '..', 'config', 'sdk-pins.toml');

/**
 * Load and return the SDK pins configuration from config/sdk-pins.toml.
 *
 * @param {string} [configPath] - Override path (for tests).
 * @returns {{ openhands_sdk: object, opencode_cli: object, claude_agent_sdk: object }}
 */
function loadSdkPins(configPath = SDK_PINS_PATH) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parse(raw);

  const { openhands_sdk, opencode_cli, claude_agent_sdk } = parsed;

  if (!openhands_sdk || typeof openhands_sdk !== 'object') {
    throw new Error('sdk-pins.toml: missing [openhands_sdk] section');
  }
  if (!opencode_cli || typeof opencode_cli !== 'object') {
    throw new Error('sdk-pins.toml: missing [opencode_cli] section');
  }
  if (!claude_agent_sdk || typeof claude_agent_sdk !== 'object') {
    throw new Error('sdk-pins.toml: missing [claude_agent_sdk] section');
  }

  return { openhands_sdk, opencode_cli, claude_agent_sdk };
}

module.exports = { loadSdkPins, SDK_PINS_PATH };
