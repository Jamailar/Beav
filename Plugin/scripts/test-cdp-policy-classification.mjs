#!/usr/bin/env node

import assert from 'node:assert/strict';

const { BROWSER_ACTION_LEVELS, buildBrowserPolicyDecision, classifyBrowserAction } = await import('../src/background/browserPolicy.js');

assert.equal(
  classifyBrowserAction({ type: 'cdp.send', method: 'Page.navigate' }),
  BROWSER_ACTION_LEVELS.STATE_CHANGING,
  'state-changing CDP calls must not inherit the generic observe classification',
);
const denied = buildBrowserPolicyDecision({
  type: 'cdp.send',
  method: 'Page.navigate',
  currentUrl: 'https://example.test',
});
assert.equal(denied.allowed, false);
assert.equal(denied.reason, 'denied_state_changing_v1');
const allowed = buildBrowserPolicyDecision({
  type: 'cdp.send',
  method: 'Page.navigate',
  currentUrl: 'https://example.test',
  approval: { scope: 'state_changing', approved: true, expiresAt: Date.now() + 60_000 },
});
assert.equal(allowed.allowed, true);

const internalPageDenied = buildBrowserPolicyDecision({
  type: 'browser.botDetect',
  currentUrl: 'chrome-extension://example/settings.html',
});
assert.equal(internalPageDenied.allowed, false);
assert.equal(internalPageDenied.reason, 'denied_page_not_allowlisted');

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    'cdp_state_changes_require_explicit_approval',
    'browser_action_normalization_preserves_cdp_method_policy',
    'content_detection_does_not_target_extension_internal_pages',
  ],
}, null, 2));
