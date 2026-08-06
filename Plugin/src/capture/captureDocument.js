export const CAPTURE_DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_CAPTURE_TEXT_LENGTH = 24_000;
export const MAX_CAPTURE_HTML_LENGTH = 1_000_000;
export const MAX_CAPTURE_IMAGE_COUNT = 8;

export function normalizeCaptureText(value, maxLength = MAX_CAPTURE_TEXT_LENGTH) {
  const text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

export function normalizeHttpUrl(value, baseUrl = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, baseUrl || undefined);
    return /^https?:$/i.test(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function inferSiteName(sourceUrl, fallback = '') {
  if (fallback) return normalizeCaptureText(fallback, 240);
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

export function hashCaptureContent(value) {
  const input = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function uniqueStrings(values, normalizer, limit) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizer(value);
    if (normalized && !result.includes(normalized)) result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * The browser-side representation is intentionally small and versioned.  It is
 * mapped to the existing Knowledge entry payload in the background service
 * worker, so no Desktop protocol, data model, or dedupe behavior changes.
 */
export function normalizeCaptureDocument(input = {}) {
  const sourceUrl = normalizeHttpUrl(input?.source?.url || input?.url);
  const text = normalizeCaptureText(input?.content?.text || input?.text);
  const markdown = normalizeCaptureText(input?.content?.markdown || input?.markdown, MAX_CAPTURE_TEXT_LENGTH);
  const safeHtml = String(input?.content?.safeHtml || input?.safeHtml || '')
    .trim()
    .slice(0, MAX_CAPTURE_HTML_LENGTH);
  const title = normalizeCaptureText(input?.content?.title || input?.title, 500) || '网页收藏';
  const excerpt = normalizeCaptureText(input?.content?.excerpt || input?.excerpt || text, 500);
  const captureKind = normalizeCaptureText(input?.captureKind, 120) || 'webpage';
  const status = ['complete', 'partial', 'link-only', 'blocked'].includes(input?.status)
    ? input.status
    : (text ? 'partial' : 'link-only');
  const author = normalizeCaptureText(input?.content?.author || input?.author, 240);
  const siteName = inferSiteName(sourceUrl, input?.content?.siteName || input?.siteName);
  const tags = uniqueStrings(input?.content?.tags || input?.tags, (value) => normalizeCaptureText(value, 80), 12);
  const imageUrls = uniqueStrings(
    input?.assets?.imageUrls || input?.images,
    (value) => normalizeHttpUrl(value, sourceUrl),
    MAX_CAPTURE_IMAGE_COUNT,
  );
  const coverUrl = normalizeHttpUrl(input?.assets?.coverUrl || input?.coverUrl, sourceUrl) || imageUrls[0] || '';

  return {
    schemaVersion: CAPTURE_DOCUMENT_SCHEMA_VERSION,
    engine: normalizeCaptureText(input?.engine, 80) || 'legacy',
    status,
    captureKind,
    source: {
      url: sourceUrl,
      canonicalUrl: normalizeHttpUrl(input?.source?.canonicalUrl || input?.canonicalUrl, sourceUrl) || sourceUrl,
      title,
    },
    content: {
      title,
      text,
      markdown,
      safeHtml,
      excerpt,
      author,
      authorProfileUrl: normalizeHttpUrl(input?.content?.authorProfileUrl || input?.authorProfileUrl, sourceUrl),
      siteName,
      tags,
    },
    assets: {
      coverUrl,
      imageUrls,
    },
    diagnostics: {
      warnings: uniqueStrings(input?.diagnostics?.warnings, (value) => normalizeCaptureText(value, 160), 12),
      contentHash: hashCaptureContent(`${sourceUrl}\n${title}\n${text}`),
    },
  };
}

export function captureDocumentToLegacyPayload(document) {
  const normalized = normalizeCaptureDocument(document);
  const isArticle = normalized.captureKind === 'link-article' || normalized.status === 'complete';
  return {
    type: isArticle ? 'link-article' : 'text',
    captureKind: normalized.captureKind,
    title: normalized.content.title,
    url: normalized.source.url,
    text: normalized.content.text || normalized.content.markdown || normalized.content.excerpt || normalized.source.url,
    excerpt: normalized.content.excerpt,
    author: normalized.content.author,
    authorProfileUrl: normalized.content.authorProfileUrl,
    siteName: normalized.content.siteName,
    coverUrl: normalized.assets.coverUrl,
    images: normalized.assets.imageUrls,
    tags: normalized.content.tags,
    richHtmlDocument: normalized.content.safeHtml,
    richHtmlImageMap: [],
  };
}
