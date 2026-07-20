export const NATIVE_RECONNECT_ALARM = 'redbox-browser-control-native-reconnect';
export const TARGET_NATIVE_RECONNECT_ALARM_PREFIX = 'native-transport-reconnect';
export const NATIVE_STATUS_KEY = 'redboxBrowserControlNativeHostStatus';
export const NATIVE_HOST_STATUS_KEY = 'NATIVE_HOST_STATUS';
export const NATIVE_HOST_DEFAULT = 'com.redbox.browser_control';
export const TARGET_NATIVE_DISCONNECTED_ERROR = 'Native transport is disconnected; reconnect is pending';
export const TARGET_NATIVE_INVALID_RESPONSE_ERROR = 'Native host returned an invalid response';
export const TARGET_NATIVE_RESPONSE_HANDLING = 'pending_id_then_error_or_result_else_invalid_response';
export const XWOW_NATIVE_RESPONSE_VALIDATION = 'strict_jsonrpc_expected_id_exactly_one_result_or_error';
export const NATIVE_RECONNECT_DELAY_MS = 5000;
export const NATIVE_RECONNECT_PERIOD_MINUTES = NATIVE_RECONNECT_DELAY_MS / 60_000;
export const NATIVE_TELEMETRY_LIMIT = 50;
export const NATIVE_HANDSHAKE_TIMEOUT_MS = 3000;

let nativePort = null;
let nativeRequestSeq = 0;
let nativeReconnectAttempt = 0;
let nativeReconnectPending = false;
let nativeReconnectTimeoutId = null;
let onNativeMessage = null;
let onStatusChange = null;
let onTelemetry = null;
let getNativeRegistration = null;
const pendingNativeRequests = new Map();
const nativeTelemetry = [];

let nativeStatus = {
  state: 'disconnected',
  hostName: NATIVE_HOST_DEFAULT,
  lastChecked: Date.now(),
  reconnectAttempt: 0,
  telemetry: [],
};

export function configureNativeTransport(options = {}) {
  if (typeof options.onMessage === 'function') onNativeMessage = options.onMessage;
  if (typeof options.onStatusChange === 'function') onStatusChange = options.onStatusChange;
  if (typeof options.onTelemetry === 'function') onTelemetry = options.onTelemetry;
  if (typeof options.getRegistration === 'function') getNativeRegistration = options.getRegistration;
}

export function getNativeStatus() {
  return { ...nativeStatus, telemetry: nativeTelemetry.slice(-20) };
}

export function refreshNativeStatus() {
  const previousState = nativeStatus.state;
  nativeStatus = {
    ...nativeStatus,
    state: nativePort ? 'connected' : nativeStatus.state,
    lastChecked: Date.now(),
    reconnectAttempt: nativeReconnectAttempt,
    telemetry: nativeTelemetry.slice(-20),
  };
  void persistNativeStatus().catch(() => {});
  onStatusChange?.(getNativeStatus());
  recordNativeTelemetry('status_refreshed', { state: nativeStatus.state, previousState });
  return getNativeStatus();
}

export function getNativeTelemetry() {
  return nativeTelemetry.slice();
}

export async function restoreNativeStatus() {
  const stored = await chrome.storage.local.get(NATIVE_STATUS_KEY).catch(() => ({}));
  const targetStored = await chrome.storage.local.get(NATIVE_HOST_STATUS_KEY).catch(() => ({}));
  const storedStatus = stored?.[NATIVE_STATUS_KEY] || targetStored?.[NATIVE_HOST_STATUS_KEY];
  if (storedStatus) {
    nativeStatus = {
      ...nativeStatus,
      ...storedStatus,
      state: 'disconnected',
      lastChecked: Date.now(),
    };
  }
  recordNativeTelemetry('status_restored', { state: nativeStatus.state, hostName: nativeStatus.hostName });
  return await setNativeStatus(nativeStatus.state, { error: nativeStatus.error, hostName: nativeStatus.hostName });
}

