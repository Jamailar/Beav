import { getStoredMap, setStoredMap } from './storage.js';

export const DOWNLOAD_EVENT_LOG_KEY = 'xwowBrowserDataAiDownloadEvents';
export const DOWNLOAD_STATE_KEY = 'xwowBrowserDataAiDownloadState';
export const DOWNLOAD_WAIT_EVENT_KINDS = ['wait.started', 'wait.complete', 'wait.failed', 'wait.canceled', 'wait.timeout'];

const downloadChangeListeners = new Set();
let downloadEventWriteQueue = Promise.resolve();
let downloadStateWriteQueue = Promise.resolve();

export function addDownloadChangeListener(listener) {
  if (typeof listener !== 'function') return () => {};
  downloadChangeListeners.add(listener);
  return () => downloadChangeListeners.delete(listener);
}

export async function handleDownloadCreated(download, options = {}) {
  if (!Number.isInteger(download?.id)) return null;
  const event = await recordDownloadEvent('created', download.id, {
    download,
    targetTracked: options.browserControlActive === true && typeof download.filename === 'string',
  });
  notifyDownloadChangeListeners(buildTargetDownloadChangeEvent(event), {
    browserControlActive: options.browserControlActive,
    targetOnly: true,
  });
  return event;
}

export async function handleDownloadChanged(delta, options = {}) {
  if (!Number.isInteger(delta?.id)) return null;
  const [download] = await chrome.downloads.search({ id: delta.id }).catch(() => []);
  const event = await recordDownloadEvent('changed', delta.id, { delta, download: download || null });
  notifyDownloadChangeListeners(buildTargetDownloadChangeEvent(event), {
    browserControlActive: options.browserControlActive,
  });
  return event;
}

