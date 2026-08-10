#!/usr/bin/env node

import assert from 'node:assert/strict';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
globalThis.chrome = {
  webNavigation: {
    getAllFrames: async () => [
      { frameId: 0, parentFrameId: -1, url: 'https://example.test/article' },
      { frameId: 3, parentFrameId: 0, url: `chrome-extension://${extensionId}/frame.html` },
      { frameId: 4, parentFrameId: 0, url: 'https://embed.example.test/widget' },
    ],
  },
};

const { listPageFrames } = await import('../src/background/frameRuntime.js');
const snapshot = await listPageFrames({
  tabId: 17,
  includeContentScriptState: false,
});

assert.equal(snapshot.frameCount, 3);
assert.equal(snapshot.foreignExtensionInterference.detected, true);
assert.equal(snapshot.foreignExtensionInterference.code, 'FOREIGN_EXTENSION_FRAME_INTERFERENCE');
assert.equal(snapshot.foreignExtensionInterference.count, 1);
assert.equal(snapshot.foreignExtensionInterference.frames[0]?.frameId, 3);
assert(!JSON.stringify(snapshot.foreignExtensionInterference).includes(extensionId), 'foreign extension diagnostics redact the extension id');

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    'foreign_extension_frame_is_observed_without_mutation',
    'foreign_extension_diagnostic_redacts_extension_identity',
  ],
}, null, 2));
