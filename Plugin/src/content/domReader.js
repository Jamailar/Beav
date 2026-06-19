import { absolutizeSrcset, cssPath, normalizeWhitespace, toAbsoluteUrl, unique } from './domUtils.js';

export function readFrame(options) {
  const adapter = window.XWOW_SITE_ADAPTERS?.match?.() || null;
  const clone = document.documentElement.cloneNode(true);
  cleanNodeTree(clone);
  absolutizeUrls(clone);
  const cleanText = normalizeWhitespace(clone.innerText || document.body?.innerText || '');
  const primaryListCandidate = detectPrimaryListContainer();
  const cleanHtml = clone.outerHTML || '';
  return {
    schemaVersion: 1,
    url: location.href,
    title: document.title || '',
    language: document.documentElement.lang || '',
    websiteTextContent: buildTextContent(cleanText),
    websiteMarkdownContent: cleanHtml,
    extractedData: {
      emails: extractEmails(document.body?.innerText || ''),
      phones: extractPhones(document.body?.innerText || ''),
      images: extractImages(options),
      links: extractLinks(options),
      primaryListCandidate,
      primaryListCandidates: primaryListCandidate ? [primaryListCandidate] : [],
      meta: extractMeta(),
      adapter: adapter ? {
        id: adapter.id,
        label: adapter.label,
        suggestedFields: adapter.suggestedFields || [],
        data: safeAdapterExtract(adapter),
      } : null,
    },
    metadata: {
      frameUrl: location.href,
      referrer: document.referrer || '',
      capturedAt: new Date().toISOString(),
      scroll: {
        x: window.scrollX,
        y: window.scrollY,
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
    },
  };
}

export function readDomSnapshot(options = {}) {
  const frame = readFrame(options);
  return {
    success: true,
    dom_snapshot: frame.websiteMarkdownContent || '',
    url: frame.url || location.href,
    title: frame.title || document.title || '',
    byteLength: new Blob([frame.websiteMarkdownContent || '']).size,
  };
}

export function extractImages(options) {
  const minWidth = Number(options.minImageWidth || 40);
  const minHeight = Number(options.minImageHeight || 40);
  return [...document.images]
    .map((image) => ({
      src: image.currentSrc || image.src || '',
      alt: image.alt || '',
      title: image.title || '',
      width: image.naturalWidth || image.width || 0,
      height: image.naturalHeight || image.height || 0,
    }))
    .filter((image) => image.src && !image.src.startsWith('data:') && image.width >= minWidth && image.height >= minHeight)
    .slice(0, 300);
}

export function extractLinks(options) {
  const limit = Number(options.maxLinks || 500);
  return [...document.links]
    .map((link) => ({
      href: link.href || '',
      text: normalizeWhitespace(link.innerText || link.textContent || ''),
      title: link.title || '',
    }))
    .filter((link) => link.href && /^https?:\/\//i.test(link.href))
    .slice(0, limit);
}

function safeAdapterExtract(adapter) {
  try {
    return adapter.extract ? adapter.extract() : {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function buildTextContent(text) {
  const lines = [
    `Website URL: ${location.href}`,
    `Website Title: ${document.title || ''}`,
    '',
    text,
  ];
  return lines.join('\n').trim();
}

function cleanNodeTree(root) {
  const removeSelectors = [
    'script',
    'style',
    'svg',
    'canvas',
    'noscript',
    'template',
    'iframe',
    'frame',
    'input',
    'textarea',
    'select',
    '[data-thunderbit-ignore]',
    '[data-xwow-ignore]',
    '[aria-hidden="true"]',
  ];
  for (const node of [...root.querySelectorAll(removeSelectors.join(','))]) {
    node.remove();
  }
  for (const node of [...root.querySelectorAll('*')]) {
    const style = window.getComputedStyle(findLiveNode(node) || node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      node.remove();
      continue;
    }
    stripAttributes(node);
    if (!node.textContent?.trim() && !node.querySelector('img,a,table,li')) {
      node.remove();
    }
  }
}

function stripAttributes(node) {
  const keep = new Set([
    'href',
    'src',
    'srcset',
    'alt',
    'title',
    'aria-label',
    'role',
    'data-url',
    'data-link',
    'data-testid',
  ]);
  for (const attr of [...node.attributes]) {
    if (!keep.has(attr.name)) node.removeAttribute(attr.name);
  }
}

function absolutizeUrls(root) {
  for (const node of root.querySelectorAll('[href]')) {
    node.setAttribute('href', toAbsoluteUrl(node.getAttribute('href')));
  }
  for (const node of root.querySelectorAll('[src]')) {
    const src = node.getAttribute('src') || '';
    if (src.startsWith('data:')) {
      node.removeAttribute('src');
    } else {
      node.setAttribute('src', toAbsoluteUrl(src));
    }
  }
  for (const node of root.querySelectorAll('[srcset]')) {
    node.setAttribute('srcset', absolutizeSrcset(node.getAttribute('srcset') || ''));
  }
}

function extractEmails(text) {
  return unique((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).slice(0, 100));
}

function extractPhones(text) {
  const matches = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  return unique(matches.map((item) => item.trim()).filter((item) => /\d{7,}/.test(item.replace(/\D/g, ''))).slice(0, 100));
}

function extractMeta() {
  const out = {};
  for (const meta of document.querySelectorAll('meta[name],meta[property]')) {
    const key = meta.getAttribute('name') || meta.getAttribute('property');
    const content = meta.getAttribute('content');
    if (key && content && Object.keys(out).length < 80) out[key] = content;
  }
  return out;
}

function detectPrimaryListContainer() {
  const candidates = [];
  const elements = [...document.body.querySelectorAll('main,section,article,div,ul,ol,table,[role="list"],[role="feed"],[role="grid"]')];
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 240 || rect.height < 160) continue;
    const children = [...element.children].filter((child) => {
      const childRect = child.getBoundingClientRect();
      return childRect.width > 40 && childRect.height > 20;
    });
    if (children.length < 3) continue;
    const signatures = children.map(childSignature);
    const repeated = maxFrequency(signatures);
    const textLength = normalizeWhitespace(element.innerText || '').length;
    const linkCount = element.querySelectorAll('a[href]').length;
    const areaRatio = Math.min(1, (rect.width * rect.height) / Math.max(1, window.innerWidth * window.innerHeight));
    const repeatScore = repeated / Math.max(1, children.length);
    const itemScore = Math.min(1, children.length / 20);
    const textScore = Math.min(1, textLength / 3000);
    const linkPenalty = linkCount > children.length * 5 ? 0.2 : 0;
    const score = repeatScore * 0.35 + itemScore * 0.25 + areaRatio * 0.2 + textScore * 0.2 - linkPenalty;
    candidates.push({
      selector: cssPath(element),
      tagName: element.tagName.toLowerCase(),
      itemCount: children.length,
      repeatedItemRatio: Number(repeatScore.toFixed(3)),
      score: Number(score.toFixed(3)),
      textSample: normalizeWhitespace(element.innerText || '').slice(0, 600),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function childSignature(element) {
  const classes = [...element.classList].slice(0, 2).join('.');
  return `${element.tagName}:${classes}:${element.children.length}`;
}

function maxFrequency(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return Math.max(0, ...counts.values());
}

function findLiveNode(clonedNode) {
  if (!clonedNode || clonedNode === document.documentElement) return document.documentElement;
  return null;
}
