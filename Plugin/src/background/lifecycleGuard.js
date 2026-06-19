export const PENDING_UPDATE_VERSION_KEY = 'xwowBrowserDataAiPendingUpdateVersion';
export const TARGET_PENDING_UPDATE_VERSION_KEY = 'codexPendingUpdateVersion';
export const CLIENT_HEARTBEAT_ALARM = 'xwow-browser-data-ai-client-heartbeat';
export const TARGET_CLIENT_HEARTBEAT_ALARM = 'client-heartbeat-alarm';
export const EXTENSION_INSTANCE_ID_KEY = 'extensionInstanceId';
export const CLIENT_HEARTBEAT_STATE_KEY = 'xwowBrowserDataAiClientHeartbeatState';
export const TARGET_CLIENT_HEARTBEAT_STATE_KEY = 'codexClientHeartbeatState';
export const LIFECYCLE_CLEANUP_RESULT_KEY = 'xwowBrowserDataAiLifecycleCleanupResult';
export const TARGET_LIFECYCLE_CLEANUP_RESULT_KEY = 'codexLifecycleCleanupResult';
export const HEARTBEAT_TIMEOUT_MS = 3000;
export const HEARTBEAT_PERIOD_MINUTES = 0.5;
export const CLIENT_HEARTBEAT_STALE_MS = 90_000;

let pendingUpdateVersion = null;
let reloadInProgress = false;
let isBrowserControlActive = () => false;
let reloadRuntime = () => chrome.runtime.reload();
let heartbeatProbe = null;
let heartbeatFailureHandler = null;

export function configureLifecycleGuard(options = {}) {
  if (typeof options.isBrowserControlActive === 'function') isBrowserControlActive = options.isBrowserControlActive;
  if (typeof options.reloadRuntime === 'function') reloadRuntime = options.reloadRuntime;
  if (typeof options.heartbeatProbe === 'function') heartbeatProbe = options.heartbeatProbe;
  if (typeof options.onHeartbeatFailure === 'function') heartbeatFailureHandler = options.onHeartbeatFailure;
}

export function registerLifecycleUpdateListener() {
  chrome.runtime.onUpdateAvailable?.addListener((details) => {
    void handleUpdateAvailable(details).catch(() => {});
  });
}

