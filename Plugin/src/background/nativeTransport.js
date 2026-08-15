export const NATIVE_RECONNECT_ALARM = 'redbox-browser-control-native-reconnect';
export const TARGET_NATIVE_RECONNECT_ALARM_PREFIX = 'native-transport-reconnect';
export const NATIVE_STATUS_KEY = 'redboxBrowserControlNativeHostStatus';
export const NATIVE_HOST_STATUS_KEY = 'NATIVE_HOST_STATUS';
export const NATIVE_HOST_DEFAULT = 'com.redbox.browser_control';
export const TARGET_NATIVE_DISCONNECTED_ERROR = 'Native transport is disconnected; reconnect is pending';
export const TARGET_NATIVE_INVALID_RESPONSE_ERROR = 'Native host returned an invalid response';
export const TARGET_NATIVE_RESPONSE_HANDLING = 'pending_id_then_error_or_result_else_invalid_response';
export const XWOW_NATIVE_RESPONSE_VALIDATION = 'strict_jsonrpc_expected_id_exactly_one_result_or_error';
export const NATIVE_RECONNECT_DELAY_MS = 1000;
export const NATIVE_RECONNECT_MAX_DELAY_MS = 30_000;
export const NATIVE_RECONNECT_JITTER_RATIO = 0.2;
// Chrome 120+ permits extension alarms no more frequently than every 30 seconds.
export const NATIVE_RECONNECT_PERIOD_MINUTES = 0.5;
export const BRIDGE_HEALTH_CHECK_DELAY_MS = NATIVE_RECONNECT_PERIOD_MINUTES * 60_000;
export const NATIVE_HOST_LIFECYCLE_GRACE_MS = 20_000;
export const NATIVE_TELEMETRY_LIMIT = 50;
export const NATIVE_HANDSHAKE_TIMEOUT_MS = 3000;
export const NATIVE_PENDING_REQUEST_LIMIT = 8;

let nativePort = null;
let nativeRequestSeq = 0;
let nativeReconnectAttempt = 0;
let nativeReconnectPending = false;
let nativeReconnectPromise = null;
let nativeReconnectTimeoutId = null;
let nativeDisconnectRequested = false;
let lastNativeLifecycle = null;
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
  expectedDisconnect: false,
  lifecycle: null,
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
    state: nativePort ? nativeStatus.state : 'disconnected',
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
    const errorCode = classifyNativeTransportFailure(error);
    recordNativeTelemetry('connect_failed', { hostName, error: describeError(error) });
    await setNativeStatus(options.silent ? 'reconnecting' : 'disconnected', {
      hostName,
      error: describeError(error),
      errorCode,
      nextRetryMs: nextNativeReconnectDelayMs(),
    });
    nativeReconnectPending = false;
    await scheduleNativeReconnect();
    if (!options.silent) {
      throw Object.assign(error instanceof Error ? error : new Error(describeError(error)), {
        code: errorCode,
        retryable: true,
      });
    }
    return getNativeStatus();
  }
  nativePort.onMessage.addListener((message) => {
    if (handleNativeLifecycle(message)) return;
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
    const errorCode = classifyNativeTransportFailure(error);
    const disconnectError = Object.assign(new Error(error), {
      code: errorCode,
      retryable: true,
    });
    const disconnectRequested = nativeDisconnectRequested;
    nativeDisconnectRequested = false;
    if (nativePort === connectedPort) nativePort = null;
    rejectPendingNativeRequests(disconnectError);
    const lifecycle = recentNativeLifecycle();
    const expectedDisconnect = lifecycle?.expected === true;
    recordNativeTelemetry('disconnected', { hostName, error, errorCode, expectedDisconnect, lifecycle });
    if (disconnectRequested) return;
    void setNativeStatus('disconnected', {
      hostName,
      error,
      errorCode,
      expectedDisconnect,
      lifecycle,
    }).then(() => scheduleNativeReconnect({ immediate: true })).catch(() => {});
  });
  let handshake;
  try {
    handshake = await requestNativeHost('ping', {}, NATIVE_HANDSHAKE_TIMEOUT_MS);
    if (!handshake || handshake.ok !== true) {
      throw new Error('Native host handshake returned an invalid response');
    }
    assertNativeHostVersionCompatibility(handshake);
  } catch (error) {
    const errorCode = classifyNativeTransportFailure(error);
    if (nativePort === connectedPort) {
      nativePort = null;
      try {
        nativeDisconnectRequested = true;
        connectedPort.disconnect();
      } catch {}
    }
    rejectPendingNativeRequests(error);
    recordNativeTelemetry('connect_failed', { hostName, error: describeError(error), phase: 'handshake' });
    await setNativeStatus(options.silent ? 'reconnecting' : 'disconnected', {
      hostName,
      error: describeError(error),
      errorCode,
      nextRetryMs: nextNativeReconnectDelayMs(),
    });
    nativeReconnectPending = false;
    await scheduleNativeReconnect();
    if (!options.silent) {
      throw Object.assign(error instanceof Error ? error : new Error(describeError(error)), {
        code: errorCode,
        retryable: true,
      });
    }
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
  lastNativeLifecycle = null;
  clearNativeReconnectTimeout();
  const connectionState = classifyDesktopBridgeHandshake(handshake);
  const desktopBridgeConnected = connectionState === 'connected';
  const connectionError = connectionState === 'upgrade_required'
    ? '当前 Beav 版本不支持 Desktop Bridge，请升级 Beav'
    : connectionState === 'bridge_error'
      ? `Beav Desktop Bridge handshake failed: ${handshake?.desktopBridge?.errorCode || 'unknown'}`
      : (desktopBridgeConnected ? '' : 'Beav desktop app is not connected');
  recordNativeTelemetry(connectionState, {
    hostName,
    handshake: true,
    registered: registrationSucceeded,
    desktopBridgeConnected,
  });
  await setNativeStatus(connectionState, {
    hostName,
    error: connectionError,
    errorCode: connectionState === 'connected'
      ? ''
      : connectionState === 'upgrade_required'
        ? 'NATIVE_HOST_UPGRADE_REQUIRED'
        : connectionState === 'bridge_error'
          ? String(handshake?.desktopBridge?.errorCode || 'DESKTOP_BRIDGE_ERROR')
          : 'APP_NOT_RUNNING',
    handshake,
    registration,
    registrationSucceeded,
    expectedDisconnect: false,
    lifecycle: null,
    nextRetryMs: desktopBridgeConnected ? 0 : BRIDGE_HEALTH_CHECK_DELAY_MS,
  });
  if (desktopBridgeConnected) {
    await clearNativeReconnectAlarm();
  } else {
    scheduleNativeReconnectTimeout();
    await ensureNativeReconnectAlarm();
  }
  return getNativeStatus();
}

