#!/usr/bin/env node

import assert from 'node:assert/strict';

const { CONTENT_RUNTIME_KEY, installContentRuntimeLifecycle } = await import('../src/content/contentRuntimeLifecycle.js');

const globalObject = {};
const first = installContentRuntimeLifecycle({ globalObject });
let firstDisposeReason = '';
first.onDispose((reason) => { firstDisposeReason = reason; });
const second = installContentRuntimeLifecycle({ globalObject });

assert.equal(first.disposed, true, 'a superseded content runtime is disposed before a replacement is installed');
assert.equal(firstDisposeReason, 'superseded');
assert.equal(second.revision, 2);
assert.equal(globalObject[CONTENT_RUNTIME_KEY], second);

let secondDisposeCount = 0;
second.onDispose(() => { secondDisposeCount += 1; });
second.dispose('test_complete');
second.dispose('ignored_repeat');
assert.equal(secondDisposeCount, 1, 'dispose handlers run exactly once');
assert.equal(globalObject[CONTENT_RUNTIME_KEY], undefined);

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    'duplicate_content_runtime_is_disposed',
    'only_latest_runtime_owns_global_slot',
    'dispose_handlers_are_idempotent',
  ],
}, null, 2));
