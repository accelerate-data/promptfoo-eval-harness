'use strict';

// Test fixture: parser exported as a default function (Shape 1).
// Used by opencode-cli-plugin-provider.test.js to verify the sibling's
// _resolveParser helper accepts `module.exports = fn` shape.

module.exports = function (rawOutput) {
  return {
    text: `default:${String(rawOutput || '').trim()}`,
    trajectory: [{ via: 'default-export', raw: rawOutput }],
  };
};
