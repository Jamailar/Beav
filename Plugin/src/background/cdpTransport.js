const CDP_PROTOCOL_VERSION = '1.3';
const CDP_COMMAND_TIMEOUT_MS = 10_000;

const attachedCdpTabs = new Set();
const attachedCdpTargets = new Set();
const attachedCdpTargetTabs = new Map();
let onCdpTransportTelemetry = null;

export class CdpCommandTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`Timed out after ${timeoutMs}ms waiting for CDP command ${method}.`);
    this.name = 'CdpCommandTimeoutError';
    this.method = String(method || '');
    this.timeoutMs = Number(timeoutMs || CDP_COMMAND_TIMEOUT_MS);
  }
}

export function isCdpCommandTimeoutError(error) {
  return error instanceof CdpCommandTimeoutError || error?.name === 'CdpCommandTimeoutError';
}

export function configureCdpTransportTelemetry(handler) {
  if (typeof handler === 'function') onCdpTransportTelemetry = handler;
}

export function handleDebuggerDetach(source) {
  if (typeof source?.tabId === 'number') attachedCdpTabs.delete(source.tabId);
  if (typeof source?.targetId === 'string') {
    attachedCdpTargets.delete(source.targetId);
    attachedCdpTargetTabs.delete(source.targetId);
  }
}

export async function attachCdpTab(tabId) {
  requireDebuggerApi();
  const id = Number(tabId);
  if (!Number.isInteger(id)) throw new Error('CDP attach requires integer tabId');
  const target = { tabId: id };
  if (attachedCdpTabs.has(id)) {
    emitCdpTransportTelemetry('attach.reused', { target });
    return { attached: true, alreadyAttached: true, target };
  }
  emitCdpTransportTelemetry('attach.started', { target });
  try {
    await chrome.debugger.attach(target, CDP_PROTOCOL_VERSION);
  } catch (error) {
    if (!String(describeChromeError(error)).includes('Another debugger')) {
      emitCdpTransportTelemetry('attach.failed', { target, error: describeChromeError(error) });
      throw error;
    }
  }
  attachedCdpTabs.add(id);
  emitCdpTransportTelemetry('attach.succeeded', { target });
  return { attached: true, alreadyAttached: false, target };
}

export async function attachCdpTarget(targetId, tabId = null) {
  requireDebuggerApi();
  const id = String(targetId || '');
  if (!id) throw new Error('CDP target attach requires targetId');
  const target = { targetId: id };
  const ownerTabId = Number(tabId);
  if (attachedCdpTargets.has(id)) {
    if (Number.isInteger(ownerTabId) && ownerTabId > 0) attachedCdpTargetTabs.set(id, ownerTabId);
    emitCdpTransportTelemetry('attach.reused', { target });
    return { attached: true, alreadyAttached: true, target };
  }
  emitCdpTransportTelemetry('attach.started', { target });
  try {
    await chrome.debugger.attach(target, CDP_PROTOCOL_VERSION);
  } catch (error) {
    if (!String(describeChromeError(error)).includes('Another debugger')) {
      emitCdpTransportTelemetry('attach.failed', { target, error: describeChromeError(error) });
      throw error;
    }
  }
  attachedCdpTargets.add(id);
  if (Number.isInteger(ownerTabId) && ownerTabId > 0) attachedCdpTargetTabs.set(id, ownerTabId);
  emitCdpTransportTelemetry('attach.succeeded', { target });
  return { attached: true, alreadyAttached: false, target };
}

export async function detachCdpTarget(target) {
  requireDebuggerApi();
  emitCdpTransportTelemetry('detach.started', { target: normalizeDebuggerTarget(target) });
  const detached = await detachDebuggerTarget(target);
  if (!detached.success) throw new Error(detached.error || 'Chrome debugger detach failed');
  if (target.tabId) attachedCdpTabs.delete(target.tabId);
  if (target.targetId) {
    attachedCdpTargets.delete(target.targetId);
    attachedCdpTargetTabs.delete(target.targetId);
  }
  emitCdpTransportTelemetry('detach.succeeded', { target: normalizeDebuggerTarget(target) });
}