export async function connectNativeTransport(options = {}) {
  const hostName = options.hostName || nativeStatus.hostName || NATIVE_HOST_DEFAULT;
  if (nativePort && !options.force) {
    recordNativeTelemetry('connect_reused', { hostName });
    return getNativeStatus();
  }
  if (nativePort) await disconnectNativeTransport('reconnect');
  recordNativeTelemetry('connect_started', { hostName, force: options.force === true, silent: options.silent === true });
  try {
    nativePort = chrome.runtime.connectNative(hostName);
  } catch (error) {
    recordNativeTelemetry('connect_failed', { hostName, error: describeError(error) });
    await setNativeStatus(options.silent ? 'reconnecting' : 'disconnected', { hostName, error: describeError(error), nextRetryMs: NATIVE_RECONNECT_DELAY_MS });
    if (!options.silent) throw error;
    return getNativeStatus();
  }
  nativePort.onMessage.addListener((message) => {
    if (handleNativeResponse(message)) return;
    if (onNativeMessage) {
      void Promise.resolve(onNativeMessage(message)).catch((error) => {
        void sendNativeNotification('error', { error: describeError(error) }).catch(() => {});
      });
    }
  });
  const connectedPort = nativePort;
  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || 'Native host disconnected';
    if (nativePort === connectedPort) nativePort = null;
    rejectPendingNativeRequests(new Error(error));
    recordNativeTelemetry('disconnected', { hostName, error });
    void setNativeStatus('disconnected', { hostName, error }).then(() => scheduleNativeReconnect()).catch(() => {});
  });
  let handshake;
  try {
    handshake = await requestNativeHost('ping', {}, NATIVE_HANDSHAKE_TIMEOUT_MS);
    if (!handshake || handshake.ok !== true) {
      throw new Error('Native host handshake returned an invalid response');
    }
  } catch (error) {
    if (nativePort === connectedPort) {
      nativePort = null;
      try {
        connectedPort.disconnect();
      } catch {}
    }
    rejectPendingNativeRequests(error);
    recordNativeTelemetry('connect_failed', { hostName, error: describeError(error), phase: 'handshake' });
    await setNativeStatus(options.silent ? 'reconnecting' : 'disconnected', {
      hostName,
      error: describeError(error),
      nextRetryMs: NATIVE_RECONNECT_DELAY_MS,
    });
    await scheduleNativeReconnect();
    if (!options.silent) throw error;
    return getNativeStatus();
  }
  let registration = null;
  let registrationSucceeded = false;
  if (getNativeRegistration) {
    try {
      registration = sanitizeNativeRegistration(await getNativeRegistration());
      if (registration) {
        await requestNativeHost('extension.register', registration, NATIVE_HANDSHAKE_TIMEOUT_MS);
        registrationSucceeded = true;
        recordNativeTelemetry('registration_succeeded', {
          hostName,
          extensionInstanceId: registration.extensionInstanceId,
          extensionVersion: registration.version,
          browser: registration.browser,
        });
      }
    } catch (error) {
      recordNativeTelemetry('registration_failed', {
        hostName,
        error: describeError(error),
        backwardCompatible: true,
      });
    }
  }
  nativeReconnectAttempt = 0;
  nativeReconnectPending = false;
  clearNativeReconnectTimeout();
  recordNativeTelemetry('connected', { hostName, handshake: true, registered: registrationSucceeded });
  await setNativeStatus('connected', {
    hostName,
    error: '',
    handshake,
    registration,
    registrationSucceeded,
  });
  await clearNativeReconnectAlarm();
  return getNativeStatus();
}

export async function disconnectNativeTransport(reason = 'disconnect') {
  recordNativeTelemetry('disconnect_requested', { reason, connected: Boolean(nativePort) });
  if (nativePort) {
    try {
      nativePort.disconnect();
    } catch {}
  }
  nativePort = null;
  nativeReconnectPending = false;
  clearNativeReconnectTimeout();
  rejectPendingNativeRequests(new Error(`Native host ${reason}`));
  recordNativeTelemetry('disconnected', { reason });
  return await setNativeStatus('disconnected', { error: reason });
}

export async function requestNativeHost(method, params = {}, timeoutMs = 12_000) {
  if (!nativePort) {
    await scheduleNativeReconnect();
    throw new Error(TARGET_NATIVE_DISCONNECTED_ERROR);
  }
  nativeRequestSeq += 1;
  const id = `native-host:${nativeRequestSeq}`;
  const message = buildNativeRequestEnvelope(method, params, { id });
  recordNativeTelemetry('request_started', {
    id,
    method: message.method,
    timeoutMs: Number(timeoutMs || 12_000),
    paramKeys: Object.keys(params || {}).slice(0, 20),
  });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingNativeRequests.delete(id);
      recordNativeTelemetry('request_timeout', { id, method: message.method, timeoutMs: Number(timeoutMs || 12_000) });
      reject(new Error(`native_request_timeout: ${method}`));
    }, Number(timeoutMs || 12_000));
    pendingNativeRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        recordNativeTelemetry('request_succeeded', { id, method: message.method });
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        recordNativeTelemetry('request_failed', { id, method: message.method, error: describeError(error) });
        reject(error);
      },
    });
    try {
      nativePort.postMessage(message);
    } catch (error) {
      pendingNativeRequests.delete(id);
      clearTimeout(timer);
      recordNativeTelemetry('request_failed', { id, method: message.method, error: describeError(error) });
      reject(error);
    }
  });
}