export async function ensureLifecycleInstallState() {
  const existing = await chrome.storage.local.get(EXTENSION_INSTANCE_ID_KEY).catch(() => ({}));
  if (typeof existing?.[EXTENSION_INSTANCE_ID_KEY] === 'string' && existing[EXTENSION_INSTANCE_ID_KEY].trim()) {
    return { success: true, extensionInstanceId: existing[EXTENSION_INSTANCE_ID_KEY], created: false };
  }
  const extensionInstanceId = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `extension-instance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await chrome.storage.local.set({ [EXTENSION_INSTANCE_ID_KEY]: extensionInstanceId }).catch(() => {});
  return { success: true, extensionInstanceId, created: true };
}

export async function startClientHeartbeat() {
  await chrome.alarms.create(CLIENT_HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES }).catch(() => {});
  await chrome.alarms.create(TARGET_CLIENT_HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES }).catch(() => {});
}

export async function handleLifecycleAlarm(alarm) {
  if (alarm?.name !== CLIENT_HEARTBEAT_ALARM && alarm?.name !== TARGET_CLIENT_HEARTBEAT_ALARM) return false;
  await runClientHeartbeatCheck();
  return true;
}

export async function handleUpdateAvailable(details = {}) {
  pendingUpdateVersion = String(details.version || chrome.runtime.getManifest().version || '');
  await writePendingUpdateVersion(pendingUpdateVersion);
  await maybeReloadForPendingUpdate();
}

export async function restorePendingUpdate() {
  const storage = chrome.storage.session || chrome.storage.local;
  const result = await storage.get([PENDING_UPDATE_VERSION_KEY, TARGET_PENDING_UPDATE_VERSION_KEY]).catch(() => ({}));
  const restored = result?.[PENDING_UPDATE_VERSION_KEY] || result?.[TARGET_PENDING_UPDATE_VERSION_KEY] || '';
  if (typeof restored === 'string' && restored) pendingUpdateVersion = restored;
  await maybeReloadForPendingUpdate();
}

export async function maybeReloadForPendingUpdate() {
  if (pendingUpdateVersion === chrome.runtime.getManifest().version) {
    pendingUpdateVersion = null;
    await clearPendingUpdateVersion();
    return false;
  }
  if (!pendingUpdateVersion || reloadInProgress || isBrowserControlActive()) return false;
  reloadInProgress = true;
  await clearPendingUpdateVersion();
  reloadRuntime();
  return true;
}

export function hasPendingUpdate() {
  return Boolean(pendingUpdateVersion);
}

export async function getLifecycleStatus() {
  const storage = chrome.storage.session || chrome.storage.local;
  const [pendingState, localState, clientHeartbeat] = await Promise.all([
    storage.get([PENDING_UPDATE_VERSION_KEY, TARGET_PENDING_UPDATE_VERSION_KEY]).catch(() => ({})),
    chrome.storage.local.get(EXTENSION_INSTANCE_ID_KEY).catch(() => ({})),
    getBrowserClientHeartbeatState().catch(() => ({ success: false, heartbeat: null, fresh: null, ageMs: null, staleAfterMs: CLIENT_HEARTBEAT_STALE_MS })),
  ]);
  const pendingUpdate = String(pendingUpdateVersion || pendingState?.[PENDING_UPDATE_VERSION_KEY] || pendingState?.[TARGET_PENDING_UPDATE_VERSION_KEY] || '');
  return {
    success: true,
    pendingUpdateVersion: pendingUpdate,
    hasPendingUpdate: Boolean(pendingUpdate),
    reloadInProgress,
    browserControlActive: Boolean(isBrowserControlActive()),
    extensionInstanceId: String(localState?.[EXTENSION_INSTANCE_ID_KEY] || ''),
    storageKeys: {
      pendingUpdate: [PENDING_UPDATE_VERSION_KEY, TARGET_PENDING_UPDATE_VERSION_KEY],
      clientHeartbeat: [CLIENT_HEARTBEAT_STATE_KEY, TARGET_CLIENT_HEARTBEAT_STATE_KEY],
      cleanupResult: [LIFECYCLE_CLEANUP_RESULT_KEY, TARGET_LIFECYCLE_CLEANUP_RESULT_KEY],
      extensionInstanceId: EXTENSION_INSTANCE_ID_KEY,
    },
    heartbeatAlarms: [CLIENT_HEARTBEAT_ALARM, TARGET_CLIENT_HEARTBEAT_ALARM],
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    heartbeatPeriodMinutes: HEARTBEAT_PERIOD_MINUTES,
    clientHeartbeatStaleMs: CLIENT_HEARTBEAT_STALE_MS,
    clientHeartbeat,
    lastCleanupResult: await getLifecycleCleanupResult(),
    checkedAt: new Date().toISOString(),
  };
}

async function runClientHeartbeatCheck() {
  if (!heartbeatProbe || !heartbeatFailureHandler) return;
  let ok = false;
  let clientHeartbeat = null;
  try {
    ok = await Promise.race([
      Promise.resolve().then(() => heartbeatProbe()),
      new Promise((resolve) => setTimeout(() => resolve(false), HEARTBEAT_TIMEOUT_MS)),
    ]);
  } catch {
    ok = false;
  }
  try {
    clientHeartbeat = await getBrowserClientHeartbeatState();
    if (isBrowserControlActive() && clientHeartbeat.heartbeat && clientHeartbeat.fresh !== true) ok = false;
  } catch {
    if (isBrowserControlActive()) ok = false;
  }
  if (!ok) await heartbeatFailureHandler({ clientHeartbeat });
}

export async function recordBrowserClientHeartbeat(payload = {}) {
  const staleAfterMs = normalizePositiveInteger(payload.staleAfterMs, CLIENT_HEARTBEAT_STALE_MS);
  const receivedAtMs = Date.now();
  const heartbeat = {
    source: String(payload.source || payload.client || 'app'),
    clientId: String(payload.clientId || payload.id || ''),
    sessionId: String(payload.sessionId || ''),
    turnId: String(payload.turnId || ''),
    staleAfterMs,
    receivedAt: new Date(receivedAtMs).toISOString(),
    expiresAt: new Date(receivedAtMs + staleAfterMs).toISOString(),
  };
  await (chrome.storage.session || chrome.storage.local).set({
    [CLIENT_HEARTBEAT_STATE_KEY]: heartbeat,
    [TARGET_CLIENT_HEARTBEAT_STATE_KEY]: heartbeat,
  }).catch(() => {});
  return { success: true, heartbeat, fresh: true };
}

export async function getBrowserClientHeartbeatState() {
  const result = await (chrome.storage.session || chrome.storage.local)
    .get([CLIENT_HEARTBEAT_STATE_KEY, TARGET_CLIENT_HEARTBEAT_STATE_KEY])
    .catch(() => ({}));
  const heartbeat = result?.[CLIENT_HEARTBEAT_STATE_KEY] || result?.[TARGET_CLIENT_HEARTBEAT_STATE_KEY] || null;
  if (!heartbeat?.receivedAt) {
    return { success: true, heartbeat: null, fresh: null, ageMs: null, staleAfterMs: CLIENT_HEARTBEAT_STALE_MS };
  }
  const receivedAtMs = Date.parse(heartbeat.receivedAt);
  const ageMs = Number.isFinite(receivedAtMs) ? Math.max(0, Date.now() - receivedAtMs) : null;
  const staleAfterMs = normalizePositiveInteger(heartbeat.staleAfterMs, CLIENT_HEARTBEAT_STALE_MS);
  return {
    success: true,
    heartbeat,
    fresh: ageMs == null ? false : ageMs <= staleAfterMs,
    ageMs,
    staleAfterMs,
  };
}

export async function recordLifecycleCleanupResult(payload = {}) {
  const cleanupResult = {
    reason: String(payload.reason || 'unknown'),
    stoppedSessionCount: normalizeNonNegativeInteger(payload.stoppedSessionCount, 0),
    stoppedSessions: Array.isArray(payload.stoppedSessions) ? payload.stoppedSessions.map(normalizeStoppedSession) : [],
    detached: sanitizeJson(payload.detached || null),
    clientHeartbeat: sanitizeJson(payload.clientHeartbeat || null),
    recordedAt: new Date().toISOString(),
  };
  await (chrome.storage.session || chrome.storage.local).set({
    [LIFECYCLE_CLEANUP_RESULT_KEY]: cleanupResult,
    [TARGET_LIFECYCLE_CLEANUP_RESULT_KEY]: cleanupResult,
  }).catch(() => {});
  return { success: true, cleanupResult };
}

export async function getLifecycleCleanupResult() {
  const result = await (chrome.storage.session || chrome.storage.local)
    .get([LIFECYCLE_CLEANUP_RESULT_KEY, TARGET_LIFECYCLE_CLEANUP_RESULT_KEY])
    .catch(() => ({}));
  return result?.[LIFECYCLE_CLEANUP_RESULT_KEY] || result?.[TARGET_LIFECYCLE_CLEANUP_RESULT_KEY] || null;
}

async function writePendingUpdateVersion(version) {
  await (chrome.storage.session || chrome.storage.local).set({
    [PENDING_UPDATE_VERSION_KEY]: version,
    [TARGET_PENDING_UPDATE_VERSION_KEY]: version,
  }).catch(() => {});
}

async function clearPendingUpdateVersion() {
  await (chrome.storage.session || chrome.storage.local)
    .remove([PENDING_UPDATE_VERSION_KEY, TARGET_PENDING_UPDATE_VERSION_KEY])
    .catch(() => {});
}

function normalizePositiveInteger(value, fallback) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) return fallback;
  return normalized;
}

function normalizeNonNegativeInteger(value, fallback) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) return fallback;
  return normalized;
}

function normalizeStoppedSession(session = {}) {
  if (!session || typeof session !== 'object') return {};
  return {
    sessionId: String(session.sessionId || ''),
    currentTurnId: String(session.currentTurnId || session.turnId || ''),
    activeTabId: Number.isInteger(Number(session.activeTabId)) ? Number(session.activeTabId) : null,
    tabIds: Array.isArray(session.tabIds) ? session.tabIds.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [],
  };
}

function sanitizeJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { error: String(value) };
  }
}
