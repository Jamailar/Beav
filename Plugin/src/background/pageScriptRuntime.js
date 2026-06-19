import { attachCdpTab, getDefaultCdpTimeoutMs, sendCdpCommandWithTimeout } from './cdpTransport.js';

const CDP_COMMAND_TIMEOUT_MS = getDefaultCdpTimeoutMs();

export async function evaluatePageScript(action = {}) {
  const tabId = requireTabId(action);
  const script = requireScript(action);
  const timeoutMs = normalizeTimeout(action.timeoutMs ?? action.timeout_ms, CDP_COMMAND_TIMEOUT_MS);
  await attachCdpTab(tabId);
  const result = await sendCdpCommandWithTimeout({ tabId }, 'Runtime.evaluate', {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs);
  if (result?.exceptionDetails) {
    throw new Error(`page.evaluate exception: ${formatExceptionDetails(result.exceptionDetails)}`);
  }
  const remote = result?.result || {};
  return {
    success: true,
    tabId,
    value: remoteObjectToValue(remote),
    valueType: remote.type || '',
    unserializableValue: remote.unserializableValue || null,
    checkedAt: new Date().toISOString(),
  };
}

function remoteObjectToValue(remote = {}) {
  if (Object.prototype.hasOwnProperty.call(remote, 'value')) return remote.value;
  if (remote.unserializableValue != null) return String(remote.unserializableValue);
  if (remote.description != null) return String(remote.description);
  return null;
}

function formatExceptionDetails(details = {}) {
  const text = details.text || details.exception?.description || details.exception?.value || details.exception?.className || 'unknown';
  const url = details.url ? ` at ${details.url}` : '';
  const line = Number.isInteger(details.lineNumber) ? `:${details.lineNumber + 1}` : '';
  const column = Number.isInteger(details.columnNumber) ? `:${details.columnNumber + 1}` : '';
  return `${text}${url}${line}${column}`;
}

function requireTabId(action = {}) {
  const tabId = Number(action.tabId || action.tab_id || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('page.evaluate requires integer tabId');
  return tabId;
}

function requireScript(action = {}) {
  const script = String(action.script || action.expression || '');
  if (!script.trim()) throw new Error('page.evaluate requires script');
  return script;
}

function normalizeTimeout(value, fallback) {
  const timeoutMs = Number(value || fallback);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback;
}
