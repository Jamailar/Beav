const MAX_SNAPSHOT_CHARS = 180_000;

export const SITE_CAPABILITY_SPECS = Object.freeze({
  xiaohongshu: Object.freeze({
    id: 'xiaohongshu',
    displayName: '小红书',
    hosts: ['xiaohongshu.com', 'xhslink.com'],
    operations: ['search', 'author_scan', 'content_scan'],
    searchUrl(query) {
      return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`;
    },
  }),
  douyin: Object.freeze({
    id: 'douyin',
    displayName: '抖音',
    hosts: ['douyin.com', 'iesdouyin.com'],
    operations: ['content_scan'],
  }),
  youtube: Object.freeze({
    id: 'youtube',
    displayName: 'YouTube',
    hosts: ['youtube.com', 'youtu.be'],
    operations: ['content_scan'],
  }),
});

export function listSiteCapabilities() {
  return Object.values(SITE_CAPABILITY_SPECS).map((spec) => ({
    id: spec.id,
    displayName: spec.displayName,
    operations: [...spec.operations],
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
  };
}

export async function runSiteResearch(requestInput, deps = {}) {
  const request = normalizeResearchRequest(requestInput);
  if (typeof deps.createControlledTab !== 'function' || typeof deps.claimTab !== 'function' || typeof deps.readSnapshot !== 'function') {
    throw new Error('site research runtime is missing browser dependencies');
  }
  const targetUrl = request.operation === 'search'
    ? request.site.searchUrl(request.query)
    : request.sourceUrl;
  let tab = request.tabId ? await deps.getTab?.(request.tabId) : null;
  if (!tab) {
    const created = await deps.createControlledTab({ url: targetUrl, active: request.active });
    tab = created?.tab || null;
    if (!tab?.id) throw new Error('site research could not create browser tab');
  }
  await deps.claimTab(tab.id, request.operation === 'search' ? 'research_search' : 'research_source');
  if (typeof deps.waitForTabComplete === 'function') await deps.waitForTabComplete(tab.id, request.timeoutMs);
  const current = await deps.getTab?.(tab.id) || tab;
  const snapshot = request.snapshot ? await deps.readSnapshot(tab.id) : null;
  const text = serializeSnapshot(snapshot);
  return {
    success: true,
    kind: 'browser_research',
    site: { id: request.site.id, displayName: request.site.displayName },
    operation: request.operation,
    query: request.query || undefined,
    sourceUrl: targetUrl,
    tab: normalizeTab(current),
    evidence: {
      capturedAt: new Date().toISOString(),
      sourceUrl: current?.url || targetUrl,
      title: current?.title || '',
      snapshot: text,
      truncated: text.length >= MAX_SNAPSHOT_CHARS,
    },
  };
}

function resolveSiteCapability(value, sourceUrl) {
  const requested = String(value || '').trim().toLowerCase();
  const aliases = { xhs: 'xiaohongshu', redbook: 'xiaohongshu', '小红书': 'xiaohongshu', dy: 'douyin', yt: 'youtube' };
  const id = aliases[requested] || requested || inferSiteId(sourceUrl);
  const spec = SITE_CAPABILITY_SPECS[id];
  if (!spec) throw new Error('research.run requires supported site: xiaohongshu, douyin, or youtube');
  if (sourceUrl && !urlMatchesSite(sourceUrl, spec)) throw new Error(`URL does not belong to ${spec.displayName}`);
  return spec;
}

function inferSiteId(sourceUrl) {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    return Object.values(SITE_CAPABILITY_SPECS).find((spec) => spec.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)))?.id || '';
  } catch {
    return '';
  }
}

function urlMatchesSite(url, spec) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return spec.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
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
