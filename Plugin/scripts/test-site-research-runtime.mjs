#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeResearchRequest,
  runSiteResearch,
} from '../src/background/siteResearchRuntime.js';
import {
  buildBrowserPolicyDecision,
  resolveBrowserPolicyPageUrl,
} from '../src/background/browserPolicy.js';

test('allows a leased page action while a new HTTP tab only exposes pendingUrl', () => {
  const action = {
    type: 'page.waitForLoadState',
    tabId: 42,
  };
  const currentUrl = resolveBrowserPolicyPageUrl(action, {
    url: 'about:blank',
    pendingUrl: 'https://developer.aliyun.com/article/1687019',
  });

  assert.equal(currentUrl, 'https://developer.aliyun.com/article/1687019');
  assert.equal(buildBrowserPolicyDecision({ ...action, currentUrl }).allowed, true);
});

test('keeps non-HTTP pending tabs outside the page action allowlist', () => {
  const action = {
    type: 'page.waitForLoadState',
    tabId: 42,
  };
  const currentUrl = resolveBrowserPolicyPageUrl(action, {
    url: 'about:blank',
    pendingUrl: 'chrome://settings',
  });
  const decision = buildBrowserPolicyDecision({ ...action, currentUrl });

  assert.equal(currentUrl, '');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'denied_page_not_allowlisted');
});

test('normalizes generic web content scans and existing-tab requests', () => {
  const web = normalizeResearchRequest({
    operation: 'content_scan',
    url: 'https://example.com/article',
  });
  assert.equal(web.site.id, 'web');
  assert.equal(web.depth, 'standard');

  const existingTab = normalizeResearchRequest({
    operation: 'content_scan',
    site: 'xhs',
    tabId: 12,
  });
  assert.equal(existingTab.site.id, 'xiaohongshu');
  assert.equal(existingTab.tabId, 12);
});

test('normalizes supported typed filters and rejects unsupported filters', () => {
  const request = normalizeResearchRequest({
    operation: 'search',
    site: 'xhs',
    query: 'AI 工具',
    filters: { sort: 'latest', contentType: 'video', publishTime: 'week' },
  });
  assert.deepEqual(request.filters, { sort: 'latest', contentType: 'video', publishTime: 'week' });
  assert.throws(
    () => normalizeResearchRequest({ operation: 'search', site: 'xhs', query: 'AI', filters: { unknown: 'value' } }),
    /does not support research filter/,
  );
  assert.throws(
    () => normalizeResearchRequest({ operation: 'content_scan', site: 'xhs', url: 'https://www.xiaohongshu.com/explore/a', filters: { sort: 'latest' } }),
    /only supported for search/,
  );
});

test('applies typed filters before collecting evidence and reports applied state', async () => {
  const sequence = [];
  let reads = 0;
  let openedUrl = '';
  const result = await runSiteResearch({
    operation: 'search',
    site: 'douyin',
    query: '装修',
    filters: { sort: 'latest' },
    depth: 'preview',
    maxScrolls: 0,
  }, {
    createControlledTab: async ({ url }) => {
      openedUrl = url;
      return { tab: { id: 9, url, title: 'fixture' } };
    },
    getTab: async () => ({ id: 9, url: 'https://www.douyin.com/search/test', title: 'fixture' }),
    claimTab: async () => {},
    waitForTabComplete: async () => {},
    submitSearch: async (_tabId, request) => {
      sequence.push('search');
      assert.equal(request.query, '装修');
      return { success: true, submitted: true };
    },
    readSnapshot: async () => ({ snapshot: '' }),
    readSiteEvidence: async () => {
      reads += 1;
      sequence.push(`read:${reads}`);
      return { success: true, items: [{ id: 'a', sourceUrl: 'https://www.douyin.com/video/a', title: 'A' }] };
    },
    applyFilters: async (_tabId, request) => {
      sequence.push('filters');
      assert.deepEqual(request.filters, { sort: 'latest' });
      return { success: true, applied: request.filters };
    },
  });

  assert.deepEqual(sequence, ['search', 'read:1', 'filters', 'read:2']);
  assert.equal(openedUrl, 'https://www.douyin.com/');
  assert.deepEqual(result.filters, { requested: { sort: 'latest' }, applied: { sort: 'latest' } });
});

