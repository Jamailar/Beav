import capabilityManifest from './siteResearchCapabilities.json' with { type: 'json' };

const MAX_SNAPSHOT_CHARS = 180_000;

export const SITE_RESEARCH_CONTRACT_VERSION = capabilityManifest.contractVersion;

const SITE_SEARCH_URL_BUILDERS = Object.freeze({
  xiaohongshu: (query) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`,
  douyin: (query) => `https://www.douyin.com/search/${encodeURIComponent(query)}`,
});

const SITE_RESEARCH_FILTERS = Object.freeze({
  xiaohongshu: Object.freeze({
    sort: Object.freeze(['relevance', 'latest', 'most_liked']),
    contentType: Object.freeze(['all', 'image_text', 'video']),
    publishTime: Object.freeze(['all', 'day', 'week', 'half_year']),
  }),
  douyin: Object.freeze({
    sort: Object.freeze(['relevance', 'latest', 'most_liked']),
    contentType: Object.freeze(['all', 'image_text', 'video']),
    publishTime: Object.freeze(['all', 'day', 'week', 'half_year']),
  }),
});

export const SITE_CAPABILITY_SPECS = Object.freeze(Object.fromEntries(
  capabilityManifest.capabilities.map((capability) => [capability.id, Object.freeze({
    ...capability,
    hosts: [...capability.hostPatterns],
    operations: [...capability.supportedOperations],
    filters: Object.fromEntries(Object.entries(capability.supportedFilters || {}).map(([key, values]) => [key, [...values]])),
    searchUrl: SITE_SEARCH_URL_BUILDERS[capability.id],
  })]),
));

export function listSiteCapabilities() {
  return Object.values(SITE_CAPABILITY_SPECS).map((spec) => ({
    id: spec.id,
    displayName: spec.displayName,
    operations: [...spec.operations],
    filters: Object.fromEntries(Object.entries(spec.filters).map(([key, values]) => [key, [...values]])),
    capabilityVersion: spec.capabilityVersion,
    extractorSchemaHash: spec.extractorSchemaHash,
  }));
}

export function normalizeResearchRequest(input = {}) {
  const operation = String(input.operation || input.researchOperation || '').trim().toLowerCase();
  if (!['search', 'author_scan', 'content_scan'].includes(operation)) {
    throw new Error('research.run requires operation: search, author_scan, or content_scan');
  }
  const query = String(input.query || input.keyword || '').trim();
  const sourceUrl = normalizeHttpUrl(input.url || input.sourceUrl || input.profileUrl || input.contentUrl || '');
  const site = resolveSiteCapability(input.siteId || input.site || input.platform || '', sourceUrl);
  if (!site.operations.includes(operation)) {
    throw new Error(`${site.displayName} does not support research operation: ${operation}`);
  }
  if (operation === 'search' && !query) throw new Error('research.run search requires query');
  if (operation !== 'search' && !sourceUrl && !Number.isInteger(Number(input.tabId))) {
    throw new Error(`research.run ${operation} requires url or tabId`);
  }
  return {
    site,
    operation,
    query,
    sourceUrl,
    tabId: positiveInteger(input.tabId),
    active: input.active !== false,
    timeoutMs: clampNumber(input.timeoutMs, 1_000, 60_000, 20_000),
    snapshot: input.snapshot !== false,
    limit: clampNumber(input.limit, 1, 100, 10),
    commentLimit: clampNumber(input.commentLimit, 0, 100, 8),
    filters: normalizeResearchFilters(input.filters, site, operation),
    depth: normalizeDepth(input.depth),
    maxScrolls: clampNumber(input.maxScrolls, 0, 8, 3),
    downloadMedia: input.downloadMedia === true || input.ocr === true || input.transcribeAudio === true,
    ocr: input.ocr === true,
    transcribeAudio: input.transcribeAudio === true,
    executionMode: normalizeExecutionMode(input.executionMode),
    media: Array.isArray(input.media) ? input.media.slice(0, 40) : [],
  };
}

