import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import {
  captureDocumentToLegacyPayload,
  normalizeCaptureDocument,
} from '../src/capture/captureDocument.js';
import { applyCaptureQuality, assessCaptureQuality } from '../src/capture/captureQuality.js';
import {
  buildKnowledgeEntryFromCaptureDocument,
  buildKnowledgeEntryFromPagePayload,
} from '../src/capture/knowledgeEntryMapper.js';
import { createGenericCaptureCoordinator } from '../src/background/genericCaptureCoordinator.js';

function installDom(html) {
  const { window, document } = parseHTML(html);
  Object.assign(globalThis, {
    window,
    document,
    DOMParser: window.DOMParser,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  return document;
}

const mappingHelpers = {
  normalizeText: (value) => String(value || '').trim(),
  truncateText: (value, maxLength) => {
    const text = String(value || '').trim();
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trim()}…`;
  },
  hashString: () => 'fixed-hash',
  extractDomainFromUrl: () => 'example.com',
  createKnowledgeSourceInput: ({ sourceUrl, externalId }) => ({
    appId: 'redbox-capture',
    pluginId: 'redbox-browser-extension',
    sourceDomain: 'example.com',
    sourceLink: sourceUrl,
    sourceUrl,
    externalId,
    capturedAt: '2026-08-06T00:00:00.000Z',
  }),
};

test('legacy page payload retains the existing Knowledge-entry contract', () => {
  const payload = {
    type: 'link-article',
    captureKind: 'link-article',
    title: 'Contract title',
    url: 'https://example.com/article',
    text: 'Readable article text',
    excerpt: 'Article excerpt',
    author: 'Author',
    authorProfileUrl: 'https://example.com/author',
    siteName: 'Example',
    coverUrl: 'https://example.com/cover.png',
    images: ['https://example.com/cover.png'],
    tags: ['fixture'],
    richHtmlDocument: '<p>Safe <img src="__IMAGE__"></p>',
    richHtmlImageMap: [{ token: '__IMAGE__', url: 'https://example.com/cover.png' }],
  };
  assert.deepEqual(buildKnowledgeEntryFromPagePayload(payload, mappingHelpers), {
    kind: 'link-article',
    source: {
      appId: 'redbox-capture',
      pluginId: 'redbox-browser-extension',
      sourceDomain: 'example.com',
      sourceLink: 'https://example.com/article',
      sourceUrl: 'https://example.com/article',
      externalId: 'page-fixed-hash',
      capturedAt: '2026-08-06T00:00:00.000Z',
    },
    content: {
      title: 'Contract title',
      author: 'Author',
      authorProfileUrl: 'https://example.com/author',
      text: 'Readable article text',
      excerpt: 'Article excerpt',
      html: '<p>Safe <img src="https://example.com/cover.png"></p>',
      description: 'Readable article text',
      siteName: 'Example',
      tags: ['fixture'],
    },
    assets: {
      coverUrl: 'https://example.com/cover.png',
      imageUrls: ['https://example.com/cover.png'],
    },
    options: { dedupeKey: undefined, allowUpdate: true, summarize: false, transcribe: false },
  });
});

test('WeChat payload keeps remote sources separate from local HTML asset tokens', () => {
  const entry = buildKnowledgeEntryFromPagePayload({
    type: 'link-article',
    captureKind: 'wechat-article',
    title: '公众号文章',
    url: 'https://mp.weixin.qq.com/s/example',
    text: '正文',
    richHtmlDocument: '<article><img src="__WECHAT_ONE__"><img src="__WECHAT_TWO__"></article>',
    richHtmlImageMap: [
      { token: '__WECHAT_ONE__', url: 'data:image/png;base64,legacy', sourceUrl: 'https://mmbiz.qpic.cn/one/640' },
      { token: '__WECHAT_TWO__', url: 'https://mmbiz.qpic.cn/two/640', sourceUrl: 'https://mmbiz.qpic.cn/two/640' },
    ],
    images: ['https://mmbiz.qpic.cn/cover/640'],
  }, mappingHelpers);
  assert.equal(entry.content.html, '<article><img src="__REDBOX_ASSET_image-1__"><img src="__REDBOX_ASSET_image-2__"></article>');
  assert.deepEqual(entry.assets.imageUrls, [
    'https://mmbiz.qpic.cn/one/640',
    'https://mmbiz.qpic.cn/two/640',
  ]);
  assert.doesNotMatch(entry.content.html, /data:image|https:\/\/mmbiz/);
});

test('capture documents normalize unsafe resource URLs and preserve the source URL', () => {
  const document = normalizeCaptureDocument({
    engine: 'defuddle',
    captureKind: 'link-article',
    source: { url: 'https://example.com/article?utm_source=test' },
    content: { title: 'A title', text: 'x'.repeat(400), safeHtml: '<p>Readable</p>' },
    assets: { coverUrl: 'javascript:alert(1)', imageUrls: ['https://example.com/cover.png', 'javascript:alert(1)'] },
  });
  assert.equal(document.source.url, 'https://example.com/article?utm_source=test');
  assert.equal(document.assets.coverUrl, 'https://example.com/cover.png');
  assert.deepEqual(document.assets.imageUrls, ['https://example.com/cover.png']);
  assert.equal(buildKnowledgeEntryFromCaptureDocument(document, mappingHelpers).source.externalId, 'page-fixed-hash');
});

test('quality gates challenge pages and sparse pages before the legacy fallback', () => {
  const blocked = normalizeCaptureDocument({
    source: { url: 'https://example.com/login' },
    content: { title: '请完成安全验证', text: '请完成安全验证后继续访问。' },
  });
  assert.equal(assessCaptureQuality(blocked).status, 'blocked');

  const sparse = normalizeCaptureDocument({
    source: { url: 'https://example.com/empty' },
    content: { title: 'Empty', text: 'Too short' },
  });
  assert.equal(applyCaptureQuality(sparse).status, 'link-only');
});

test('Defuddle extractor works on a detached document and strips active HTML', async () => {
  const document = installDom(`
    <html><head><title>Fixture article</title><meta name="description" content="Fixture description"></head>
    <body><nav>Ignore navigation</nav><article><h1>Fixture article</h1>
      <p>${'This is meaningful article prose for a generic web capture fixture. '.repeat(8)}</p>
      <p>Second paragraph keeps the fixture representative and supplies enough readable detail for an article classification.</p>
      <script>window.bad = true</script><a href="/next">A relative link</a><img src="/cover.png"></article></body></html>
  `);
  const { extractDefuddledCaptureDocument } = await import(`../src/genericCaptureContent.js?fixture=${Date.now()}`);
  const capture = extractDefuddledCaptureDocument(document, 'https://example.com/article');
  assert.equal(capture.engine, 'defuddle');
  assert.equal(capture.source.url, 'https://example.com/article');
  assert.equal(capture.status, 'complete');
  assert.match(capture.content.safeHtml, /https:\/\/example\.com\/next/);
  assert.doesNotMatch(capture.content.safeHtml, /<script|window\.bad/i);
});

test('coordinator caches qualified captures and bypasses WeChat to legacy extraction', async () => {
  let executeCount = 0;
  let messageCount = 0;
  const capture = normalizeCaptureDocument({
    engine: 'defuddle',
    captureKind: 'link-article',
    source: { url: 'https://example.com/article' },
    content: { title: 'Article', text: 'readable '.repeat(80), safeHtml: '<p>readable</p>' },
  });
  const coordinator = createGenericCaptureCoordinator({
    now: () => 100,
    scripting: { executeScript: async () => { executeCount += 1; } },
    tabs: {
      get: async (tabId) => ({ url: tabId === 2 ? 'https://mp.weixin.qq.com/s/example' : 'https://example.com/article' }),
      sendMessage: async () => { messageCount += 1; return { ok: true, capture }; },
    },
  });
  assert.equal((await coordinator.extract(1)).reason, 'defuddle');
  assert.equal((await coordinator.extract(1)).reason, 'cache-hit');
  assert.equal((await coordinator.extract(2)).reason, 'legacy-required');
  assert.equal(executeCount, 1);
  assert.equal(messageCount, 1);
});

test('capture document conversion stays compatible with the old generic payload fields', () => {
  const payload = captureDocumentToLegacyPayload(normalizeCaptureDocument({
    engine: 'defuddle',
    captureKind: 'link-article',
    source: { url: 'https://example.com/a' },
    content: { title: 'Title', text: 'Text', safeHtml: '<p>Text</p>' },
  }));
  assert.equal(payload.type, 'link-article');
  assert.equal(payload.url, 'https://example.com/a');
  assert.equal(payload.richHtmlDocument, '<p>Text</p>');
});
