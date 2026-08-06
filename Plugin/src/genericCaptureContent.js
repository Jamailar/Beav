import Defuddle from 'defuddle';
import DOMPurify from 'dompurify';
import {
  normalizeCaptureDocument,
  normalizeCaptureText,
  normalizeHttpUrl,
} from './capture/captureDocument.js';
import { applyCaptureQuality } from './capture/captureQuality.js';
import { GENERIC_CAPTURE_MESSAGE_TYPE } from './capture/genericCaptureProtocol.js';

const GENERIC_CAPTURE_LISTENER_KEY = '__redboxGenericCaptureListenerV1__';

function getMeta(document, selector) {
  return document.querySelector(selector)?.getAttribute('content') || '';
}

function cloneCurrentDocument(document) {
  const parser = new DOMParser();
  const clone = parser.parseFromString(document.documentElement.outerHTML, 'text/html');
  const sourceBase = document.querySelector('base[href]')?.getAttribute('href') || document.URL;
  if (!clone.querySelector('base[href]') && sourceBase) {
    const base = clone.createElement('base');
    base.setAttribute('href', sourceBase);
    clone.head?.prepend(base);
  }
  return clone;
}

function sanitizeArticleHtml(html, sourceUrl) {
  if (!html) return '';
  const purifier = typeof DOMPurify.sanitize === 'function' ? DOMPurify : DOMPurify(globalThis.window);
  const sanitized = purifier.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['base', 'form', 'input', 'button', 'textarea', 'iframe', 'object', 'embed', 'canvas', 'audio', 'video'],
    FORBID_ATTR: ['style'],
  });
  // DOMPurify is the primary guard. The small DOM pass also normalizes URLs and
  // protects extraction in browser-compatible DOM shims that return an empty
  // string from DOMPurify despite valid article markup.
  const parsed = new DOMParser().parseFromString(sanitized || html, 'text/html');
  for (const node of parsed.querySelectorAll('script, style, noscript, iframe, object, embed, base, form, input, button, textarea, canvas, audio, video')) {
    node.remove();
  }
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = String(attribute.name || '').toLowerCase();
      if (name.startsWith('on') || name === 'style') element.removeAttribute(attribute.name);
    }
  }
  for (const element of parsed.querySelectorAll('[href], [src]')) {
    for (const attribute of ['href', 'src']) {
      if (!element.hasAttribute(attribute)) continue;
      const resolved = normalizeHttpUrl(element.getAttribute(attribute), sourceUrl);
      if (resolved) element.setAttribute(attribute, resolved);
      else element.removeAttribute(attribute);
    }
  }
  for (const anchor of parsed.querySelectorAll('a[href]')) {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
  return (parsed.body?.innerHTML || parsed.documentElement?.outerHTML || '').trim();
}

function collectImageUrls(document, sourceUrl, image) {
  const urls = [];
  const push = (value) => {
    const url = normalizeHttpUrl(value, sourceUrl);
    if (url && !urls.includes(url)) urls.push(url);
  };
  push(image);
  push(getMeta(document, 'meta[property="og:image"]'));
  push(getMeta(document, 'meta[name="twitter:image"]'));
  for (const node of document.querySelectorAll('img[src], img[data-src], img[data-original]')) {
    push(node.getAttribute('src'));
    push(node.getAttribute('data-src'));
    push(node.getAttribute('data-original'));
    if (urls.length >= 8) break;
  }
  return urls.slice(0, 8);
}

/**
 * Runs only after the user invokes a normal page-save command.  The input is a
 * detached DOM clone: content extraction is never allowed to mutate the page.
 */
export function extractDefuddledCaptureDocument(document = globalThis.document, sourceUrlOverride = '') {
  const sourceUrl = normalizeHttpUrl(sourceUrlOverride || document?.URL || globalThis.location?.href);
  if (!document?.documentElement || !sourceUrl) {
    throw new Error('当前页面缺少可读取的网页地址');
  }

  const clonedDocument = cloneCurrentDocument(document);
  const defuddled = new Defuddle(clonedDocument, { url: sourceUrl }).parse();
  const safeHtml = sanitizeArticleHtml(defuddled.content || '', sourceUrl);
  const readableDocument = new DOMParser().parseFromString(safeHtml || defuddled.content || '', 'text/html');
  const text = normalizeCaptureText(
    readableDocument.body?.textContent || readableDocument.documentElement?.textContent,
  );
  const title = normalizeCaptureText(defuddled.title || document.title || getMeta(document, 'meta[property="og:title"]'), 500);
  const description = normalizeCaptureText(defuddled.description || getMeta(document, 'meta[name="description"]'), 500);
  const imageUrls = collectImageUrls(document, sourceUrl, defuddled.image);
  const capture = normalizeCaptureDocument({
    engine: 'defuddle',
    captureKind: 'link-article',
    source: {
      url: sourceUrl,
      canonicalUrl: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || sourceUrl,
    },
    content: {
      title,
      text,
      // The current Knowledge endpoint indexes content.text and retains safeHtml.
      // Avoid loading Defuddle's Markdown renderer (about 600 KiB) for a field
      // that no current consumer reads; the schema keeps it optional for a
      // future endpoint that explicitly accepts Markdown.
      markdown: '',
      safeHtml,
      excerpt: description || text.slice(0, 180),
      author: defuddled.author || getMeta(document, 'meta[name="author"]'),
      siteName: defuddled.site || getMeta(document, 'meta[property="og:site_name"]'),
      tags: [],
    },
    assets: { coverUrl: imageUrls[0], imageUrls },
    diagnostics: { warnings: safeHtml ? [] : ['defuddle-returned-no-html'] },
  });
  return applyCaptureQuality(capture);
}

function installGenericCaptureListener() {
  if (globalThis[GENERIC_CAPTURE_LISTENER_KEY]) return;
  globalThis[GENERIC_CAPTURE_LISTENER_KEY] = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== GENERIC_CAPTURE_MESSAGE_TYPE) return undefined;
    try {
      const capture = extractDefuddledCaptureDocument(document);
      sendResponse({ ok: true, capture });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  });
}

if (globalThis.chrome?.runtime?.onMessage) {
  installGenericCaptureListener();
}