export async function runSiteResearch(requestInput, deps = {}) {
  const request = normalizeResearchRequest(requestInput);
  if (request.executionMode !== 'macro') {
    return await runSiteResearchStep(request, deps);
  }
  if (typeof deps.createControlledTab !== 'function' || typeof deps.claimTab !== 'function' || typeof deps.readSnapshot !== 'function' || typeof deps.readSiteEvidence !== 'function') {
    throw new Error('site research runtime is missing browser dependencies');
  }
  const targetUrl = request.operation === 'search'
    ? request.site.searchUrl?.(request.query)
    : request.sourceUrl;
  if (!targetUrl && !request.tabId) throw new Error(`${request.site.displayName} research route is unavailable`);
  let tab = request.tabId ? await deps.getTab?.(request.tabId) : null;
  if (!tab) {
    const created = await deps.createControlledTab({ url: targetUrl, active: request.active });
    tab = created?.tab || null;
    if (!tab?.id) throw new Error('site research could not create browser tab');
  }
  await deps.claimTab(tab.id, request.operation === 'search' ? 'research_search' : 'research_source');
  if (typeof deps.waitForTabComplete === 'function') await deps.waitForTabComplete(tab.id, request.timeoutMs);
  const current = await deps.getTab?.(tab.id) || tab;
  let extracted = unwrapContentDelivery(await deps.readSiteEvidence(tab.id, request));
  if (extracted?.success === false && extracted?.reason) {
    return {
      success: false,
      kind: 'browser_research',
      site: siteMetadata(request.site),
      operation: request.operation,
      sourceUrl: current?.url || targetUrl,
      reason: extracted.reason,
      retryable: false,
      partial: false,
      handoff: {
        required: true,
        tabId: tab.id,
        message: extracted.reason === 'login_required' ? '请在浏览器完成登录' : '请在浏览器完成安全验证',
      },
    };
  }
  let filterResult = null;
  if (Object.keys(request.filters).length) {
    if (typeof deps.applyFilters !== 'function') {
      return researchFilterFailure(request, current, targetUrl, {
        reason: 'filter_runtime_unavailable',
        message: 'site research filter dependency is unavailable',
      });
    }
    filterResult = unwrapContentDelivery(await deps.applyFilters(tab.id, request));
    if (filterResult?.success !== true) {
      return researchFilterFailure(request, current, targetUrl, filterResult);
    }
    extracted = unwrapContentDelivery(await deps.readSiteEvidence(tab.id, request));
    if (extracted?.success === false && extracted?.reason) {
      return {
        success: false,
        kind: 'browser_research',
        site: siteMetadata(request.site),
        operation: request.operation,
        sourceUrl: current?.url || targetUrl,
        reason: extracted.reason,
        retryable: false,
        partial: false,
      };
    }
  }
  if (request.operation === 'search' || request.operation === 'author_scan') {
    extracted = await collectBoundedCards(tab.id, request, extracted, deps);
  }
  const deep = request.depth === 'preview'
    ? { items: [], failures: [] }
    : await collectDeepItems(request, extracted?.items || [], deps);
  const snapshot = request.snapshot
    ? unwrapContentDelivery(await deps.readSnapshot(tab.id))
    : null;
  const text = serializeSnapshot(snapshot);
  const selectedItems = deep.items.length ? deep.items : extracted?.items || [];
  const mediaDownloads = request.downloadMedia
    ? await downloadResearchMedia(request, extracted, selectedItems, deps)
    : { items: [], failures: [] };
  const failures = [...deep.failures, ...mediaDownloads.failures];
  return {
    success: true,
    kind: 'browser_research',
    site: siteMetadata(request.site),
    operation: request.operation,
    depth: request.depth,
    query: request.query || undefined,
    filters: {
      requested: request.filters,
      applied: filterResult?.applied || {},
    },
    sourceUrl: targetUrl,
    tab: normalizeTab(current),
    pageState: extracted?.pageState || null,
    author: extracted?.author || null,
    content: extracted?.content || null,
    items: selectedItems,
    failures,
    partial: failures.length > 0,
    mediaDownloads: mediaDownloads.items,
    counts: {
      cards: (extracted?.items || []).length,
      opened: deep.items.length + deep.failures.length,
      items: selectedItems.length,
      comments: selectedItems.reduce((total, item) => total + (item.content?.comments?.length || item.comments?.length || 0), extracted?.content?.comments?.length || 0),
      media: selectedItems.reduce((total, item) => total + (item.content?.media?.length || item.media?.length || 0), extracted?.content?.media?.length || 0),
      failed: failures.length,
    },
    evidence: {
      capturedAt: new Date().toISOString(),
      sourceUrl: current?.url || targetUrl,
      title: current?.title || '',
      snapshot: text,
      truncated: text.length >= MAX_SNAPSHOT_CHARS,
      structured: extracted,
    },
  };
}

