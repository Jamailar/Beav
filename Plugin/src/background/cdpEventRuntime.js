import { getStoredMap, mutateBrowserControlState } from './storage.js';

export const CDP_EVENT_LOG_KEY = 'xwowBrowserDataAiCdpEvents';
export const CDP_EVENT_LOG_LIMIT = 1_000;

export async function recordCdpEvent(source = {}, method = '', params = {}) {
  const mutation = await mutateBrowserControlState([CDP_EVENT_LOG_KEY], (maps) => {
    const events = maps[CDP_EVENT_LOG_KEY];
    const sequence = Math.max(0, ...Object.values(events).map((event) => Number(event?.sequence || 0)).filter(Number.isFinite)) + 1;
    const id = `cdp-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const event = normalizeCdpEvent({
      id,
      sequence,
      source,
      method,
      params,
      receivedAt: new Date().toISOString(),
    });
    events[id] = event;
    const retained = Object.values(events)
      .map(normalizeCdpEvent)
      .sort((a, b) => Number(b.sequence || 0) - Number(a.sequence || 0))
      .slice(0, CDP_EVENT_LOG_LIMIT);
    maps[CDP_EVENT_LOG_KEY] = Object.fromEntries(retained.map((item) => [item.id, item]));
    return { event };
  });
  return mutation.result.event;
}

export async function listCdpEvents(action = {}) {
  const limit = clamp(Number(action.limit || 50), 1, CDP_EVENT_LOG_LIMIT);
  const method = String(action.method || '');
  const methods = normalizeMethods(action.methods);
  const tabId = normalizePositiveInteger(action.tabId || action.tab_id);
  const targetId = String(action.targetId || action.target_id || '');
  const since = String(action.since || action.sinceReceivedAt || '');
  const afterEventId = String(action.afterEventId || '');
  const cursor = normalizeCursor(action.cursor || action.afterSequence || action.after_sequence);
  const sorted = Object.values(await getStoredMap(CDP_EVENT_LOG_KEY))
    .map(normalizeCdpEvent)
    .filter((event) => !method || event.method === method)
    .filter((event) => !methods.length || methods.includes(event.method))
    .filter((event) => !tabId || event.source.tabId === tabId)
    .filter((event) => !targetId || event.source.targetId === targetId)
    .filter((event) => !since || String(event.receivedAt || '') > since);
  const ascending = [...sorted].sort(compareCdpEventsAscending);
  const descending = [...ascending].reverse();
  const afterIndex = afterEventId ? descending.findIndex((event) => event.id === afterEventId || event.eventId === afterEventId) : -1;
  const windowed = cursor !== null
    ? ascending.filter((event) => Number(event.sequence || 0) > cursor)
    : afterIndex >= 0
      ? descending.slice(afterIndex + 1)
      : descending;
  const selected = windowed.slice(0, limit);
  const newest = descending[0] || null;
  const oldest = ascending[0] || null;
  return {
    success: true,
    filters: { method, methods, tabId: tabId || null, targetId, since, afterEventId, cursor },
    events: selected,
    hasMore: windowed.length > selected.length,
    truncated: windowed.length > selected.length,
    nextCursor: selected.length ? Number(selected[selected.length - 1].sequence || 0) : cursor,
    newestEventId: newest?.eventId || '',
    newestReceivedAt: newest?.receivedAt || '',
    oldestEventId: oldest?.eventId || '',
    oldestReceivedAt: oldest?.receivedAt || '',
    retainedLimit: CDP_EVENT_LOG_LIMIT,
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
    sequence: Number.isInteger(Number(event.sequence)) && Number(event.sequence) > 0 ? Number(event.sequence) : 0,
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

function normalizeMethods(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 50);
}

function normalizeCursor(value) {
  if (value == null || value === '') return null;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error('cdp.events cursor must be a non-negative integer');
  return cursor;
}

function compareCdpEventsAscending(left, right) {
  const sequenceDiff = Number(left.sequence || 0) - Number(right.sequence || 0);
  if (sequenceDiff) return sequenceDiff;
  return String(left.receivedAt || '').localeCompare(String(right.receivedAt || '')) || String(left.id || '').localeCompare(String(right.id || ''));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