export async function waitForDownload(options = {}) {
  const timeoutMs = Number(options.timeoutMs || options.timeout_ms || 30_000);
  const targetDownloadId = normalizeDownloadId(options.downloadId ?? options.download_id);
  const startedAt = Date.now();
  const waitId = `download-wait-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const artifactBinding = buildDownloadArtifactBinding(options);
  const downloadContext = buildDownloadContext(options, artifactBinding);
  await recordDownloadLifecycleEvent('wait.started', {
    waitId,
    timeoutMs,
    filters: describeDownloadWaitFilters(options),
    artifactBindingSchemaVersion: 1,
    artifactBinding,
    downloadContext,
  });
  const existing = await chrome.downloads.search(targetDownloadId != null ? { id: targetDownloadId } : {});
  const terminalExisting = existing.find((item) => matchesDownload(item, options) && isTerminalDownloadState(item.state));
  if (terminalExisting) {
    const status = normalizeWaitDownloadStatus(terminalExisting);
    const cleanupResult = status === 'complete'
      ? null
      : await cleanupFailedDownload(terminalExisting.id, {
        cancel: false,
        removeFile: options.removeFileOnFailure === true,
      });
    const payload = withTargetDownloadWaitFields({
      success: status === 'complete',
      status,
      download: terminalExisting,
      cleanup: cleanupResult,
    });
    await recordDownloadLifecycleEvent(`wait.${status}`, {
      waitId,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      downloadId: terminalExisting.id,
      download_id: String(terminalExisting.id),
      path: payload.path,
      status,
      success: payload.success === true,
      error: payload.error || '',
      artifactBindingSchemaVersion: 1,
      artifactBinding,
      downloadContext,
    });
    if (shouldPersistDownloadContext(downloadContext)) {
      await updateDownloadContext(terminalExisting.id, downloadContext);
    }
    return { ...payload, waitId };
  }
  const trackedIds = new Set(existing.filter((item) => item.state === 'in_progress' && matchesDownload(item, options)).map((item) => item.id));
  return await new Promise((resolve) => {
    let timer = null;
    let finished = false;
    const cleanup = () => {
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (timer) clearTimeout(timer);
    };
    const finish = async (payload) => {
      if (finished) return;
      finished = true;
      cleanup();
      const status = String(payload.status || (payload.error === 'download_timeout' ? 'timeout' : 'unknown'));
      const cleanupDownloadId = Number.isInteger(payload.download?.id)
        ? payload.download.id
        : targetDownloadId;
      let download = payload.download || null;
      let cleanupResult = null;
      if (Number.isInteger(cleanupDownloadId) && status !== 'complete') {
        const [observed] = await chrome.downloads.search({ id: cleanupDownloadId }).catch(() => []);
        download ||= observed || null;
        cleanupResult = await cleanupFailedDownload(cleanupDownloadId, {
          cancel: status === 'timeout' && options.cancelOnTimeout === true,
          removeFile: options.removeFileOnFailure === true,
        });
      }
      await recordDownloadLifecycleEvent(`wait.${status}`, {
        waitId,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
        downloadId: Number.isInteger(cleanupDownloadId) ? cleanupDownloadId : null,
        download_id: Number.isInteger(cleanupDownloadId) ? String(cleanupDownloadId) : '',
        path: download?.filename || null,
        status,
        success: payload.success === true,
        error: payload.error || '',
        cleanup: cleanupResult,
        artifactBindingSchemaVersion: 1,
        artifactBinding,
        downloadContext,
      });
      if (Number.isInteger(cleanupDownloadId) && shouldPersistDownloadContext(downloadContext)) {
        await updateDownloadContext(cleanupDownloadId, downloadContext);
      }
      resolve(withTargetDownloadWaitFields({
        ...payload,
        download,
        cleanup: cleanupResult,
        waitId,
      }));
    };
    const onCreated = (download) => {
      if (!matchesDownload(download, options)) return;
      trackedIds.add(download.id);
      if (download.state === 'complete') {
        void finish({ success: true, status: 'complete', download });
      }
    };
    const onChanged = async (delta) => {
      if (!delta.state?.current) return;
      const [download] = await chrome.downloads.search({ id: delta.id }).catch(() => []);
      if (!trackedIds.has(delta.id)) {
        if (!download || !matchesDownload(download, options)) return;
        trackedIds.add(delta.id);
      }
      const status = delta.state.current === 'interrupted'
        ? (delta.error?.current === 'USER_CANCELED' ? 'canceled' : 'failed')
        : delta.state.current;
      if (status === 'complete' || status === 'failed' || status === 'canceled') {
        void finish({ success: status === 'complete', status, download });
      }
    };
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => {
      void finish({ success: false, status: 'timeout', error: 'download_timeout', elapsedMs: Date.now() - startedAt });
    }, timeoutMs);
  });
}

async function cleanupFailedDownload(downloadId, options = {}) {
  const result = {
    cancelRequested: options.cancel === true,
    canceled: false,
    removeFileRequested: options.removeFile === true,
    fileRemoved: false,
    historyErased: false,
  };
  if (options.cancel === true) {
    result.canceled = await chrome.downloads.cancel(downloadId).then(() => true).catch(() => false);
  }
  if (options.removeFile === true) {
    result.fileRemoved = await chrome.downloads.removeFile(downloadId).then(() => true).catch(() => false);
    result.historyErased = await chrome.downloads.erase({ id: downloadId })
      .then((ids) => Array.isArray(ids) && ids.includes(downloadId))
      .catch(() => false);
  }
  return result;
}

export async function listDownloadEvents(action = {}) {
  const events = Object.values(await getStoredMap(DOWNLOAD_EVENT_LOG_KEY));
  const state = await getDownloadState();
  const limit = clamp(Number(action.limit || 50), 1, 200);
  return {
    success: true,
    state,
    events: events
      .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
      .slice(0, limit),
  };
}

export async function searchDownloads(action = {}) {
  const query = {};
  if (action.id != null) query.id = Number(action.id);
  if (action.filenameRegex) query.filenameRegex = String(action.filenameRegex);
  if (action.urlRegex) query.urlRegex = String(action.urlRegex);
  if (action.state) query.state = String(action.state);
  if (action.startedAfter) query.startedAfter = String(action.startedAfter);
  if (action.startedBefore) query.startedBefore = String(action.startedBefore);
  if (action.endedAfter) query.endedAfter = String(action.endedAfter);
  if (action.endedBefore) query.endedBefore = String(action.endedBefore);
  if (action.limit) query.limit = clamp(Number(action.limit), 1, 1000);
  const downloads = await chrome.downloads.search(query);
  return {
    success: true,
    downloads: downloads.map((download) => ({
      id: download.id,
      url: download.url || '',
      finalUrl: download.finalUrl || '',
      filename: download.filename || '',
      mime: download.mime || '',
      state: download.state || '',
      danger: download.danger || '',
      paused: Boolean(download.paused),
      totalBytes: download.totalBytes || 0,
      bytesReceived: download.bytesReceived || 0,
      startTime: download.startTime || '',
      endTime: download.endTime || '',
      exists: download.exists,
    })),
  };
}

export async function recordDownloadEvent(kind, downloadId, payload = {}) {
  const state = await updateDownloadState(kind, downloadId, payload);
  const id = `download-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const normalizedId = Number(downloadId);
  const key = String(normalizedId);
  const event = {
    id,
    kind,
    downloadId: normalizedId,
    url: state.downloadUrlsById[key] || '',
    filename: state.downloadFilenamesById[key] || '',
    status: state.downloadStatusesById[key] || '',
    targetTracked: state.targetDownloadTrackedById[key] === true,
    artifactBindingSchemaVersion: state.downloadContextsById[key] ? 1 : undefined,
    artifactBinding: state.downloadContextsById[key]?.artifactBinding || undefined,
    downloadContext: state.downloadContextsById[key] || undefined,
    ...payload,
    receivedAt: new Date().toISOString(),
  };
  return await appendDownloadEvent(event);
}

