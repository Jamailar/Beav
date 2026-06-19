import { sendContentMessage } from './dynamicContentInjection.js';

const CONTENT_READ_TYPE = 'xwow-data-ai:read-frame';
const CONTENT_DOM_SNAPSHOT_TYPE = 'xwow-data-ai:dom-snapshot';
const CONTENT_TYPES = new Set(['html', 'text', 'domSnapshot']);

export async function fetchUrlContents(action = {}) {
  const urls = normalizeUrlList(action.urls);
  const contentType = normalizeContentType(action.content_type ?? action.contentType);
  const timeoutMs = Number((action.timeoutMs ?? action.timeout_ms) || 30_000);
  const keepOpen = action.keepOpen === true || action.keep === true;
  const results = [];
  for (const url of urls) {
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url, active: action.active === true });
      await waitForTabComplete(tab.id, timeoutMs);
      const result = await readTabContent(tab.id, contentType, action);
      results.push({
        url: result.url || url,
        title: result.title || null,
        content: typeof result.content === 'string' ? result.content : null,
      });
    } catch (error) {
      results.push({
        url,
        title: null,
        content: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (tab?.id && !keepOpen) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  return {
    success: true,
    content_type: contentType,
    results,
  };
}

async function readTabContent(tabId, contentType, action = {}) {
  if (contentType === 'domSnapshot') {
    const result = await sendContentMessage(tabId, CONTENT_DOM_SNAPSHOT_TYPE, action.options || action, 0);
    const response = result?.response || result || {};
    return {
      url: response.url || '',
      title: response.title || '',
      content: response.dom_snapshot || '',
    };
  }
  const result = await sendContentMessage(tabId, CONTENT_READ_TYPE, action.options || action, 0);
  const frame = result?.response?.data || result?.data || {};
  return {
    url: frame.url || '',
    title: frame.title || '',
    content: contentType === 'html' ? frame.websiteMarkdownContent || '' : frame.websiteTextContent || '',
  };
}

function normalizeUrlList(value) {
  const urls = (Array.isArray(value) ? value : [value])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (!urls.length) throw new Error('browser.fetchUrls requires at least one URL');
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`browser.fetchUrls only supports http(s) URLs: ${url}`);
  }
  return urls.slice(0, 20);
}

function normalizeContentType(value) {
  const contentType = String(value || 'text');
  if (!CONTENT_TYPES.has(contentType)) throw new Error('browser.fetchUrls content_type must be html, text, or domSnapshot');
  return contentType;
}

async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'complete') return tab;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for tab ${tabId} to load`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
