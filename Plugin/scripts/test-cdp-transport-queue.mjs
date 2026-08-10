#!/usr/bin/env node

import assert from 'node:assert/strict';

let inFlight = 0;
let maxInFlight = 0;
const observedMethods = [];

globalThis.chrome = {
  debugger: {
    async sendCommand(target, method) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      observedMethods.push(`${target.tabId || target.targetId}:${method}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { method };
    },
    async attach() {},
    async detach() {},
    async getTargets() { return []; },
  },
};

const { getCdpTargetQueueSnapshot, sendCdpCommandWithTimeout } = await import('../src/background/cdpTransport.js');

await Promise.all([
  sendCdpCommandWithTimeout({ tabId: 7 }, 'Runtime.evaluate', {}, 1000),
  sendCdpCommandWithTimeout({ tabId: 7 }, 'DOM.getDocument', {}, 1000),
]);

assert.equal(maxInFlight, 1, 'commands for the same debugger target must not overlap');
assert.deepEqual(observedMethods, ['7:Runtime.evaluate', '7:DOM.getDocument']);
assert.equal(getCdpTargetQueueSnapshot().queuedTargetCount, 0, 'settled queues are released');

console.log(JSON.stringify({
  ok: true,
  scenarios: ['per_target_cdp_commands_are_serialized'],
}, null, 2));