export async function sendNativeNotification(method, params = {}) {
  return postNativeMessage(buildNativeNotificationEnvelope(method, params));
}

export function postNativeMessage(message) {
  if (!nativePort) return false;
  nativePort.postMessage(message);
  return true;
}

export async function handleNativeReconnectAlarm(alarm, options = {}) {
  if (alarm?.name !== NATIVE_RECONNECT_ALARM && !isTargetNativeReconnectAlarm(alarm?.name)) return false;
  await runNativeReconnectAttempt(options.hostName).catch(() => {});
  return true;
}

export function handleNativeResponse(message) {
  if (!(message && typeof message === 'object' && 'id' in message)) return false;
  const id = String(message.id);
  const pending = pendingNativeRequests.get(id);
  if (!pending) return false;
  pendingNativeRequests.delete(id);
  let response;
  try {
    response = validateNativeResponseEnvelope(message, id);
  } catch (error) {
    pending.reject(error);
    return true;
  }
  if (response.error) pending.reject(nativeResponseError(response.error));
  else pending.resolve(response.result);
  return true;
}

export function buildNativeRequestEnvelope(method, params = {}, options = {}) {
  const name = validateNativeMethod(method, 'native request');
  validateNativeParams(params, name);
  const id = String(options.id || '');
  if (!id) throw new Error(`native request ${name} requires id`);
  return {
    jsonrpc: '2.0',
    id,
    method: name,
    params,
  };
}

export function buildNativeNotificationEnvelope(method, params = {}) {
  const name = validateNativeMethod(method, 'native notification');
  validateNativeParams(params, name);
  return {
    jsonrpc: '2.0',
    method: name,
    params,
  };
}

export function validateNativeResponseEnvelope(message = {}, expectedId = '') {
  if (!message || typeof message !== 'object') throw new Error('native response must be an object');
  if (message.jsonrpc != null && message.jsonrpc !== '2.0') throw new Error('native response jsonrpc must be 2.0');
  const id = String(message.id || '');
  if (!id) throw new Error('native response requires id');
  if (expectedId && id !== String(expectedId)) throw new Error(`native response id mismatch: ${id}`);
  const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
  if (!hasResult && !hasError) throw new Error(TARGET_NATIVE_INVALID_RESPONSE_ERROR);
  if (hasResult && hasError) throw new Error('native response requires exactly one of result or error');
  if (hasError && (!message.error || typeof message.error !== 'object')) throw new Error('native response error must be an object');
  if (hasError && typeof message.error.message !== 'string') throw new Error('native response error requires message');
  return hasError
    ? { jsonrpc: '2.0', id, error: message.error }
    : { jsonrpc: '2.0', id, result: message.result };
}

function rejectPendingNativeRequests(error) {
  for (const pending of pendingNativeRequests.values()) pending.reject(error);
  pendingNativeRequests.clear();
}

async function scheduleNativeReconnect() {
  if (nativePort) return;
  if (!nativeReconnectPending) {
    nativeReconnectPending = true;
    nativeReconnectAttempt += 1;
  }
  recordNativeTelemetry('reconnect_scheduled', {
    attempt: nativeReconnectAttempt,
    delayMs: NATIVE_RECONNECT_DELAY_MS,
  });
  await setNativeStatus('reconnecting', { nextRetryMs: NATIVE_RECONNECT_DELAY_MS }).catch(() => {});
  scheduleNativeReconnectTimeout();
  await ensureNativeReconnectAlarm();
}

async function runNativeReconnectAttempt(hostName = '') {
  if (nativePort) {
    await clearNativeReconnectAlarm();
    return getNativeStatus();
  }
  clearNativeReconnectTimeout();
  nativeReconnectPending = true;
  nativeReconnectAttempt += 1;
  recordNativeTelemetry('reconnect_attempt', { hostName: hostName || nativeStatus.hostName || NATIVE_HOST_DEFAULT });
  const status = await connectNativeTransport({ silent: true, hostName: hostName || nativeStatus.hostName || NATIVE_HOST_DEFAULT });
  if (status.state !== 'connected') {
    scheduleNativeReconnectTimeout();
    await ensureNativeReconnectAlarm();
  }
  return status;
}

function scheduleNativeReconnectTimeout() {
  if (nativePort || nativeReconnectTimeoutId != null) return;
  nativeReconnectTimeoutId = setTimeout(() => {
    nativeReconnectTimeoutId = null;
    void runNativeReconnectAttempt().catch(() => {});
  }, NATIVE_RECONNECT_DELAY_MS);
}

function clearNativeReconnectTimeout() {
  if (nativeReconnectTimeoutId == null) return;
  clearTimeout(nativeReconnectTimeoutId);
  nativeReconnectTimeoutId = null;
}

