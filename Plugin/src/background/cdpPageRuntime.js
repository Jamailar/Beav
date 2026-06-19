import { attachCdpTab, getDefaultCdpTimeoutMs, sendCdpCommandWithTimeout } from './cdpTransport.js';
import { getStoredMap, setStoredMap } from './storage.js';

export const VIEWPORT_RESTORE_KEY = 'xwowBrowserDataAiViewportRestore';
export const SCREENSHOT_MAX_BYTES = 6 * 1024 * 1024;

const CDP_COMMAND_TIMEOUT_MS = getDefaultCdpTimeoutMs();

export async function captureVisibleTabScreenshot(tabId, options = {}) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab?.id || typeof tab.windowId !== 'number') throw new Error('screenshot requires a valid tab');
  const format = options.format === 'png' ? 'png' : 'jpeg';
  if (options.fullPage === true || hasScreenshotCrop(options)) {
    return await captureCdpScreenshot({ ...options, tabId: tab.id, format });
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format,
    quality: format === 'png' ? undefined : clamp(Number(options.quality || 76), 1, 100),
  });
  const data = dataUrlBase64(dataUrl);
  const byteSize = dataUrlByteSize(dataUrl);
  if (byteSize > SCREENSHOT_MAX_BYTES) {
    return { success: false, error: `screenshot too large: ${byteSize}`, byteSize };
  }
  return {
    success: true,
    tabId: tab.id,
    url: tab.url || '',
    title: tab.title || '',
    format,
    data,
    dataUrl,
    byteSize,
    capturedAt: new Date().toISOString(),
  };
}

export async function captureCdpScreenshot(action = {}) {
  const tabId = requireTabId(action, 'cdp.screenshot');
  await attachCdpTab(tabId);
  const format = action.format === 'png' ? 'png' : 'jpeg';
  const timeoutMs = Number((action.timeoutMs ?? action.timeout_ms) || CDP_COMMAND_TIMEOUT_MS);
  const clip = await resolveScreenshotClip(tabId, action, timeoutMs);
  const result = await sendCdpCommandWithTimeout({ tabId }, 'Page.captureScreenshot', {
    format,
    quality: format === 'png' ? undefined : clamp(Number(action.quality || 76), 1, 100),
    fromSurface: action.fromSurface !== false,
    captureBeyondViewport: action.captureBeyondViewport === true || action.fullPage === true || Boolean(clip),
    ...(clip ? { clip } : {}),
  }, timeoutMs);
  const data = String(result.data || '');
  const dataUrl = `data:image/${format};base64,${data}`;
  const byteSize = dataUrlByteSize(dataUrl);
  if (byteSize > SCREENSHOT_MAX_BYTES) return { success: false, error: `screenshot too large: ${byteSize}`, byteSize };
  return {
    success: true,
    tabId,
    format,
    data,
    dataUrl,
    byteSize,
    fullPage: action.fullPage === true,
    clip: clip || null,
    capturedAt: new Date().toISOString(),
  };
}

export async function setCdpViewport(action = {}) {
  const tabId = requireTabId(action, 'cdp.viewportSet');
  await attachCdpTab(tabId);
  const width = clamp(Number(action.width || 1280), 320, 4096);
  const height = clamp(Number(action.height || 720), 240, 4096);
  await sendCdpCommandWithTimeout({ tabId }, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: Number(action.deviceScaleFactor || 1),
    mobile: action.mobile === true,
  }, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  return { success: true, tabId, width, height };
}