export function assertNativeHostVersionCompatibility(handshake = {}) {
  const manifest = chrome.runtime.getManifest();
  const extensionVersion = manifest.version_name || manifest.version || '';
  const hostVersion = String(handshake.appVersion || '');
  const expected = normalizeProductVersion(extensionVersion);
  const actual = normalizeProductVersion(hostVersion);
  const expectedCompatibility = expected.split('.')[0];
  const actualCompatibility = actual.split('.')[0];
  if (!expected || !actual || expectedCompatibility !== actualCompatibility) {
    throw new Error(
      `Native host major version mismatch: extension ${expected || 'unknown'}, host ${actual || 'unknown'}. Restart Beav and reload the extension.`,
    );
  }
  return true;
}

export function classifyDesktopBridgeHandshake(handshake = {}) {
  if (!handshake?.desktopBridge || typeof handshake.desktopBridge !== 'object') {
    return 'upgrade_required';
  }
  const bridge = handshake.desktopBridge;
  if (bridge.availability === 'bridge_error') {
    return 'bridge_error';
  }
  if (bridge.connected === true) return 'connected';
  const errorCode = String(bridge.errorCode || '').trim().toUpperCase();
  const phase = String(bridge.phase || '').trim().toLowerCase();
  if (bridge.availability === 'app_starting' || errorCode === 'APP_STARTING' || phase === 'bridge_reconnect') {
    return 'app_starting';
  }
  return 'app_not_running';
}

export function shouldReportNativeConnectionFailure(error = null, status = nativeStatus, previousStatus = null) {
  const currentState = String(status?.state || '').trim().toLowerCase();
  const previousState = String(previousStatus?.state || '').trim().toLowerCase();
  const availability = String(status?.handshake?.desktopBridge?.availability || '').trim().toLowerCase();
  const code = String(error?.code || error?.data?.code || '').trim().toUpperCase();

  if (status?.expectedDisconnect === true || status?.lifecycle?.expected === true) {
    return false;
  }

  if (
    currentState === 'app_not_running'
    || currentState === 'app_starting'
    || (availability === 'app_not_running' && currentState !== 'connected')
    || (availability === 'app_starting' && currentState !== 'connected')
    || (code === 'APP_NOT_RUNNING' && currentState !== 'connected')
    || (code === 'APP_STARTING' && currentState !== 'connected')
    || (code === 'APP_BRIDGE_UNAVAILABLE' && currentState !== 'connected')
  ) {
    return false;
  }
  if (
    currentState === 'upgrade_required'
    || currentState === 'bridge_error'
    || (availability === 'bridge_error'
      && (currentState === 'connected' || currentState === 'bridge_error' || previousState === 'connected'))
    || /UPGRADE|PROTOCOL_MISMATCH|AUTHENTICATION_FAILED|VERSION_STALE/.test(code)
  ) {
    return true;
  }
  return currentState === 'connected' || previousState === 'connected';
}

