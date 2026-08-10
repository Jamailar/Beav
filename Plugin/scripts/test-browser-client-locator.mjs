#!/usr/bin/env node

import assert from 'node:assert/strict';

const calls = [];
const transport = {
  async listEndpoints() {
    return [{ socketPath: '/tmp/redbox-browser-test.sock', instanceId: 'browser-test', extension: { extensionInstanceId: 'browser-test' } }];
  },
  withEndpoint() { return this; },
  withBrowser() { return this; },
  async hostInfo() {
    return { instanceId: 'browser-test', extension: { extensionInstanceId: 'browser-test' } };
  },
  async listTools() {
    return [];
  },
  async callTool(name, args = {}) {
    calls.push({ name, args });
    if (name === 'browser.info') return { success: true, capabilities: { browser: [] } };
    if (name === 'tab.info') return { success: true, tab: { id: args.tabId, url: 'https://example.test', title: 'Example' } };
    if (name === 'page.queryElements') {
      return {
        success: true,
        count: 2,
        elements: [{ nodeId: 41 }, { nodeId: 42 }],
        values: [{ nodeId: 41 }, { nodeId: 42 }],
      };
    }
    return { success: true };
  },
};

const { setupBrowserRuntime } = await import('../scripts/browser-client.mjs');
const globals = {};
const agent = await setupBrowserRuntime({ globals, transport, sessionId: 'session-a', turnId: 'turn-a' });
const browser = await agent.browsers.get('browser-test');
const tab = await browser.tabs.get(7);
const saveButton = tab.playwright.getByRole('button', { name: 'Save', exact: true });
const primaryOrCancel = saveButton
  .filter({ hasText: 'Save', visible: true })
  .or(tab.playwright.getByRole('button', { name: 'Cancel' }))
  .nth(1);

await primaryOrCancel.count();
const allLocators = await primaryOrCancel.all();

const locatorCalls = calls.filter((call) => call.name === 'page.queryElements');
assert.equal(locatorCalls.length, 2);
assert.equal(locatorCalls[0].args.strict, false, 'collection reads disable strict singleton enforcement');
assert.equal(locatorCalls[0].args.locatorAst.kind, 'nth');
assert.equal(locatorCalls[0].args.locatorAst.base.kind, 'or');
assert.equal(locatorCalls[0].args.locatorAst.base.items[0].kind, 'filter');
assert.equal(locatorCalls[0].args.sessionId, 'session-a');
assert.equal(locatorCalls[0].args.turnId, 'turn-a');
assert.equal(allLocators.length, 2);
assert.throws(() => saveButton.and({}), /requires another Locator/);

await tab.cdp.call('Runtime.evaluate', { expression: 'document.title' });
await tab.cdp.events({ cursor: 4, methods: ['Runtime.consoleAPICalled'] });
await tab.assets.list();
await tab.assets.bundle({ assetIds: ['asset-1'] });
await tab.webmcp.listTools();
await tab.webmcp.invokeTool('search', { query: 'example' });
await tab.focus();
await tab.mark('handoff');
await browser.user.bookmarks();
await browser.user.topSites();
await browser.user.recentlyClosed();
await browser.viewport.state();
await browser.visibility.get();
await browser.notifications.create('Ready', 'The browser handoff is ready.');
await tab.auth.detect();
await tab.auth.handoff('security_verification_required', { ttlMs: 300_000 });

const methodNames = calls.map((call) => call.name);
for (const name of [
  'tab_cdp_call',
  'tab_cdp_events',
  'tab.capabilities.pageAssets.list',
  'tab.capabilities.pageAssets.bundle',
  'tab.capabilities.webmcp.listTools',
  'tab.capabilities.webmcp.invokeTool',
  'tab.activate',
  'tab.mark',
  'bookmarks.list',
  'topSites.list',
  'sessions.recentlyClosed',
  'viewport.state',
  'browser.visibility.get',
  'notification.create',
  'browser.botDetect',
  'browser.authHandoff',
]) assert(methodNames.includes(name), `browser client exposes ${name}`);
assert.equal(calls.find((call) => call.name === 'tab_cdp_call')?.args.tab_id, 7);
assert.equal(calls.find((call) => call.name === 'tab_cdp_events')?.args.cursor, 4);
assert.equal(calls.find((call) => call.name === 'browser.authHandoff')?.args.reason, 'security_verification_required');

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    'playwright_locators_serialize_to_bounded_ast',
    'locator_collections_disable_singleton_strictness',
    'locator_combinators_require_same_runtime_locator',
    'advanced_browser_capabilities_use_typed_facades',
  ],
}, null, 2));
