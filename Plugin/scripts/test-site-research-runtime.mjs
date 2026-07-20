#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeResearchRequest,
  runSiteResearch,
} from '../src/background/siteResearchRuntime.js';

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
  const result = await runSiteResearch({
    operation: 'search',
    site: 'douyin',
    query: '装修',
    filters: { sort: 'latest' },
    depth: 'preview',
    maxScrolls: 0,
  }, {
    createControlledTab: async ({ url }) => ({ tab: { id: 9, url, title: 'fixture' } }),
    getTab: async () => ({ id: 9, url: 'https://www.douyin.com/search/test', title: 'fixture' }),
    claimTab: async () => {},
    waitForTabComplete: async () => {},
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

  assert.deepEqual(sequence, ['read:1', 'filters', 'read:2']);
  assert.deepEqual(result.filters, { requested: { sort: 'latest' }, applied: { sort: 'latest' } });
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
  const base = {
    operation: 'search',
    site: 'xhs',
    query: 'AI',
    tabId: 51,
    depth: 'preview',
  };
  const deps = {
    getTab: async () => ({ id: 51, url: 'https://www.xiaohongshu.com/search_result', title: 'fixture' }),
    readSiteEvidence: async () => {
      calls.push('extract');
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
    createControlledTab: async () => {
      throw new Error('step executor must not create tabs');
    },
  };

  const extracted = await runSiteResearch({ ...base, executionMode: 'extract' }, deps);
  assert.equal(extracted.step, 'extract');
  assert.equal(extracted.items.length, 1);
  const filtered = await runSiteResearch({
    ...base,
    executionMode: 'apply_filters',
    filters: { sort: 'latest' },
  }, deps);
  assert.deepEqual(filtered.applied, { sort: 'latest' });
  const downloaded = await runSiteResearch({
    ...base,
    executionMode: 'download_media',
    media: [{ type: 'image', sourceUrl: 'https://img.example/a.jpg' }],
  }, deps);
  assert.equal(downloaded.mediaDownloads[0].localPath, '/tmp/a.jpg');
  assert.deepEqual(calls, ['extract', 'filters', 'download:https://img.example/a.jpg']);
});

test('collects bounded search cards and deep detail evidence', async () => {
  const claims = [];
  const closed = [];
  const created = [];
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
      return { tab: { id: created.length === 1 ? 10 : 10 + created.length, url: options.url, title: 'fixture' } };
    },
    getTab: async (tabId) => ({ id: tabId, url: 'https://www.xiaohongshu.com/search_result', title: '搜索' }),
    claimTab: async (tabId, role) => claims.push([tabId, role]),
    waitForTabComplete: async () => {},
    scrollPage: async () => ({ success: true }),
    closeTab: async (tabId) => closed.push(tabId),
    readSnapshot: async () => ({ snapshot: '<main>fixture</main>' }),
    readSiteEvidence: async (tabId, request) => {
      if (request.operation === 'content_scan') {
        return {
          success: true,
          content: {
            title: `详情 ${tabId}`,
            comments: [{ id: `comment-${tabId}`, content: '有用' }],
            media: [{ type: 'image', sourceUrl: `https://img.example/${tabId}.jpg` }],
          },
        };
      }
      searchReads += 1;
      const items = [{ id: 'a', sourceUrl: 'https://www.xiaohongshu.com/explore/a', title: 'A' }];
      if (searchReads > 1) items.push({ id: 'b', sourceUrl: 'https://www.xiaohongshu.com/explore/b', title: 'B' });
      return { success: true, items };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.site.id, 'xiaohongshu');
  assert.equal(result.counts.cards, 2);
  assert.equal(result.counts.items, 2);
  assert.equal(result.counts.comments, 2);
  assert.equal(result.counts.media, 2);
  assert.deepEqual(closed, [12, 13]);
  assert.deepEqual(claims.map((entry) => entry[1]), ['research_search', 'research_detail', 'research_detail']);
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

test('closes detail tabs and preserves partial failures', async () => {
  const closed = [];
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
      return { tab: { id: createCount === 1 ? 30 : 31, url, title: 'fixture' } };
    },
    getTab: async (tabId) => ({ id: tabId, url: 'https://www.douyin.com/search/test', title: 'fixture' }),
    claimTab: async () => {},
    waitForTabComplete: async () => {},
    scrollPage: async () => {},
    closeTab: async (tabId) => closed.push(tabId),
    readSnapshot: async () => ({ snapshot: '' }),
    readSiteEvidence: async (_tabId, request) => request.operation === 'search'
      ? { success: true, items: [{ id: 'video', sourceUrl: 'https://www.douyin.com/video/1', title: '视频' }] }
      : { success: false, reason: 'security_verification_required' },
  });

  assert.equal(result.success, true);
  assert.equal(result.partial, true);
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(closed, [31]);
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
