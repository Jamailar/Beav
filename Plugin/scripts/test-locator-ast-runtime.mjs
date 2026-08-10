#!/usr/bin/env node

import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window, document } = parseHTML(`
  <main>
    <section id="dialog">
      <button aria-label="Save draft">Save draft</button>
      <button>Cancel</button>
    </section>
    <div class="option">First</div>
    <div class="option">Second</div>
  </main>
`);
window.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' });
for (const element of document.querySelectorAll('*')) {
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 24 });
}
globalThis.window = window;
globalThis.document = document;
globalThis.Element = window.Element;
globalThis.Node = window.Node;

const { detectBrowserAutomationBlocker, queryElements } = await import('../src/content/pageActions.js');

const save = queryElements({
  locatorAst: {
    kind: 'within',
    parent: { kind: 'css', selector: '#dialog' },
    child: { kind: 'role', role: 'button', name: 'Save draft', exact: true },
  },
  all: true,
  strict: false,
});
assert.equal(save.success, true);
assert.equal(save.count, 1);
assert.equal(save.elements[0]?.nodeId > 0, true, 'locator reads return a durable document-local node id');

const combined = queryElements({
  locatorAst: {
    kind: 'or',
    items: [
      { kind: 'filter', base: { kind: 'role', role: 'button' }, hasText: 'Save', visible: true },
      { kind: 'role', role: 'button', name: 'Cancel' },
    ],
  },
  all: true,
  strict: false,
});
assert.equal(combined.count, 2);
assert.deepEqual(combined.allTextContents, ['Save draft', 'Cancel']);

assert.throws(
  () => queryElements({ locatorAst: { kind: 'css', selector: '.option' } }),
  /locator_strict_mode_violation: expected 1 element, found 2/,
);

const verificationPrompt = document.createElement('div');
verificationPrompt.className = 'security-verify';
verificationPrompt.textContent = '请完成验证后继续。私人账号内容不得返回。';
document.body.appendChild(verificationPrompt);
const blocker = detectBrowserAutomationBlocker();
assert.equal(blocker.success, true);
assert.equal(blocker.blocked, true);
assert.equal(blocker.reason, 'security_verification');
assert.equal(blocker.evidence.selectorMatched, true);
assert(!JSON.stringify(blocker).includes('私人账号内容不得返回'), 'blocker detection returns bounded metadata rather than page or credential text');

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    'locator_ast_scopes_role_queries_to_parent',
    'locator_ast_supports_or_and_filter_composition',
    'strict_singleton_reads_fail_on_ambiguous_matches',
    'verification_detection_returns_reason_without_page_content',
  ],
}, null, 2));