export function classifyNativeTransportFailure(error = null) {
  const message = describeError(error).toLowerCase();
  if (/native_request_timeout|native transport is busy/.test(message)) {
    return 'NATIVE_REQUEST_TIMEOUT';
  }
  if (/native host has exited|native host exited|native host process.*(?:exit|quit|crash)/.test(message)) {
    return 'NATIVE_HOST_EXITED';
  }
  if (/specified native messaging host|native messaging host.*(?:not found|not registered)|host manifest.*(?:not found|missing)/.test(message)) {
    return 'NATIVE_HOST_NOT_REGISTERED';
  }
  if (/native host version mismatch|desktop bridge.*upgrade|required.*upgrade/.test(message)) {
    return 'NATIVE_HOST_UPGRADE_REQUIRED';
  }
  return 'NATIVE_TRANSPORT_DISCONNECTED';
}

export function normalizeProductVersion(value = '') {
  const segments = String(value).trim().split('.').slice(0, 3);
  if (segments.length !== 3 || segments.some((segment) => !/^\d+$/.test(segment))) return '';
  return segments.join('.');
}

export async function disconnectNativeTransport(reason = 'disconnect') {
  recordNativeTelemetry('disconnect_requested', { reason, connected: Boolean(nativePort) });
  if (nativePort) {
    try {
      nativeDisconnectRequested = true;
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
    throw Object.assign(new Error(TARGET_NATIVE_DISCONNECTED_ERROR), {
      code: 'NATIVE_TRANSPORT_DISCONNECTED',
      retryable: true,
    });
  }
  if (pendingNativeRequests.size >= NATIVE_PENDING_REQUEST_LIMIT) {
    const error = new Error('Native transport is busy; retry the request');
    error.code = 'NATIVE_TRANSPORT_BUSY';
    error.retryable = true;
    throw error;
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
      reject(Object.assign(new Error(`native_request_timeout: ${method}`), {
        code: 'NATIVE_REQUEST_TIMEOUT',
        retryable: true,
        phase: 'native_messaging',
      }));
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

export function calculateNativeReconnectDelayMs(attempt = nativeReconnectAttempt, random = Math.random) {
  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const exponentialDelay = Math.min(
    NATIVE_RECONNECT_MAX_DELAY_MS,
    NATIVE_RECONNECT_DELAY_MS * (2 ** Math.min(normalizedAttempt - 1, 8)),
  );
  const randomValue = Math.max(0, Math.min(1, Number(random()) || 0));
  const jitter = Math.round(exponentialDelay * NATIVE_RECONNECT_JITTER_RATIO * randomValue);
  return Math.min(NATIVE_RECONNECT_MAX_DELAY_MS, exponentialDelay + jitter);
}

function nextNativeReconnectDelayMs() {
  return calculateNativeReconnectDelayMs(nativeReconnectAttempt || 1);
}

async function scheduleNativeReconnect(options = {}) {
  if (nativePort) return;
  if (!nativeReconnectPending) {
    nativeReconnectPending = true;
    nativeReconnectAttempt = Math.min(999, Math.max(1, nativeReconnectAttempt + 1));
  }
  const delayMs = options.immediate === true ? 0 : nextNativeReconnectDelayMs();
  recordNativeTelemetry('reconnect_scheduled', {
    attempt: nativeReconnectAttempt,
    delayMs,
    immediate: options.immediate === true,
  });
  await setNativeStatus('reconnecting', { nextRetryMs: delayMs }).catch(() => {});
  scheduleNativeReconnectTimeout(delayMs);
  await ensureNativeReconnectAlarm();
}

async function runNativeReconnectAttempt(hostName = '') {
  if (nativeReconnectPromise) return await nativeReconnectPromise;
  nativeReconnectPromise = performNativeReconnectAttempt(hostName).finally(() => {
    nativeReconnectPromise = null;
  });
  return await nativeReconnectPromise;
}

async function performNativeReconnectAttempt(hostName = '') {
  if (nativePort) {
    try {
      const handshake = await requestNativeHost('ping', {}, NATIVE_HANDSHAKE_TIMEOUT_MS);
      assertNativeHostVersionCompatibility(handshake);
      const connectionState = classifyDesktopBridgeHandshake(handshake);
      if (connectionState === 'connected') {
        nativeReconnectAttempt = 0;
        nativeReconnectPending = false;
        clearNativeReconnectTimeout();
        await setNativeStatus('connected', {
          handshake,
          error: '',
          errorCode: '',
          nextRetryMs: 0,
        });
        await clearNativeReconnectAlarm();
        return getNativeStatus();
      }
      await setNativeStatus(connectionState, {
        handshake,
        error: connectionState === 'upgrade_required'
          ? '当前 Beav 版本不支持 Desktop Bridge，请升级 Beav'
          : connectionState === 'bridge_error'
            ? `Beav Desktop Bridge handshake failed: ${handshake?.desktopBridge?.errorCode || 'unknown'}`
            : 'Beav desktop app is not connected',
        errorCode: connectionState === 'upgrade_required'
          ? 'NATIVE_HOST_UPGRADE_REQUIRED'
          : connectionState === 'bridge_error'
            ? String(handshake?.desktopBridge?.errorCode || 'DESKTOP_BRIDGE_ERROR')
            : 'APP_NOT_RUNNING',
        nextRetryMs: BRIDGE_HEALTH_CHECK_DELAY_MS,
      });
    } catch (error) {
      if (nativePort) await disconnectNativeTransport('health_check_failed');
      await setNativeStatus('reconnecting', {
        error: describeError(error),
        errorCode: classifyNativeTransportFailure(error),
        nextRetryMs: nextNativeReconnectDelayMs(),
      });
    }
    nativeReconnectPending = false;
    await scheduleNativeReconnect();
    await ensureNativeReconnectAlarm();
    return getNativeStatus();
  }
  clearNativeReconnectTimeout();
  if (!nativeReconnectPending) {
    nativeReconnectPending = true;
    nativeReconnectAttempt = Math.min(999, Math.max(1, nativeReconnectAttempt + 1));
  }
  recordNativeTelemetry('reconnect_attempt', { hostName: hostName || nativeStatus.hostName || NATIVE_HOST_DEFAULT });
  const status = await connectNativeTransport({ silent: true, hostName: hostName || nativeStatus.hostName || NATIVE_HOST_DEFAULT });
  if (status.state !== 'connected' && !nativeReconnectPending) {
    await scheduleNativeReconnect();
    await ensureNativeReconnectAlarm();
  }
  return status;
}

function scheduleNativeReconnectTimeout(delayMs = nextNativeReconnectDelayMs()) {
  if (nativePort || nativeReconnectTimeoutId != null) return;
  nativeReconnectTimeoutId = setTimeout(() => {
    nativeReconnectTimeoutId = null;
    void runNativeReconnectAttempt().catch(() => {});
  }, delayMs);
}

function clearNativeReconnectTimeout() {
  if (nativeReconnectTimeoutId == null) return;
  clearTimeout(nativeReconnectTimeoutId);
  nativeReconnectTimeoutId = null;
}

async function ensureNativeReconnectAlarm() {
  if (nativePort && nativeStatus.state === 'connected') return;
  const existing = await chrome.alarms.get(NATIVE_RECONNECT_ALARM).catch(() => null);
  if (!existing) {
    await chrome.alarms.create(NATIVE_RECONNECT_ALARM, {
      periodInMinutes: NATIVE_RECONNECT_PERIOD_MINUTES,
    }).catch(() => {});
  }
  await chrome.alarms.clear(getTargetNativeReconnectAlarmName()).catch(() => {});
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

function handleNativeLifecycle(message) {
  if (message?.method !== 'host.lifecycle') return false;
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const details = params.details && typeof params.details === 'object' ? params.details : {};
  lastNativeLifecycle = {
    reason: String(params.reason || 'unknown').slice(0, 80),
    atMs: Number(params.atMs || Date.now()),
    expected: details.expected === true || params.reason === 'app_upgrade',
  };
  recordNativeTelemetry('host_lifecycle', lastNativeLifecycle);
  void setNativeStatus(nativeStatus.state, { lifecycle: lastNativeLifecycle }).catch(() => {});
  return true;
}

function recentNativeLifecycle() {
  if (!lastNativeLifecycle) return null;
  if (Date.now() - Number(lastNativeLifecycle.atMs || 0) > NATIVE_HOST_LIFECYCLE_GRACE_MS) return null;
  return { ...lastNativeLifecycle };
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
  if (error.data !== undefined) {
    nativeError.data = error.data;
    if (typeof error.data?.code === 'string') nativeError.code = error.data.code;
    if (typeof error.data?.retryable === 'boolean') nativeError.retryable = error.data.retryable;
    if (typeof error.data?.phase === 'string') nativeError.phase = error.data.phase;
  }
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