export async function resetCdpViewport(action = {}) {
  const tabId = requireTabId(action, 'cdp.viewportReset');
  await attachCdpTab(tabId);
  await sendCdpCommandWithTimeout({ tabId }, 'Emulation.clearDeviceMetricsOverride', {}, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  return { success: true, tabId, restored: true };
}

export async function setBrowserViewport(options = {}) {
  const tabId = Number(options.tabId || options.activeTabId || 0);
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const windowId = Number(options.windowId || tab?.windowId || 0);
  if (!windowId) throw new Error('viewport.set requires a windowId or tabId');
  const width = clamp(Number(options.width || 1280), 320, 4096);
  const height = clamp(Number(options.height || 720), 240, 4096);
  const current = await chrome.windows.get(windowId);
  const restore = await getStoredMap(VIEWPORT_RESTORE_KEY);
  if (!restore[String(windowId)]) {
    restore[String(windowId)] = {
      left: current.left,
      top: current.top,
      width: current.width,
      height: current.height,
      state: current.state,
    };
    await setStoredMap(VIEWPORT_RESTORE_KEY, restore);
  }
  await chrome.windows.update(windowId, { state: 'normal' });
  const updated = await chrome.windows.update(windowId, { width, height });
  return { success: true, windowId, width: updated.width, height: updated.height };
}

export async function resetBrowserViewport(options = {}) {
  const tabId = Number(options.tabId || options.activeTabId || 0);
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const windowId = Number(options.windowId || tab?.windowId || 0);
  if (!windowId) throw new Error('viewport.reset requires a windowId or tabId');
  const restore = await getStoredMap(VIEWPORT_RESTORE_KEY);
  const previous = restore[String(windowId)];
  if (!previous) return { success: true, windowId, restored: false };
  const patch = {
    width: previous.width,
    height: previous.height,
    left: previous.left,
    top: previous.top,
    state: previous.state === 'minimized' ? 'normal' : previous.state,
  };
  const updated = await chrome.windows.update(windowId, patch);
  delete restore[String(windowId)];
  await setStoredMap(VIEWPORT_RESTORE_KEY, restore);
  return { success: true, windowId, restored: true, width: updated.width, height: updated.height };
}

export async function getViewportState(options = {}) {
  const tabId = Number(options.tabId || options.activeTabId || 0);
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const windowId = Number(options.windowId || tab?.windowId || 0);
  const restore = normalizeViewportRestoreMap(await getStoredMap(VIEWPORT_RESTORE_KEY));
  const state = {
    success: true,
    restoreByWindowId: restore,
    restoreWindowIds: Object.keys(restore).map((id) => Number(id)).filter((id) => Number.isInteger(id)),
    snapshotAt: new Date().toISOString(),
  };
  if (windowId) {
    const window = await chrome.windows.get(windowId).catch(() => null);
    state.windowId = windowId;
    state.hasRestore = Boolean(restore[String(windowId)]);
    state.restore = restore[String(windowId)] || null;
    state.currentWindow = window ? normalizeWindowViewport(window) : null;
  }
  return state;
}

export function dataUrlByteSize(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  return Math.floor(base64.length * 0.75);
}

function dataUrlBase64(dataUrl) {
  return String(dataUrl || '').split(',')[1] || '';
}

async function resolveScreenshotClip(tabId, action = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  if (action.fullPage === true) {
    const metrics = await sendCdpCommandWithTimeout({ tabId }, 'Page.getLayoutMetrics', {}, timeoutMs);
    const size = metrics?.cssContentSize || metrics?.contentSize || {};
    const width = Math.max(1, Math.ceil(Number(size.width || 0)));
    const height = Math.max(1, Math.ceil(Number(size.height || 0)));
    return { x: 0, y: 0, width, height, scale: 1 };
  }
  if (!hasScreenshotCrop(action)) return null;
  const x = Math.max(0, Number(action.cropX ?? action.x ?? 0));
  const y = Math.max(0, Number(action.cropY ?? action.y ?? 0));
  const width = Math.max(1, Number(action.cropWidth ?? action.width ?? 0));
  const height = Math.max(1, Number(action.cropHeight ?? action.height ?? 0));
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('screenshot crop requires finite width and height');
  return { x, y, width, height, scale: 1 };
}

function hasScreenshotCrop(action = {}) {
  return action.cropX != null
    || action.cropY != null
    || action.cropWidth != null
    || action.cropHeight != null;
}

function requireTabId(action = {}, label = 'browser action') {
  const tabId = Number(action.tabId || action.activeTabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`${label} requires an integer tabId`);
  return tabId;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function normalizeViewportRestoreMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || !item || typeof item !== 'object' || Array.isArray(item)) continue;
    out[key] = normalizeWindowViewport(item);
  }
  return out;
}

function normalizeWindowViewport(window = {}) {
  return {
    left: Number.isInteger(window.left) ? window.left : null,
    top: Number.isInteger(window.top) ? window.top : null,
    width: Number.isInteger(window.width) ? window.width : null,
    height: Number.isInteger(window.height) ? window.height : null,
    state: window.state || '',
  };
}