async function runSiteResearchStep(request, deps) {
  if (!request.tabId || typeof deps.getTab !== 'function') {
    throw new Error(`research.run ${request.executionMode} requires tabId`);
  }
  const tab = await deps.getTab(request.tabId);
  if (!tab?.id) throw new Error('site research step tab is unavailable');
  if (request.executionMode === 'extract') {
    if (typeof deps.readSiteEvidence !== 'function') {
      throw new Error('site research extract dependency is unavailable');
    }
    const extracted = unwrapContentDelivery(await deps.readSiteEvidence(tab.id, request));
    return {
      ...extracted,
      kind: 'browser_research_step',
      step: 'extract',
      site: siteMetadata(request.site),
      operation: request.operation,
      sourceUrl: tab.url || request.sourceUrl,
      tab: normalizeTab(tab),
    };
  }
  if (request.executionMode === 'apply_filters') {
    if (typeof deps.applyFilters !== 'function') {
      throw new Error('site research filter dependency is unavailable');
    }
    const applied = unwrapContentDelivery(await deps.applyFilters(tab.id, request));
    return {
      ...applied,
      kind: 'browser_research_step',
      step: 'apply_filters',
      site: siteMetadata(request.site),
      operation: request.operation,
      sourceUrl: tab.url || request.sourceUrl,
      tab: normalizeTab(tab),
    };
  }
  if (request.executionMode === 'download_media') {
    const mediaDownloads = await downloadResearchMedia(
      request,
      { content: { media: request.media } },
      [],
      deps,
    );
    return {
      success: true,
      kind: 'browser_research_step',
      step: 'download_media',
      site: siteMetadata(request.site),
      operation: request.operation,
      sourceUrl: tab.url || request.sourceUrl,
      tab: normalizeTab(tab),
      mediaDownloads: mediaDownloads.items,
      failures: mediaDownloads.failures,
      partial: mediaDownloads.failures.length > 0,
    };
  }
  throw new Error(`unsupported site research execution mode: ${request.executionMode}`);
}

function normalizeResearchFilters(value, site, operation) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('research.run filters must be an object');
  }
  const entries = Object.entries(value).filter(([, filterValue]) => filterValue !== undefined && filterValue !== null && String(filterValue).trim());
  if (!entries.length) return {};
  if (operation !== 'search') throw new Error('research.run filters are only supported for search');
  const supported = SITE_RESEARCH_FILTERS[site.id];
  if (!supported) throw new Error(`${site.displayName} does not support research filters`);
  const normalized = {};
  for (const [key, rawValue] of entries) {
    const values = supported[key];
    if (!values) throw new Error(`${site.displayName} does not support research filter: ${key}`);
    const filterValue = String(rawValue).trim().toLowerCase();
    if (!values.includes(filterValue)) {
      throw new Error(`${site.displayName} does not support ${key} filter value: ${filterValue}`);
    }
    normalized[key] = filterValue;
  }
  return normalized;
}

function unwrapContentDelivery(value) {
  if (value?.response && typeof value.response === 'object' && !Array.isArray(value.response)) {
    return value.response;
  }
  return value;
}

function researchFilterFailure(request, tab, targetUrl, failure = {}) {
  return {
    success: false,
    kind: 'browser_research',
    site: siteMetadata(request.site),
    operation: request.operation,
    sourceUrl: tab?.url || targetUrl,
    reason: failure?.reason || 'filter_option_unavailable',
    retryable: false,
    partial: false,
    failure: {
      message: String(failure?.message || 'requested site filter is unavailable').slice(0, 500),
      filter: failure?.filter || null,
      value: failure?.value || null,
    },
  };
}

