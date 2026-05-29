'use strict';

// Test fixture: invalid parser module — neither default function nor
// parseOpenCodeJsonStream named export. The sibling's _resolveParser MUST
// throw an actionable error mentioning both acceptable shapes.

module.exports = { other: () => 'not the right key' };
