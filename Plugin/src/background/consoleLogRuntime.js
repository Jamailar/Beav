import { attachCdpTab, getDefaultCdpTimeoutMs, sendCdpCommandWithTimeout } from './cdpTransport.js';

const CONSOLE_LOG_LIMIT = 300;
const CDP_COMMAND_TIMEOUT_MS = getDefaultCdpTimeoutMs();

const logsByTabId = new Map();
const enabledTabs = new Set();

export async function listPageConsoleLogs(action = {}) {
  const tabId = requireTabId(action);
  const timeoutMs = normalizeTimeout(action.timeoutMs ?? action.timeout_ms, CDP_COMMAND_TIMEOUT_MS);
  await enablePageConsoleLogCapture(tabId, timeoutMs);
  const filter = String(action.filter || '').toLowerCase();
  const levels = normalizeLevels(action.levels);
  const limit = clamp(Number(action.limit || 100), 1, CONSOLE_LOG_LIMIT);
  const logs = (logsByTabId.get(tabId) || [])
    .filter((log) => !filter || log.message.toLowerCase().includes(filter))
    .filter((log) => !levels.length || levels.includes(log.level))
    .slice(-limit)
    .reverse();
  return {
    success: true,
    tabId,
    logs,
    logCount: logs.length,
    captureEnabled: enabledTabs.has(tabId),
    checkedAt: new Date().toISOString(),
  };
}

export async function enablePageConsoleLogCapture(tabId, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  const id = Number(tabId || 0);
  if (!Number.isInteger(id) || id <= 0) throw new Error('page.consoleLogs requires tabId');
  await attachCdpTab(id);
  await sendCdpCommandWithTimeout({ tabId: id }, 'Runtime.enable', {}, timeoutMs).catch(() => {});
  await sendCdpCommandWithTimeout({ tabId: id }, 'Log.enable', {}, timeoutMs).catch(() => {});
  enabledTabs.add(id);
  return { success: true, tabId: id, captureEnabled: true };
}

export function handleConsoleCdpEvent(source = {}, method = '', params = {}) {
  const tabId = Number(source.tabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  let log = null;
  if (method === 'Runtime.consoleAPICalled') {
    log = consoleApiCalledToLog(tabId, params);
  } else if (method === 'Log.entryAdded') {
    log = logEntryToLog(tabId, params.entry || {});
  }
  if (!log) return null;
  const logs = logsByTabId.get(tabId) || [];
  logs.push(log);
  logsByTabId.set(tabId, logs.slice(-CONSOLE_LOG_LIMIT));
  return log;
}

export function getConsoleLogSnapshot() {
  const tabs = {};
  for (const [tabId, logs] of logsByTabId.entries()) {
    tabs[String(tabId)] = { tabId, logCount: logs.length, latest: logs[logs.length - 1] || null };
  }
  return {
    success: true,
    enabledTabIds: [...enabledTabs].sort((a, b) => a - b),
    tabs,
    snapshotAt: new Date().toISOString(),
  };
}

function consoleApiCalledToLog(tabId, params = {}) {
  const level = normalizeLevel(params.type || 'log');
  const args = Array.isArray(params.args) ? params.args : [];
  return {
    level,
    message: args.map(remoteObjectToText).join(' '),
    timestamp: timestampFromCdp(params.timestamp),
    url: firstStackUrl(params.stackTrace) || '',
    tabId,
    source: 'Runtime.consoleAPICalled',
  };
}

function logEntryToLog(tabId, entry = {}) {
  return {
    level: normalizeLevel(entry.level || 'log'),
    message: String(entry.text || entry.message || ''),
    timestamp: timestampFromCdp(entry.timestamp),
    url: String(entry.url || ''),
    tabId,
    source: 'Log.entryAdded',
  };
}

function remoteObjectToText(object = {}) {
  if (object.value != null) return String(object.value);
  if (object.unserializableValue != null) return String(object.unserializableValue);
  if (object.description != null) return String(object.description);
  if (object.type != null) return `[${object.type}]`;
  return '';
}

function firstStackUrl(stackTrace = null) {
  const callFrames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames : [];
  return String(callFrames.find((frame) => frame?.url)?.url || '');
}

function timestampFromCdp(value) {
  const numeric = Number(value || 0);
  if (Number.isFinite(numeric) && numeric > 0) {
    const epochMs = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    return new Date(epochMs).toISOString();
  }
  return new Date().toISOString();
}

function normalizeLevels(value) {
  const levels = Array.isArray(value) ? value : (value ? [value] : []);
  return levels.map(normalizeLevel).filter(Boolean);
}

function normalizeLevel(value) {
  const level = String(value || 'log').toLowerCase();
  if (level === 'warning') return 'warn';
  if (level === 'verbose') return 'debug';
  if (['debug', 'info', 'log', 'warn', 'error'].includes(level)) return level;
  return 'log';
}

function requireTabId(action = {}) {
  const tabId = Number(action.tabId || action.tab_id || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('page.consoleLogs requires integer tabId');
  return tabId;
}

function normalizeTimeout(value, fallback) {
  const timeoutMs = Number(value || fallback);
  return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