test('waits for typed card readiness before attempting result-page scrolling', async () => {
  let reads = 0;
  const waits = [];
  const result = await runSiteResearch({
    operation: 'search',
    site: 'xhs',
    query: 'AI',
    depth: 'preview',
    limit: 1,
    maxScrolls: 3,
  }, {
    createControlledTab: async ({ url }) => ({ tab: { id: 10, url, title: 'fixture' } }),
    getTab: async () => ({ id: 10, url: 'https://www.xiaohongshu.com/search_result', title: 'fixture' }),
    claimTab: async () => {},
    waitForTabComplete: async () => {},
    submitSearch: async () => ({ success: true, submitted: true }),
    readSnapshot: async () => ({ snapshot: '' }),
    delay: async (ms) => { waits.push(ms); },
    scrollPage: async () => { throw new Error('ready first card must not require scrolling'); },
    readSiteEvidence: async () => {
      reads += 1;
      if (reads === 1) {
        return {
          success: true,
          pageState: { results: { status: 'loading', candidateCount: 0, interactableCount: 0 } },
          items: [],
        };
      }
      return {
        success: true,
        pageState: { results: { status: 'ready', candidateCount: 1, interactableCount: 1 } },
        items: [{
          id: 'a',
          sourceUrl: 'https://www.xiaohongshu.com/explore/a',
          interactionRef: { kind: 'site_card', action: 'page_click', site: 'xiaohongshu', itemId: 'a' },
        }],
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.counts.cards, 1);
  assert.deepEqual(waits, [750]);
});

test('fails closed when a requested filter is not visible', async () => {
  const result = await runSiteResearch({
    operation: 'search',
    site: 'xhs',
    query: 'AI',
    filters: { publishTime: 'week' },
  }, {
    createControlledTab: async ({ url }) => ({ tab: { id: 11, url, title: 'fixture' } }),
    getTab: async () => ({ id: 11, url: 'https://www.xiaohongshu.com/search_result', title: 'fixture' }),
    claimTab: async () => {},
    waitForTabComplete: async () => {},
    submitSearch: async () => ({ success: true, submitted: true }),
    readSnapshot: async () => ({ snapshot: '' }),
    readSiteEvidence: async () => ({ success: true, items: [] }),
    applyFilters: async () => ({ success: false, reason: 'filter_option_unavailable', filter: 'publishTime', value: 'week' }),
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'filter_option_unavailable');
  assert.equal(result.failure.filter, 'publishTime');
});

test('executes registered site steps without extension-side tab orchestration', async () => {
  const calls = [];
  const extractorRequests = [];
  const base = {
    operation: 'search',
    site: 'xhs',
    query: 'AI',
    tabId: 51,
    depth: 'preview',
  };
  const deps = {
    getTab: async () => ({ id: 51, url: 'https://www.xiaohongshu.com/search_result', title: 'fixture' }),
    submitSearch: async (_tabId, request) => {
      calls.push('search');
      return { success: true, submitted: true, sourceUrl: 'https://www.xiaohongshu.com/search_result' };
    },
    readSiteEvidence: async (_tabId, request) => {
      calls.push('extract');
      extractorRequests.push(request);
      return {
        success: true,
        prepared: { available: true, injected: false },
        response: {
          success: true,
          items: [{ id: 'a', sourceUrl: 'https://www.xiaohongshu.com/explore/a' }],
        },
      };
    },
    applyFilters: async (_tabId, request) => {
      calls.push('filters');
      return {
        success: true,
        prepared: { available: true, injected: false },
        response: { success: true, applied: request.filters },
      };
    },
    downloadAsset: async (asset) => {
      calls.push(`download:${asset.sourceUrl}`);
      return { success: true, path: '/tmp/a.jpg', download_id: 9, download: { mime: 'image/jpeg', totalBytes: 128 } };
    },
    openItem: async (_tabId, request) => {
      calls.push('open');
      assert.equal(request.item.id, 'a');
      return {
        success: true,
        openedIn: 'same_tab_overlay',
        targetTabId: 51,
        tab: { id: 51, url: 'https://www.xiaohongshu.com/search_result', title: 'fixture' },
        openState: { openedIn: 'same_tab_overlay', sourceTabId: 51, targetTabId: 51 },
      };
    },
    closeItem: async (_tabId, request) => {
      calls.push('close');
      assert.equal(request.openState.openedIn, 'same_tab_overlay');
      return { success: true, restored: true };
    },
    createControlledTab: async () => {
      throw new Error('step executor must not create tabs');
    },
  };

  const submitted = await runSiteResearch({ ...base, executionMode: 'submit_search' }, deps);
  assert.equal(submitted.step, 'submit_search');
  assert.equal(submitted.submitted, true);
  const extracted = await runSiteResearch({ ...base, executionMode: 'extract' }, deps);
  assert.equal(extracted.step, 'extract');
  assert.equal(extracted.items.length, 1);
  assert.equal(extractorRequests[0].siteId, 'xiaohongshu');
  assert.equal(extractorRequests[0].site, undefined);
  const filtered = await runSiteResearch({
    ...base,
    executionMode: 'apply_filters',
    filters: { sort: 'latest' },
  }, deps);
  assert.deepEqual(filtered.applied, { sort: 'latest' });
  const opened = await runSiteResearch({
    ...base,
    executionMode: 'open_item',
    item: {
      id: 'a',
      sourceUrl: 'https://www.xiaohongshu.com/explore/a',
      interactionRef: { kind: 'site_card', site: 'xiaohongshu', itemId: 'a', rank: 0 },
    },
  }, deps);
  assert.equal(opened.step, 'open_item');
  assert.equal(opened.openedIn, 'same_tab_overlay');
  const closed = await runSiteResearch({
    ...base,
    executionMode: 'close_item',
    openState: opened.openState,
  }, deps);
  assert.equal(closed.step, 'close_item');
  assert.equal(closed.restored, true);
  const downloaded = await runSiteResearch({
    ...base,
    executionMode: 'download_media',
    media: [{ type: 'image', sourceUrl: 'https://img.example/a.jpg' }],
  }, deps);
  assert.equal(downloaded.mediaDownloads[0].localPath, '/tmp/a.jpg');
  assert.deepEqual(calls, ['search', 'extract', 'filters', 'open', 'close', 'download:https://img.example/a.jpg']);
});

test('collects bounded search cards and deep detail evidence', async () => {
  const claims = [];
  const restored = [];
  const created = [];
  const opened = [];
  let searchReads = 0;
  const result = await runSiteResearch({
    operation: 'search',
    site: 'xhs',
    query: '防腐钢管',
    limit: 2,
    maxScrolls: 1,
    depth: 'deep',
  }, {
    createControlledTab: async (options) => {
      created.push(options);
      return { tab: { id: 10, url: options.url, title: 'fixture' } };
    },
    getTab: async (tabId) => ({ id: tabId, url: 'https://www.xiaohongshu.com/search_result', title: '搜索' }),
    claimTab: async (tabId, role) => claims.push([tabId, role]),
    waitForTabComplete: async () => {},
    submitSearch: async () => ({ success: true, submitted: true }),
    scrollPage: async () => ({ success: true }),
    openItem: async (sourceTabId, request) => {
      const targetTabId = 12 + opened.length;
      opened.push([sourceTabId, request.item.id]);
      return {
        success: true,
        openedIn: 'new_tab',
        sourceTabId,
        targetTabId,
        tab: { id: targetTabId, url: request.item.sourceUrl, title: 'fixture' },
        openState: {
          openedIn: 'new_tab',
          sourceTabId,
          targetTabId,
          sourceUrlBefore: 'https://www.xiaohongshu.com/search_result',
          itemId: request.item.id,
        },
      };
    },
    closeItem: async (_sourceTabId, request) => {
      restored.push(request.openState.targetTabId);
      return { success: true, restored: true };
    },
    readSnapshot: async () => ({ snapshot: '<main>fixture</main>' }),
    readSiteEvidence: async (tabId, request) => {
      if (request.operation === 'content_scan') {
        return {
          success: true,
          pageState: { site: 'xiaohongshu', surface: 'detail', url: `https://www.xiaohongshu.com/explore/${tabId}` },
          content: {
            body: `详情正文 ${tabId}`,
            title: `详情 ${tabId}`,
            comments: [{ id: `comment-${tabId}`, content: '有用' }],
            media: [{ type: 'image', sourceUrl: `https://img.example/${tabId}.jpg` }],
          },
        };
      }
      searchReads += 1;
      const items = [{ id: 'a', sourceUrl: 'https://www.xiaohongshu.com/explore/a', title: 'A', interactionRef: { kind: 'site_card', site: 'xiaohongshu', itemId: 'a', rank: 0 } }];
      if (searchReads > 1) items.push({ id: 'b', sourceUrl: 'https://www.xiaohongshu.com/explore/b', title: 'B', interactionRef: { kind: 'site_card', site: 'xiaohongshu', itemId: 'b', rank: 1 } });
      return { success: true, items };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.site.id, 'xiaohongshu');
  assert.equal(result.counts.cards, 2);
  assert.equal(result.counts.items, 2);
  assert.equal(result.counts.comments, 2);
  assert.equal(result.counts.media, 2);
  assert.equal(created[0].url, 'https://www.xiaohongshu.com/');
  assert.equal(created.length, 1);
  assert.deepEqual(opened, [[10, 'a'], [10, 'b']]);
  assert.deepEqual(restored, [12, 13]);
  assert.deepEqual(claims.map((entry) => entry[1]), ['research_search']);
});

test('fails closed instead of fabricating a search URL when page UI search is unavailable', async () => {
  const result = await runSiteResearch({
    operation: 'search',
    site: 'xhs',
    query: 'WAIC',
    depth: 'preview',
  }, {
    createControlledTab: async ({ url }) => ({ tab: { id: 19, url, title: '小红书' } }),
    getTab: async () => ({ id: 19, url: 'https://www.xiaohongshu.com/', title: '小红书' }),
    claimTab: async () => {},
    waitForTabComplete: async () => {},
    readSnapshot: async () => ({ snapshot: '' }),
    readSiteEvidence: async () => ({ success: true, items: [] }),
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'search_ui_runtime_unavailable');
  assert.equal(result.sourceUrl, 'https://www.xiaohongshu.com/');
});

test('returns a typed user handoff for login and security blockers', async () => {
  for (const reason of ['login_required', 'security_verification_required']) {
    const result = await runSiteResearch({
      operation: 'content_scan',
      site: 'douyin',
      url: 'https://www.douyin.com/video/123',
    }, {
      createControlledTab: async ({ url }) => ({ tab: { id: 20, url, title: 'fixture' } }),
      getTab: async () => ({ id: 20, url: 'https://www.douyin.com/video/123', title: 'fixture' }),
      claimTab: async () => {},
      waitForTabComplete: async () => {},
      readSnapshot: async () => ({ snapshot: '' }),
      readSiteEvidence: async () => ({ success: false, reason }),
    });
    assert.equal(result.success, false);
    assert.equal(result.reason, reason);
    assert.equal(result.handoff.required, true);
    assert.equal(result.handoff.tabId, 20);
  }
});

test('restores clicked detail surfaces and fails closed when no detail is captured', async () => {
  const restored = [];
  let createCount = 0;
  const result = await runSiteResearch({
    operation: 'search',
    site: 'douyin',
    query: '装修',
    limit: 1,
    maxScrolls: 0,
    depth: 'standard',
  }, {
    createControlledTab: async ({ url }) => {
      createCount += 1;
      return { tab: { id: 30, url, title: 'fixture' } };
    },
    getTab: async (tabId) => ({ id: tabId, url: 'https://www.douyin.com/search/test', title: 'fixture' }),
    claimTab: async () => {},
    waitForTabComplete: async () => {},
    submitSearch: async () => ({ success: true, submitted: true }),
    scrollPage: async () => {},
    openItem: async (sourceTabId, request) => ({
      success: true,
      openedIn: 'new_tab',
      sourceTabId,
      targetTabId: 31,
      tab: { id: 31, url: request.item.sourceUrl, title: 'fixture' },
      openState: { openedIn: 'new_tab', sourceTabId, targetTabId: 31 },
    }),
    closeItem: async (_sourceTabId, request) => {
      restored.push(request.openState.targetTabId);
      return { success: true, restored: true };
    },
    readSnapshot: async () => ({ snapshot: '' }),
    readSiteEvidence: async (_tabId, request) => request.operation === 'search'
      ? { success: true, items: [{ id: 'video', sourceUrl: 'https://www.douyin.com/video/1', title: '视频', interactionRef: { kind: 'site_card', site: 'douyin', itemId: 'video', rank: 0 } }] }
      : { success: false, reason: 'security_verification_required' },
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'detail_capture_failed');
  assert.equal(result.counts.failed, 1);
  assert.equal(createCount, 1);
  assert.deepEqual(restored, [31]);
});

test('downloads unique discovered media and returns local handoff paths', async () => {
  const downloaded = [];
  const result = await runSiteResearch({
    operation: 'content_scan',
    site: 'web',
    url: 'https://example.com/article',
    downloadMedia: true,
  }, {
    createControlledTab: async ({ url }) => ({ tab: { id: 40, url, title: 'fixture' } }),
    getTab: async () => ({ id: 40, url: 'https://example.com/article', title: 'fixture' }),
    claimTab: async () => {},
    waitForTabComplete: async () => {},
    readSnapshot: async () => ({ snapshot: '<main>fixture</main>' }),
    readSiteEvidence: async () => ({
      success: true,
      content: {
        title: 'Fixture',
        body: 'Fixture body',
        media: [
          { type: 'image', sourceUrl: 'https://img.example/a.jpg' },
          { type: 'image', sourceUrl: 'https://img.example/a.jpg' },
        ],
      },
      items: [],
    }),
    downloadAsset: async (asset) => {
      downloaded.push(asset.sourceUrl);
      return {
        success: true,
        download_id: '501',
        path: '/tmp/a.jpg',
        download: { id: 501, mime: 'image/jpeg', totalBytes: 1024 },
      };
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(downloaded, ['https://img.example/a.jpg']);
  assert.equal(result.mediaDownloads.length, 1);
  assert.equal(result.mediaDownloads[0].localPath, '/tmp/a.jpg');
  assert.equal(result.mediaDownloads[0].bytes, 1024);
});

test('downloads only ranked media that satisfies the typed image policy', async () => {
  const downloaded = [];
  const result = await runSiteResearch({
    operation: 'content_scan',
    site: 'web',
    url: 'https://example.com/article',
    tabId: 40,
    executionMode: 'download_media',
    runId: 'research-policy-test',
    timeoutMs: 30_000,
    mediaTypes: ['image'],
    mediaLimit: 1,
    minMediaWidth: 320,
    minMediaHeight: 180,
    media: [
      {
        id: 'home-video',
        type: 'video',
        sourceUrl: 'https://video.example/home.mp4',
        naturalWidth: 1920,
        naturalHeight: 1080,
        relevanceScore: 100,
      },
      {
        id: 'avatar',
        type: 'image',
        sourceUrl: 'https://img.example/avatar.jpg',
        naturalWidth: 75,
        naturalHeight: 75,
        relevanceScore: 90,
      },
      {
        id: 'decorative',
        type: 'image',
        sourceUrl: 'https://img.example/logo.jpg',
        naturalWidth: 800,
        naturalHeight: 600,
        role: 'decorative',
        relevanceScore: 80,
      },
      {
        id: 'secondary',
        type: 'image',
        sourceUrl: 'https://img.example/secondary.jpg',
        naturalWidth: 1200,
        naturalHeight: 800,
        relevanceScore: 40,
      },
      {
        id: 'primary',
        type: 'image',
        sourceUrl: 'https://img.example/primary.jpg',
        naturalWidth: 1600,
        naturalHeight: 1200,
        relevanceScore: 70,
      },
    ],
  }, {
    getTab: async () => ({ id: 40, url: 'https://example.com/article', title: 'fixture' }),
    downloadAsset: async (asset, options) => {
      downloaded.push([asset.id, options.timeoutMs, options.runId]);
      return {
        success: true,
        path: '/tmp/primary.jpg',
        stagingOwned: true,
        stagingRunId: options.runId,
        download: { id: 601, mime: 'image/jpeg', totalBytes: 2048 },
      };
    },
  });

  assert.deepEqual(downloaded, [['primary', 10_000, 'research-policy-test']]);
  assert.equal(result.mediaDownloads.length, 1);
  assert.equal(result.mediaDownloads[0].id, 'primary');
  assert.equal(result.mediaDownloads[0].stagingOwned, true);
  assert.equal(result.mediaDownloads[0].stagingRunId, 'research-policy-test');
});