export async function detachAttachedDebuggersBestEffort() {
  if (!chrome.debugger) return { success: true, detachedTabs: 0, detachedTargets: 0 };
  let rawTargets = [];
  let targetDiscoveryError = '';
  try {
    rawTargets = await chrome.debugger.getTargets();
  } catch (error) {
    targetDiscoveryError = describeChromeError(error);
  }
  const targetTabIds = new Set((Array.isArray(rawTargets) ? rawTargets : [])
    .filter((target) => target?.attached === true)
    .map((target) => Number(target?.tabId || 0))
    .filter((tabId) => Number.isInteger(tabId) && tabId > 0));
  const tabIds = new Set([...targetTabIds, ...attachedCdpTabs]);
  let detachedTabs = 0;
  let detachedTargets = 0;
  const detachedTabIds = [];
  const detachedTargetIds = [];
  const failures = targetDiscoveryError ? [{ operation: 'debugger.getTargets', error: targetDiscoveryError }] : [];
  for (const tabId of [...tabIds]) {
    emitCdpTransportTelemetry('detach.best_effort.started', { target: { tabId }, source: targetTabIds.has(tabId) ? 'debugger.getTargets' : 'attached_set' });
    const result = await detachDebuggerTarget({ tabId });
    if (result.success) {
      attachedCdpTabs.delete(tabId);
      emitCdpTransportTelemetry('detach.best_effort.succeeded', { target: { tabId }, source: targetTabIds.has(tabId) ? 'debugger.getTargets' : 'attached_set' });
      detachedTabs += 1;
      detachedTabIds.push(tabId);
    } else {
      failures.push({ target: { tabId }, error: result.error });
      emitCdpTransportTelemetry('detach.best_effort.failed', { target: { tabId }, error: result.error });
    }
  }
  for (const targetId of [...attachedCdpTargets]) {
    emitCdpTransportTelemetry('detach.best_effort.started', { target: { targetId } });
    const result = await detachDebuggerTarget({ targetId });
    if (result.success) {
      attachedCdpTargets.delete(targetId);
      attachedCdpTargetTabs.delete(targetId);
      emitCdpTransportTelemetry('detach.best_effort.succeeded', { target: { targetId } });
      detachedTargets += 1;
      detachedTargetIds.push(targetId);
    } else {
      failures.push({ target: { targetId }, error: result.error });
      emitCdpTransportTelemetry('detach.best_effort.failed', { target: { targetId }, error: result.error });
    }
  }
  return {
    success: failures.length === 0,
    rawTargetCount: Array.isArray(rawTargets) ? rawTargets.length : 0,
    targetTabIds: [...targetTabIds].sort((a, b) => a - b),
    detachedTabIds: detachedTabIds.sort((a, b) => a - b),
    detachedTargetIds: detachedTargetIds.sort(),
    detachedTabs,
    detachedTargets,
    failures,
  };
}

export async function detachAttachedDebuggersForTabs(tabIds = []) {
  if (!chrome.debugger) return { success: true, detachedTabs: 0, detachedTargets: 0 };
  const ids = new Set((tabIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0));
  if (!ids.size) return { success: true, detachedTabs: 0, detachedTargets: 0 };
  let rawTargets = [];
  let targetDiscoveryError = '';
  try {
    rawTargets = await chrome.debugger.getTargets();
  } catch (error) {
    targetDiscoveryError = describeChromeError(error);
  }
  const discoveredTabIds = (Array.isArray(rawTargets) ? rawTargets : [])
    .filter((target) => target?.attached === true && ids.has(Number(target?.tabId || 0)))
    .map((target) => Number(target.tabId));
  let detachedTabs = 0;
  let detachedTargets = 0;
  const detachedTabIds = [];
  const detachedTargetIds = [];
  const failures = targetDiscoveryError ? [{ operation: 'debugger.getTargets', error: targetDiscoveryError }] : [];
  for (const tabId of [...new Set([...attachedCdpTabs].filter((id) => ids.has(id)).concat(discoveredTabIds))]) {
    emitCdpTransportTelemetry('detach.best_effort.started', { target: { tabId }, reason: 'tabs_finalize' });
    const result = await detachDebuggerTarget({ tabId });
    if (result.success) {
      attachedCdpTabs.delete(tabId);
      emitCdpTransportTelemetry('detach.best_effort.succeeded', { target: { tabId }, reason: 'tabs_finalize' });
      detachedTabs += 1;
      detachedTabIds.push(tabId);
    } else {
      failures.push({ target: { tabId }, error: result.error });
      emitCdpTransportTelemetry('detach.best_effort.failed', { target: { tabId }, reason: 'tabs_finalize', error: result.error });
    }
  }
  for (const [targetId, tabId] of [...attachedCdpTargetTabs.entries()].filter(([, id]) => ids.has(id))) {
    emitCdpTransportTelemetry('detach.best_effort.started', { target: { targetId }, tabId, reason: 'tabs_finalize' });
    const result = await detachDebuggerTarget({ targetId });
    if (result.success) {
      attachedCdpTargets.delete(targetId);
      attachedCdpTargetTabs.delete(targetId);
      emitCdpTransportTelemetry('detach.best_effort.succeeded', { target: { targetId }, tabId, reason: 'tabs_finalize' });
      detachedTargets += 1;
      detachedTargetIds.push(targetId);
    } else {
      failures.push({ target: { targetId }, tabId, error: result.error });
      emitCdpTransportTelemetry('detach.best_effort.failed', { target: { targetId }, tabId, reason: 'tabs_finalize', error: result.error });
    }
  }
  return { success: failures.length === 0, detachedTabs, detachedTargets, detachedTabIds, detachedTargetIds, discoveredTabIds, failures };
}