async function ensureNativeReconnectAlarm() {
  if (nativePort) return;
  const existing = await chrome.alarms.get(NATIVE_RECONNECT_ALARM).catch(() => null);
  if (!existing && !nativePort) {
    await chrome.alarms.create(NATIVE_RECONNECT_ALARM, {
      periodInMinutes: NATIVE_RECONNECT_PERIOD_MINUTES,
    }).catch(() => {});
  }
  const targetAlarmName = getTargetNativeReconnectAlarmName();
  const targetExisting = await chrome.alarms.get(targetAlarmName).catch(() => null);
  if (!targetExisting && !nativePort) {
    await chrome.alarms.create(targetAlarmName, {
      periodInMinutes: NATIVE_RECONNECT_PERIOD_MINUTES,
    }).catch(() => {});
  }
}

async function clearNativeReconnectAlarm() {
  await chrome.alarms.clear(NATIVE_RECONNECT_ALARM).catch(() => {});
  await chrome.alarms.clear(getTargetNativeReconnectAlarmName()).catch(() => {});
}

export function getTargetNativeReconnectAlarmName(hostName = nativeStatus.hostName || NATIVE_HOST_DEFAULT) {
  return `${TARGET_NATIVE_RECONNECT_ALARM_PREFIX}:${hostName || NATIVE_HOST_DEFAULT}`;
}

function isTargetNativeReconnectAlarm(name = '') {
  return String(name || '').startsWith(`${TARGET_NATIVE_RECONNECT_ALARM_PREFIX}:`);
}

async function setNativeStatus(state, patch = {}) {
  nativeStatus = {
    ...nativeStatus,
    ...patch,
    state,
    lastChecked: Date.now(),
    reconnectAttempt: nativeReconnectAttempt,
    telemetry: nativeTelemetry.slice(-20),
  };
  await persistNativeStatus();
  onStatusChange?.(getNativeStatus());
  return getNativeStatus();
}

async function persistNativeStatus() {
  await chrome.storage.local.set({
    [NATIVE_STATUS_KEY]: nativeStatus,
    [NATIVE_HOST_STATUS_KEY]: nativeStatus,
  }).catch(() => {});
}

function validateNativeMethod(method, label) {
  const name = String(method || '').trim();
  if (!name) throw new Error(`${label} requires method`);
  if (name.length > 160) throw new Error(`${label} method is too long`);
  if (!/^[A-Za-z0-9_.:\/-]+$/.test(name)) throw new Error(`${label} method contains unsupported characters`);
  return name;
}

function validateNativeParams(params, method) {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`native ${method} params must be an object`);
  }
  try {
    JSON.stringify(params);
  } catch {
    throw new Error(`native ${method} params must be JSON serializable`);
  }
}

function sanitizeNativeRegistration(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const extensionId = String(value.extensionId || '').trim();
  const extensionInstanceId = String(value.extensionInstanceId || '').trim();
  const version = String(value.version || '').trim();
  const browserValue = String(value.browser || 'unknown').trim().toLowerCase();
  const browser = ['chrome', 'edge', 'brave', 'chromium'].includes(browserValue) ? browserValue : 'unknown';
  if (!/^[a-p]{32}$/.test(extensionId)) return null;
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(extensionInstanceId)) return null;
  if (!version || version.length > 64) return null;
  return {
    extensionId,
    extensionInstanceId,
    version,
    browser,
  };
}

function nativeResponseError(error = {}) {
  const message = error.message || JSON.stringify(error);
  const nativeError = new Error(message);
  if (typeof error.code === 'number') nativeError.code = error.code;
  if (error.data !== undefined) nativeError.data = error.data;
  return nativeError;
}

function recordNativeTelemetry(type, patch = {}) {
  const entry = {
    id: `native-telemetry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    kind: normalizeNativeTelemetryKind(type),
    hostName: patch.hostName || nativeStatus.hostName || NATIVE_HOST_DEFAULT,
    reconnectAttempt: nativeReconnectAttempt,
    at: Date.now(),
    ...patch,
  };
  nativeTelemetry.push(entry);
  if (nativeTelemetry.length > NATIVE_TELEMETRY_LIMIT) {
    nativeTelemetry.splice(0, nativeTelemetry.length - NATIVE_TELEMETRY_LIMIT);
  }
  if (onTelemetry) {
    void Promise.resolve(onTelemetry(sanitizeNativeTelemetryEvent(entry))).catch(() => {});
  }
}

function normalizeNativeTelemetryKind(type) {
  return String(type || '').replaceAll('_', '.');
}

function sanitizeNativeTelemetryEvent(entry = {}) {
  const safe = { ...entry };
  if (safe.error) safe.error = String(safe.error).slice(0, 500);
  delete safe.telemetry;
  return safe;
}

function describeError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
