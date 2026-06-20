import { getStoredMap, setStoredMap } from './storage.js';

export const CDP_EVENT_LOG_KEY = 'xwowBrowserDataAiCdpEvents';
export const CDP_EVENT_LOG_LIMIT = 200;

export async function recordCdpEvent(source = {}, method = '', params = {}) {
  const events = await getStoredMap(CDP_EVENT_LOG_KEY);
  const id = `cdp-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const event = normalizeCdpEvent({
    id,
    source,
    method,
    params,
    receivedAt: new Date().toISOString(),
  });
  events[id] = event;
  const sorted = Object.values(events)
    .map(normalizeCdpEvent)
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
    .slice(0, CDP_EVENT_LOG_LIMIT);
  await setStoredMap(CDP_EVENT_LOG_KEY, Object.fromEntries(sorted.map((item) => [item.id, item])));
  return event;
}

export async function listCdpEvents(action = {}) {
  const limit = clamp(Number(action.limit || 50), 1, CDP_EVENT_LOG_LIMIT);
  const method = String(action.method || '');
  const tabId = normalizePositiveInteger(action.tabId || action.tab_id);
  const targetId = String(action.targetId || action.target_id || '');
  const since = String(action.since || action.sinceReceivedAt || '');
  const afterEventId = String(action.afterEventId || '');
  const sorted = Object.values(await getStoredMap(CDP_EVENT_LOG_KEY))
    .map(normalizeCdpEvent)
    .filter((event) => !method || event.method === method)
    .filter((event) => !tabId || event.source.tabId === tabId)
    .filter((event) => !targetId || event.source.targetId === targetId)
    .filter((event) => !since || String(event.receivedAt || '') > since)
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')));
  const afterIndex = afterEventId ? sorted.findIndex((event) => event.id === afterEventId || event.eventId === afterEventId) : -1;
  const windowed = afterIndex >= 0 ? sorted.slice(afterIndex + 1) : sorted;
  const selected = windowed.slice(0, limit);
  return {
    success: true,
    filters: { method, tabId: tabId || null, targetId, since, afterEventId },
    events: selected,
    hasMore: windowed.length > selected.length,
    newestEventId: sorted[0]?.eventId || '',
    newestReceivedAt: sorted[0]?.receivedAt || '',
  };
}

export async function summarizeCdpEvents(action = {}) {
  const replay = await listCdpEvents({ ...action, limit: CDP_EVENT_LOG_LIMIT });
  const events = replay.events || [];
  const byMethod = {};
  const bySource = {};
  for (const event of events) {
    addSummaryBucket(byMethod, event.method || 'unknown', event);
    addSummaryBucket(bySource, sourceKey(event.source), event);
  }
  const newestEventId = replay.newestEventId || events[0]?.eventId || '';
  const newestReceivedAt = replay.newestReceivedAt || events[0]?.receivedAt || '';
  const oldestEventId = events[events.length - 1]?.eventId || '';
  const oldestReceivedAt = events[events.length - 1]?.receivedAt || '';
  return {
    success: true,
    filters: replay.filters,
    total: events.length,
    hasMore: replay.hasMore === true,
    newestEventId,
    newestReceivedAt,
    oldestEventId,
    oldestReceivedAt,
    byMethod,
    bySource,
    checkpoint: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      total: events.length,
      hasMore: replay.hasMore === true,
      newestEventId,
      newestReceivedAt,
      oldestEventId,
      oldestReceivedAt,
      latestByMethod: buildCheckpointIndex(byMethod),
      latestBySource: buildCheckpointIndex(bySource),
      nextQuery: {
        afterEventId: newestEventId,
        since: newestReceivedAt,
      },
    },
  };
}

function normalizeCdpEvent(event = {}) {
  const id = String(event.id || event.eventId || `cdp-event-${Date.now().toString(36)}`);
  const source = normalizeDebuggerSource(event.source || {});
  return {
    ...event,
    id,
    eventId: event.eventId || `cdp:${id}`,
    eventType: 'cdp',
    source,
    method: String(event.method || ''),
    params: event.params && typeof event.params === 'object' ? event.params : {},
    receivedAt: String(event.receivedAt || event.emittedAt || ''),
  };
}

function normalizeDebuggerSource(source = {}) {
  return {
    tabId: Number.isInteger(Number(source.tabId)) ? Number(source.tabId) : null,
    targetId: typeof source.targetId === 'string' ? source.targetId : '',
    extensionId: typeof source.extensionId === 'string' ? source.extensionId : '',
  };
}

function addSummaryBucket(target, key, event) {
  const bucketKey = String(key || 'unknown');
  const bucket = target[bucketKey] || {
    count: 0,
    latestEventId: '',
    latestReceivedAt: '',
    latestMethod: '',
  };
  bucket.count += 1;
  if (!bucket.latestEventId) {
    bucket.latestEventId = event.eventId || '';
    bucket.latestReceivedAt = event.receivedAt || '';
    bucket.latestMethod = event.method || '';
  }
  target[bucketKey] = bucket;
}

function buildCheckpointIndex(summary = {}) {
  return Object.fromEntries(Object.entries(summary).map(([key, bucket]) => [key, {
    count: Number(bucket?.count || 0),
    latestEventId: bucket?.latestEventId || '',
    latestReceivedAt: bucket?.latestReceivedAt || '',
    latestMethod: bucket?.latestMethod || '',
  }]));
}

function sourceKey(source = {}) {
  if (source.targetId) return `target:${source.targetId}`;
  if (Number.isInteger(source.tabId)) return `tab:${source.tabId}`;
  if (source.extensionId) return `extension:${source.extensionId}`;
  return 'unknown';
}

function normalizePositiveInteger(value) {
  const normalized = Number(value || 0);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