export async function recordDownloadLifecycleEvent(kind, payload = {}) {
  const id = `download-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const event = {
    id,
    kind,
    downloadId: Number.isInteger(payload.downloadId) ? payload.downloadId : null,
    url: '',
    filename: '',
    status: payload.status || '',
    ...payload,
    receivedAt: new Date().toISOString(),
  };
  await appendDownloadEvent(event);
  notifyDownloadChangeListeners(event);
  return event;
}

async function appendDownloadEvent(event) {
  downloadEventWriteQueue = downloadEventWriteQueue
    .catch(() => {})
    .then(async () => {
      const events = await getStoredMap(DOWNLOAD_EVENT_LOG_KEY);
      events[event.id] = event;
      const sorted = Object.values(events).sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || ''))).slice(0, 200);
      await setStoredMap(DOWNLOAD_EVENT_LOG_KEY, Object.fromEntries(sorted.map((item) => [item.id, item])));
      return event;
    });
  return await downloadEventWriteQueue;
}

function notifyDownloadChangeListeners(event, options = {}) {
  if (!event || !downloadChangeListeners.size) return;
  if (options.targetOnly && options.browserControlActive !== true) return;
  for (const listener of downloadChangeListeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[XWOW BrowserDataAI] download change listener failed', error);
    }
  }
}

export async function getDownloadState() {
  return normalizeDownloadState(await getStoredMap(DOWNLOAD_STATE_KEY));
}

async function updateDownloadState(kind, downloadId, payload = {}) {
  downloadStateWriteQueue = downloadStateWriteQueue
    .catch(() => {})
    .then(async () => {
      const id = Number(downloadId);
      const key = String(id);
      const state = await getDownloadState();
      if (!Number.isInteger(id)) return state;
      const download = payload.download || null;
      const delta = payload.delta || null;
      const url = download?.finalUrl || download?.url || state.downloadUrlsById[key] || '';
      const filename = readCurrent(delta?.filename) || download?.filename || state.downloadFilenamesById[key] || '';
      const status = normalizeDownloadStatus(delta, download, kind, state.downloadStatusesById[key] || '');
      if (url) state.downloadUrlsById[key] = url;
      if (filename) state.downloadFilenamesById[key] = filename;
      if (status) state.downloadStatusesById[key] = status;
      if (payload.targetTracked === true) state.targetDownloadTrackedById[key] = true;
      state.updatedAt = new Date().toISOString();
      await setStoredMap(DOWNLOAD_STATE_KEY, state);
      return state;
    });
  return await downloadStateWriteQueue;
}

function normalizeDownloadState(value = {}) {
  return {
    downloadFilenamesById: normalizeStringMap(value.downloadFilenamesById),
    downloadUrlsById: normalizeStringMap(value.downloadUrlsById),
    downloadStatusesById: normalizeStringMap(value.downloadStatusesById),
    targetDownloadTrackedById: normalizeBooleanMap(value.targetDownloadTrackedById),
    downloadContextsById: normalizeDownloadContextMap(value.downloadContextsById),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function normalizeStringMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => key && typeof item === 'string'));
}

function normalizeBooleanMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => key && item === true));
}

async function updateDownloadContext(downloadId, context = {}) {
  downloadStateWriteQueue = downloadStateWriteQueue
    .catch(() => {})
    .then(async () => {
      const id = Number(downloadId);
      if (!Number.isInteger(id) || !context || typeof context !== 'object') return await getDownloadState();
      const state = await getDownloadState();
      state.downloadContextsById[String(id)] = normalizeDownloadContext(context);
      state.updatedAt = new Date().toISOString();
      await setStoredMap(DOWNLOAD_STATE_KEY, state);
      return state;
    });
  return await downloadStateWriteQueue;
}

function normalizeDownloadContextMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || !item || typeof item !== 'object' || Array.isArray(item)) continue;
    out[key] = normalizeDownloadContext(item);
  }
  return out;
}

function buildDownloadArtifactBinding(options = {}) {
  const binding = options.artifactBinding || options.binding || {};
  const metadata = options.jobMetadata || {};
  return {
    sessionId: String(options.sessionId || binding.sessionId || ''),
    turnId: String(options.turnId || binding.turnId || ''),
    jobId: String(options.jobId || binding.jobId || metadata.jobId || metadata.job_id || ''),
    storeId: String(options.storeId || binding.storeId || metadata.storeId || metadata.store_id || ''),
    pageRole: String(options.pageRole || binding.pageRole || ''),
    source: String(options.source || binding.source || 'browser_download'),
  };
}

function buildDownloadContext(options = {}, artifactBinding = {}) {
  return normalizeDownloadContext({
    artifactBinding,
    sessionId: artifactBinding.sessionId,
    turnId: artifactBinding.turnId,
    jobId: artifactBinding.jobId,
    storeId: artifactBinding.storeId,
    pageRole: artifactBinding.pageRole,
    source: artifactBinding.source,
  });
}

function normalizeDownloadContext(context = {}) {
  const binding = context.artifactBinding || {};
  const artifactBinding = {
    sessionId: String(binding.sessionId || context.sessionId || ''),
    turnId: String(binding.turnId || context.turnId || ''),
    jobId: String(binding.jobId || context.jobId || ''),
    storeId: String(binding.storeId || context.storeId || ''),
    pageRole: String(binding.pageRole || context.pageRole || ''),
    source: String(binding.source || context.source || 'browser_download'),
  };
  return {
    artifactBinding,
    sessionId: artifactBinding.sessionId,
    turnId: artifactBinding.turnId,
    jobId: artifactBinding.jobId,
    storeId: artifactBinding.storeId,
    pageRole: artifactBinding.pageRole,
    source: artifactBinding.source,
  };
}

function shouldPersistDownloadContext(context = {}) {
  return Boolean(context.jobId || context.storeId || context.pageRole || (context.source && context.source !== 'browser_download'));
}

function readCurrent(change = null) {
  return typeof change?.current === 'string' ? change.current : '';
}

function normalizeDownloadStatus(delta = null, download = null, kind = '', previous = '') {
  const state = readCurrent(delta?.state) || download?.state || '';
  if (state === 'interrupted') return readCurrent(delta?.error) === 'USER_CANCELED' ? 'canceled' : 'failed';
  if (state) return state;
  if (kind === 'created') return download?.state || 'created';
  return previous;
}

function buildTargetDownloadChangeEvent(event = {}) {
  const downloadId = Number(event.downloadId);
  if (!Number.isInteger(downloadId)) return null;
  const status = normalizeTargetDownloadChangeStatus(event);
  if (!status) return null;
  if (event.targetTracked !== true) return null;
  const filename = event.filename || event.download?.filename || readCurrent(event.delta?.filename) || '';
  const url = event.url || event.download?.finalUrl || event.download?.url || '';
  if (event.kind === 'created' && typeof event.download?.filename !== 'string') return null;
  if (event.kind !== 'created' && (!filename || !url)) return null;
  return {
    id: String(downloadId),
    downloadId,
    filename,
    url,
    status,
    targetTracked: true,
    kind: event.kind,
    receivedAt: event.receivedAt || new Date().toISOString(),
  };
}

function normalizeTargetDownloadChangeStatus(event = {}) {
  if (event.kind === 'created') return 'started';
  if (event.kind !== 'changed') return '';
  const state = readCurrent(event.delta?.state) || event.download?.state || event.status || '';
  if (state === 'complete') return 'complete';
  if (state === 'interrupted' || event.status === 'failed' || event.status === 'canceled') {
    return readCurrent(event.delta?.error) === 'USER_CANCELED' || event.status === 'canceled' ? 'canceled' : 'failed';
  }
  return '';
}

function normalizeDownloadId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function isTerminalDownloadState(state) {
  return state === 'complete' || state === 'interrupted';
}

function normalizeWaitDownloadStatus(download = {}) {
  if (download.state === 'complete') return 'complete';
  if (download.state === 'interrupted') return download.error === 'USER_CANCELED' ? 'canceled' : 'failed';
  return download.state || 'unknown';
}

function withTargetDownloadWaitFields(payload = {}) {
  const downloadId = Number.isInteger(payload.download?.id) ? payload.download.id : null;
  return {
    ...payload,
    downloadId,
    download_id: downloadId != null ? String(downloadId) : '',
    path: payload.download?.filename || null,
  };
}

function matchesDownload(download, options = {}) {
  if (!download) return false;
  const targetDownloadId = normalizeDownloadId(options.downloadId ?? options.download_id);
  if (targetDownloadId != null && download.id !== targetDownloadId) return false;
  const needle = String(options.urlContains || options.filenameContains || '');
  if (!needle) return true;
  const haystack = [
    download.finalUrl,
    download.url,
    download.filename,
    download.mime,
  ].filter(Boolean).join(' ');
  return haystack.includes(needle);
}

function describeDownloadWaitFilters(options = {}) {
  return {
    download_id: normalizeDownloadId(options.downloadId ?? options.download_id) != null ? String(normalizeDownloadId(options.downloadId ?? options.download_id)) : '',
    urlContains: typeof options.urlContains === 'string' ? options.urlContains : '',
    filenameContains: typeof options.filenameContains === 'string' ? options.filenameContains : '',
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
