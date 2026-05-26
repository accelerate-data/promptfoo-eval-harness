'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('smol-toml');

const SDK_PINS_PATH = path.join(__dirname, '..', '..', 'config', 'sdk-pins.toml');

/**
 * Load and return the SDK pins configuration from config/sdk-pins.toml.
 *
 * @param {string} [configPath] - Override path (for tests).
 * @returns {{
 *   openhands_sdk: object,
 *   opencode_cli: object,
 *   claude_agent_sdk: object,
 *   openhands_agent_server: object,
 * }}
 */
function loadSdkPins(configPath = SDK_PINS_PATH) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parse(raw);

  const { openhands_sdk, opencode_cli, claude_agent_sdk, openhands_agent_server } = parsed;

  if (!openhands_sdk || typeof openhands_sdk !== 'object') {
    throw new Error('sdk-pins.toml: missing [openhands_sdk] section');
  }
  if (!opencode_cli || typeof opencode_cli !== 'object') {
    throw new Error('sdk-pins.toml: missing [opencode_cli] section');
  }
  if (!claude_agent_sdk || typeof claude_agent_sdk !== 'object') {
    throw new Error('sdk-pins.toml: missing [claude_agent_sdk] section');
  }
  if (!openhands_agent_server || typeof openhands_agent_server !== 'object') {
    throw new Error('sdk-pins.toml: missing [openhands_agent_server] section');
  }
  if (!openhands_agent_server.version) {
    throw new Error('sdk-pins.toml [openhands_agent_server].version required');
  }
  if (!openhands_agent_server.tools_version) {
    throw new Error('sdk-pins.toml [openhands_agent_server].tools_version required');
  }
  if (!openhands_agent_server.python) {
    throw new Error('sdk-pins.toml [openhands_agent_server].python required');
  }
  if (!Array.isArray(openhands_agent_server.extras)) {
    throw new Error('sdk-pins.toml [openhands_agent_server].extras must be an array');
  }
  if (
    !Array.isArray(openhands_agent_server.env_allowlist)
    || openhands_agent_server.env_allowlist.length === 0
  ) {
    throw new Error('sdk-pins.toml [openhands_agent_server].env_allowlist must be a non-empty array');
  }
  if (
    typeof openhands_agent_server.startup_timeout_ms !== 'number'
    || openhands_agent_server.startup_timeout_ms <= 0
  ) {
    throw new Error('sdk-pins.toml [openhands_agent_server].startup_timeout_ms must be a positive number');
  }

  return { openhands_sdk, opencode_cli, claude_agent_sdk, openhands_agent_server };
}

module.exports = { loadSdkPins, SDK_PINS_PATH };
