import { captureDocumentToLegacyPayload } from './captureDocument.js';

function fallbackNormalizeText(value) {
  return String(value || '').trim();
}

function fallbackTruncateText(value, maxLength) {
  const normalized = fallbackNormalizeText(value);
  if (!normalized || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function fallbackHashString(value) {
  const input = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function fallbackDomain(value) {
  try {
    return String(new URL(value).hostname || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function replaceTokens(html, replacements, normalizeText, useKnowledgeAssetTokens = false) {
  let output = String(html || '');
  for (const [index, item] of (Array.isArray(replacements) ? replacements : []).entries()) {
    const token = normalizeText(item?.token);
    const replacement = useKnowledgeAssetTokens
      ? `__REDBOX_ASSET_image-${index + 1}__`
      : normalizeText(item?.url);
    if (!token || !replacement) continue;
    output = output.split(token).join(replacement);
  }
  return output;
}

/**
 * This is deliberately the old Knowledge payload shape. New capture engines
 * are not allowed to bypass it, which protects existing Desktop ingestion,
 * source identity, and dedupe semantics.
 */
export function buildKnowledgeEntryFromPagePayload(payload = {}, helpers = {}) {
  const normalizeText = helpers.normalizeText || fallbackNormalizeText;
  const truncateText = helpers.truncateText || fallbackTruncateText;
  const hashString = helpers.hashString || fallbackHashString;
  const extractDomainFromUrl = helpers.extractDomainFromUrl || fallbackDomain;
  const createKnowledgeSourceInput = helpers.createKnowledgeSourceInput || ((fields) => ({
    appId: 'redbox-capture',
    pluginId: 'redbox-browser-extension',
    sourceDomain: fields.sourceDomain || undefined,
    sourceLink: fields.sourceUrl || undefined,
    sourceUrl: fields.sourceUrl || undefined,
    externalId: fields.externalId || undefined,
    capturedAt: helpers.capturedAt || new Date().toISOString(),
  }));

  const sourceUrl = normalizeText(payload?.url);
  const sourceDomain = extractDomainFromUrl(sourceUrl);
  const title = normalizeText(payload?.title) || '网页收藏';
  const kind = normalizeText(payload?.captureKind)
    || (payload?.type === 'link-article' ? 'link-article' : 'webpage');
  const richHtmlImageMap = Array.isArray(payload?.richHtmlImageMap) ? payload.richHtmlImageMap : [];
  const richHtmlDocument = replaceTokens(
    payload?.richHtmlDocument,
    richHtmlImageMap,
    normalizeText,
    kind === 'wechat-article',
  );
  const richHtmlImageUrls = richHtmlImageMap
    .map((item) => normalizeText(item?.sourceUrl || item?.url))
    .filter((url) => /^https:\/\//i.test(url));
  const text = normalizeText(payload?.text)
    || normalizeText(payload?.excerpt)
    || sourceUrl;

  if (!sourceUrl) throw new Error('当前页面缺少可保存的链接地址');

  return {
    kind,
    source: createKnowledgeSourceInput({
      sourceUrl,
      externalId: `page-${hashString(sourceUrl)}`,
    }),
    content: {
      title,
      author: normalizeText(payload?.author),
      authorProfileUrl: normalizeText(payload?.authorProfileUrl) || undefined,
      text,
      excerpt: truncateText(payload?.excerpt || text, 180),
      html: richHtmlDocument || undefined,
      description: truncateText(text, 500),
      siteName: normalizeText(payload?.siteName) || sourceDomain || undefined,
      tags: Array.isArray(payload?.tags) ? payload.tags.filter(Boolean) : [],
    },
    assets: {
      coverUrl: normalizeText(payload?.coverUrl) || undefined,
      imageUrls: kind === 'wechat-article'
        ? richHtmlImageUrls.slice(0, 80)
        : (Array.isArray(payload?.images) ? payload.images.filter(Boolean) : []),
    },
    options: {
      dedupeKey: undefined,
      allowUpdate: true,
      summarize: false,
      transcribe: false,
    },
  };
}

export function buildKnowledgeEntryFromCaptureDocument(document, helpers = {}) {
  return buildKnowledgeEntryFromPagePayload(captureDocumentToLegacyPayload(document), helpers);
}