async function downloadResearchMedia(request, extracted, selectedItems, deps) {
  if (typeof deps.downloadAsset !== 'function') {
    return {
      items: [],
      failures: [{ reason: 'media_download_unavailable', message: 'browser media download dependency is unavailable' }],
    };
  }
  const media = [];
  const seen = new Set();
  const append = (items) => {
    for (const item of items || []) {
      const sourceUrl = String(item?.sourceUrl || item?.url || '').trim();
      if (!/^https?:\/\//i.test(sourceUrl) || seen.has(sourceUrl)) continue;
      seen.add(sourceUrl);
      media.push({ ...item, sourceUrl });
      if (media.length >= 40) return;
    }
  };
  append(extracted?.content?.media);
  for (const item of selectedItems) append(item?.content?.media || item?.media);
  const items = [];
  const failures = [];
  for (const asset of media) {
    try {
      const result = await deps.downloadAsset(asset, request);
      if (result?.success !== true || !result?.path) {
        throw new Error(result?.error || result?.status || 'download did not return a local path');
      }
      items.push({
        sourceUrl: asset.sourceUrl,
        type: asset.type || 'unknown',
        downloadId: result.download_id || result.downloadId || result.download?.id || null,
        localPath: result.path,
        mimeType: result.download?.mime || '',
        bytes: result.download?.totalBytes || result.download?.bytesReceived || 0,
        status: 'completed',
      });
    } catch (error) {
      failures.push({
        reason: 'media_download_failed',
        sourceUrl: asset.sourceUrl,
        message: String(error?.message || error || 'media download failed').slice(0, 500),
      });
    }
  }
  return { items, failures };
}

async function collectBoundedCards(tabId, request, first, deps) {
  const collected = new Map((first?.items || []).map((item) => [item.sourceUrl || item.id, item]));
  let latest = first || {};
  for (let index = 0; index < request.maxScrolls && collected.size < request.limit; index += 1) {
    if (typeof deps.scrollPage !== 'function') break;
    const scrolled = unwrapContentDelivery(await deps.scrollPage(tabId));
    if (scrolled?.success === false) break;
    await new Promise((resolve) => setTimeout(resolve, 450));
    latest = unwrapContentDelivery(await deps.readSiteEvidence(tabId, request));
    if (latest?.success === false) break;
    for (const item of latest?.items || []) {
      const key = item.sourceUrl || item.id;
      if (key && !collected.has(key)) collected.set(key, item);
      if (collected.size >= request.limit) break;
    }
  }
  return { ...first, ...latest, items: [...collected.values()].slice(0, request.limit) };
}

async function collectDeepItems(request, cards, deps) {
  if (!cards.length || typeof deps.closeTab !== 'function') return { items: [], failures: [] };
  const items = [];
  const failures = [];
  for (const card of cards.slice(0, request.limit)) {
    let detailTab = null;
    try {
      const created = await deps.createControlledTab({ url: card.sourceUrl, active: false });
      detailTab = created?.tab || null;
      if (!detailTab?.id) throw new Error('detail tab was not created');
      await deps.claimTab(detailTab.id, 'research_detail');
      if (typeof deps.waitForTabComplete === 'function') await deps.waitForTabComplete(detailTab.id, request.timeoutMs);
      const detail = unwrapContentDelivery(await deps.readSiteEvidence(detailTab.id, { ...request, operation: 'content_scan' }));
      if (detail?.success === false) throw new Error(detail.reason || 'detail extraction failed');
      items.push({ ...card, content: detail.content || null, pageState: detail.pageState || null });
    } catch (error) {
      failures.push({
        sourceUrl: card.sourceUrl || '',
        reason: String(error?.message || error || 'detail extraction failed').slice(0, 500),
      });
    } finally {
      if (detailTab?.id) await deps.closeTab(detailTab.id);
    }
  }
  return { items, failures };
}

function siteMetadata(site) {
  return {
    id: site.id,
    displayName: site.displayName,
    capabilityVersion: site.capabilityVersion,
    extractorSchemaHash: site.extractorSchemaHash,
    supportedFilters: site.filters,
  };
}

function resolveSiteCapability(value, sourceUrl) {
  const requested = String(value || '').trim().toLowerCase();
  const alias = Object.values(SITE_CAPABILITY_SPECS)
    .find((spec) => spec.aliases.includes(requested))?.id || '';
  const id = alias || requested || inferSiteId(sourceUrl);
  const spec = SITE_CAPABILITY_SPECS[id];
  if (!spec) throw new Error('research.run requires supported site: xiaohongshu, douyin, youtube, or web');
  if (sourceUrl && !urlMatchesSite(sourceUrl, spec)) throw new Error(`URL does not belong to ${spec.displayName}`);
  return spec;
}

function inferSiteId(sourceUrl) {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    return Object.values(SITE_CAPABILITY_SPECS).find((spec) => spec.hosts.some((suffix) => suffix !== '*' && (host === suffix || host.endsWith(`.${suffix}`))))?.id || 'web';
  } catch {
    return '';
  }
}

function urlMatchesSite(url, spec) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return spec.hosts.includes('*') || spec.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function normalizeDepth(value) {
  const depth = String(value || 'standard').trim().toLowerCase();
  if (!['preview', 'standard', 'deep'].includes(depth)) throw new Error(`unsupported research depth: ${depth}`);
  return depth;
}

function normalizeExecutionMode(value) {
  const mode = String(value || 'macro').trim().toLowerCase();
  if (!['macro', 'extract', 'apply_filters', 'download_media'].includes(mode)) {
    throw new Error(`unsupported site research execution mode: ${mode}`);
  }
  return mode;
}

function normalizeHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = new URL(text);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('research.run URL must use http or https');
  return parsed.toString();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function normalizeTab(tab = {}) {
  return { id: tab.id, windowId: tab.windowId || null, url: tab.url || '', title: tab.title || '', active: tab.active === true };
}

function serializeSnapshot(value) {
  const raw = typeof value?.snapshot === 'string' ? value.snapshot : JSON.stringify(value || {}, null, 2);
  return raw.slice(0, MAX_SNAPSHOT_CHARS);
}
