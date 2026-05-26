'use strict';

// Test fixture: parser exported as { parseOpenCodeJsonStream } (Shape 2).
// Matches the consumer's vibedata-data-engineering parse-opencode-json.js shape.

function parseOpenCodeJsonStream(rawOutput) {
  return {
    text: `named:${String(rawOutput || '').trim()}`,
    trajectory: [{ via: 'named-export', raw: rawOutput }],
    errors: [],
  };
}

module.exports = { parseOpenCodeJsonStream };