export async function sendCdpCommandWithTimeout(target, method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  requireDebuggerApi();
  let timer = null;
  const startedAt = Date.now();
  const normalizedTarget = normalizeDebuggerTarget(target);
  const normalizedTimeoutMs = normalizeCdpTimeout(timeoutMs);
  emitCdpTransportTelemetry('command.started', {
    target: normalizedTarget,
    method,
    timeoutMs: normalizedTimeoutMs,
    paramKeys: listParamKeys(params),
  });
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new CdpCommandTimeoutError(method, normalizedTimeoutMs)), normalizedTimeoutMs);
  });
  try {
    const result = await Promise.race([
      chrome.debugger.sendCommand(target, method, params),
      timeout,
    ]);
    emitCdpTransportTelemetry('command.succeeded', {
      target: normalizedTarget,
      method,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    emitCdpTransportTelemetry(isCdpCommandTimeoutError(error) ? 'command.timeout' : 'command.failed', {
      target: normalizedTarget,
      method,
      durationMs: Date.now() - startedAt,
      error: describeChromeError(error),
    });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listCdpTargetsRaw() {
  requireDebuggerApi();
  emitCdpTransportTelemetry('targets.requested', {});
  const targets = await chrome.debugger.getTargets();
  emitCdpTransportTelemetry('targets.succeeded', { count: Array.isArray(targets) ? targets.length : 0 });
  return targets;
}

export function forgetAttachedCdpTab(tabId) {
  attachedCdpTabs.delete(Number(tabId));
}

export function hasAttachedCdp() {
  return attachedCdpTabs.size > 0 || attachedCdpTargets.size > 0;
}

export function getAttachedCdpSnapshot() {
  const attachedTabIds = [...attachedCdpTabs].sort((a, b) => a - b);
  const attachedTargetIds = [...attachedCdpTargets].sort();
  return {
    attachedTabIds,
    attachedTargetIds,
    attachedTabs: attachedTabIds.map((tabId) => ({ tabId })),
    attachedTargets: attachedTargetIds.map((targetId) => ({ targetId, tabId: attachedCdpTargetTabs.get(targetId) || null })),
    attachedCount: attachedTabIds.length + attachedTargetIds.length,
    hasAttachedCdp: attachedTabIds.length > 0 || attachedTargetIds.length > 0,
    snapshotAt: new Date().toISOString(),
  };
}

export function getCdpProtocolVersion() {
  return CDP_PROTOCOL_VERSION;
}

export function getDefaultCdpTimeoutMs() {
  return CDP_COMMAND_TIMEOUT_MS;
}

export function requireDebuggerApi() {
  if (!chrome.debugger) throw new Error('Chrome debugger API is unavailable');
}

function describeChromeError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

async function detachDebuggerTarget(target) {
  try {
    await chrome.debugger.detach(target);
    return { success: true, alreadyDetached: false };
  } catch (error) {
    const message = describeChromeError(error);
    if (/not attached|no tab with given id|target closed/i.test(message)) {
      return { success: true, alreadyDetached: true };
    }
    return { success: false, alreadyDetached: false, error: message };
  }
}

function normalizeCdpTimeout(timeoutMs) {
  const value = Number(timeoutMs || CDP_COMMAND_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : CDP_COMMAND_TIMEOUT_MS;
}

function emitCdpTransportTelemetry(kind, payload = {}) {
  if (!onCdpTransportTelemetry) return;
  const event = {
    kind,
    target: normalizeDebuggerTarget(payload.target || {}),
    method: payload.method ? String(payload.method) : '',
    timeoutMs: Number.isFinite(Number(payload.timeoutMs)) ? Number(payload.timeoutMs) : null,
    paramKeys: Array.isArray(payload.paramKeys) ? payload.paramKeys.slice(0, 20) : [],
    count: Number.isFinite(Number(payload.count)) ? Number(payload.count) : null,
    durationMs: Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null,
    error: payload.error ? String(payload.error).slice(0, 500) : '',
    emittedAt: new Date().toISOString(),
  };
  void Promise.resolve(onCdpTransportTelemetry(event)).catch(() => {});
}

function normalizeDebuggerTarget(target = {}) {
  return {
    tabId: Number.isInteger(Number(target.tabId)) ? Number(target.tabId) : null,
    targetId: typeof target.targetId === 'string' ? target.targetId : '',
  };
}

function listParamKeys(params = {}) {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) return [];
  return Object.keys(params).slice(0, 20);
}
