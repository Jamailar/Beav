import { attachCdpTab, getDefaultCdpTimeoutMs, sendCdpCommandWithTimeout } from './cdpTransport.js';

const CDP_COMMAND_TIMEOUT_MS = getDefaultCdpTimeoutMs();
const FILE_CHOOSER_EVENT_LIMIT = 100;

const pendingFileChooserWaiters = new Map();
const fileChooserEventsById = new Map();

let nextFileChooserId = 0;
let onFileChooserTelemetry = null;

export function configureFileChooserTelemetry(handler) {
  if (typeof handler === 'function') onFileChooserTelemetry = handler;
}

export async function waitForFileChooser(action = {}) {
  const tabId = requireTabId(action, 'page.waitForFileChooser');
  const timeoutMs = normalizeTimeout(action.timeoutMs ?? action.timeout_ms, CDP_COMMAND_TIMEOUT_MS);
  const startedAt = Date.now();
  await attachCdpTab(tabId);
  await sendCdpCommandWithTimeout({ tabId }, 'Page.enable', {}, timeoutMs);
  await sendCdpCommandWithTimeout({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: true, cancel: true }, timeoutMs);
  await installFileChooserTrap(tabId, timeoutMs).catch(() => {});
  emitFileChooserTelemetry('wait.started', { tabId, timeoutMs });
  return await new Promise((resolve, reject) => {
    const waitId = createFileChooserId('wait');
    let pollTimer = null;
    let polling = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      pendingFileChooserWaiters.delete(waitId);
    };
    const timer = setTimeout(() => {
      void (async () => {
        const payload = await withLocalTimeout(readFileChooserTrapPayload(tabId, startedAt, timeoutMs), 500).catch(() => null);
        if (payload && pendingFileChooserWaiters.has(waitId)) {
          recordFileChooserOpened({
            tabId,
            selector: payload.selector,
            frameId: payload.frameId,
            mode: payload.mode,
            is_multiple: payload.is_multiple,
            accept: payload.accept,
            source: 'main_world_trap_timeout',
          });
          return;
        }
        cleanup();
        void sendCdpCommandWithTimeout({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false }, timeoutMs).catch(() => {});
        emitFileChooserTelemetry('wait.timeout', { tabId, timeoutMs, durationMs: Date.now() - startedAt });
        reject(new Error('file_chooser_timeout'));
      })();
    }, timeoutMs);
    pendingFileChooserWaiters.set(waitId, {
      tabId,
      startedAt,
      resolve: (event) => {
        cleanup();
        emitFileChooserTelemetry('wait.succeeded', { tabId, fileChooserId: event.file_chooser_id, durationMs: Date.now() - startedAt });
        resolve({
          success: true,
          tabId,
          file_chooser_id: event.file_chooser_id,
          is_multiple: event.is_multiple,
          mode: event.mode,
          backendNodeId: event.backendNodeId,
          frameId: event.frameId,
          elapsedMs: Date.now() - startedAt,
        });
      },
    });
    pollTimer = setInterval(() => {
      if (polling) return;
      polling = true;
      readFileChooserTrapPayload(tabId, startedAt, timeoutMs)
        .then((payload) => {
          if (!payload || !pendingFileChooserWaiters.has(waitId)) return;
          recordFileChooserOpened({
            tabId,
            selector: payload.selector,
            frameId: payload.frameId,
            mode: payload.mode,
            is_multiple: payload.is_multiple,
            accept: payload.accept,
            source: 'main_world_trap',
          });
        })
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, 50);
  });
}

export async function acceptFileChooser(action = {}) {
  const tabId = requireTabId(action, 'page.acceptFileChooser');
  const fileChooserId = String(action.fileChooserId || action.file_chooser_id || '').trim();
  if (!fileChooserId) throw new Error('page.acceptFileChooser requires file_chooser_id');
  const event = fileChooserEventsById.get(fileChooserId);
  if (!event) throw new Error(`Unknown file chooser ${fileChooserId}`);
  if (event.tabId !== tabId) throw new Error(`File chooser ${fileChooserId} belongs to tab ${event.tabId}, not ${tabId}`);
  const files = normalizeFiles(action);
  if (!event.is_multiple && files.length > 1) throw new Error(`File chooser ${fileChooserId} does not accept multiple files`);
  const timeoutMs = normalizeTimeout(action.timeoutMs ?? action.timeout_ms, CDP_COMMAND_TIMEOUT_MS);
  await attachCdpTab(tabId);
  const backendNodeId = event.backendNodeId || await resolveBackendNodeId(tabId, event.selector, timeoutMs);
  await sendCdpCommandWithTimeout({ tabId }, 'DOM.setFileInputFiles', {
    files,
    backendNodeId,
  }, timeoutMs);
  await dispatchFileInputEvents(tabId, backendNodeId, timeoutMs).catch(() => {});
  await sendCdpCommandWithTimeout({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false }, timeoutMs).catch(() => {});
  emitFileChooserTelemetry('accept.succeeded', { tabId, fileChooserId, fileCount: files.length });
  return {
    success: true,
    tabId,
    file_chooser_id: fileChooserId,
    is_multiple: event.is_multiple,
    backendNodeId,
    files,
    fileCount: files.length,
  };
}

export async function setInputFiles(action = {}) {
  const tabId = requireTabId(action, 'page.setInputFiles');
  const selector = String(action.selector || '').trim();
  if (!selector) throw new Error('page.setInputFiles requires selector');
  const files = normalizeFiles(action);
  const timeoutMs = normalizeTimeout(action.timeoutMs ?? action.timeout_ms, CDP_COMMAND_TIMEOUT_MS);
  await attachCdpTab(tabId);
  const backendNodeId = await resolveBackendNodeId(tabId, selector, timeoutMs);
  await sendCdpCommandWithTimeout({ tabId }, 'DOM.setFileInputFiles', { files, backendNodeId }, timeoutMs);
  await dispatchFileInputEvents(tabId, backendNodeId, timeoutMs).catch(() => {});
  emitFileChooserTelemetry('set_files.succeeded', { tabId, selector, fileCount: files.length });
  return {
    success: true,
    tabId,
    selector,
    backendNodeId,
    files,
    fileCount: files.length,
  };
}

export function handleFileChooserCdpEvent(source = {}, method = '', params = {}) {
  if (method !== 'Page.fileChooserOpened') return null;
  const tabId = Number(source.tabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  const backendNodeId = Number(params.backendNodeId || 0);
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;
  return recordFileChooserOpened({
    tabId,
    backendNodeId,
    frameId: String(params.frameId || ''),
    mode: String(params.mode || ''),
    is_multiple: String(params.mode || '').toLowerCase() === 'selectmultiple',
    source: 'cdp',
  });
}

export function handleFileChooserDomEvent(message = {}, sender = {}) {
  const tabId = Number(sender?.tab?.id || message.tabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  const selector = String(message.selector || '').trim();
  if (!selector) return null;
  return recordFileChooserOpened({
    tabId,
    selector,
    frameId: String(sender?.frameId ?? message.frameId ?? ''),
    mode: String(message.mode || (message.is_multiple ? 'selectMultiple' : 'selectSingle')),
    is_multiple: message.is_multiple === true || message.isMultiple === true,
    accept: String(message.accept || ''),
    source: 'dom_trap',
  });
}

function recordFileChooserOpened(details = {}) {
  const fileChooserId = createFileChooserId('chooser');
  const event = {
    file_chooser_id: fileChooserId,
    tabId: Number(details.tabId),
    backendNodeId: Number.isInteger(Number(details.backendNodeId)) ? Number(details.backendNodeId) : 0,
    selector: details.selector ? String(details.selector) : '',
    frameId: String(details.frameId || ''),
    mode: String(details.mode || ''),
    is_multiple: details.is_multiple === true,
    accept: details.accept ? String(details.accept) : '',
    source: details.source ? String(details.source) : 'unknown',
    openedAt: new Date().toISOString(),
  };
  fileChooserEventsById.set(fileChooserId, event);
  trimFileChooserEvents();
  for (const waiter of pendingFileChooserWaiters.values()) {
    if (waiter.tabId === event.tabId) {
      waiter.resolve(event);
      break;
    }
  }
  emitFileChooserTelemetry('opened', { tabId: event.tabId, fileChooserId, backendNodeId: event.backendNodeId, mode: event.mode, source: event.source });
  return event;
}

export function getFileChooserSnapshot() {
  return {
    pendingWaitCount: pendingFileChooserWaiters.size,
    pendingTabIds: [...new Set([...pendingFileChooserWaiters.values()].map((waiter) => waiter.tabId))].sort((a, b) => a - b),
    fileChooserIds: [...fileChooserEventsById.keys()],
    fileChoosers: [...fileChooserEventsById.values()],
    snapshotAt: new Date().toISOString(),
  };
}

async function resolveBackendNodeId(tabId, selector, timeoutMs) {
  if (!selector) throw new Error('File chooser event has no selector or backend node');
  const documentResult = await sendCdpCommandWithTimeout({ tabId }, 'DOM.getDocument', { depth: 1, pierce: true }, timeoutMs);
  const rootNodeId = documentResult?.root?.nodeId;
  if (!Number.isInteger(rootNodeId)) throw new Error('DOM.getDocument did not return root nodeId');
  const queryResult = await sendCdpCommandWithTimeout({ tabId }, 'DOM.querySelector', { nodeId: rootNodeId, selector }, timeoutMs);
  const nodeId = queryResult?.nodeId;
  if (!Number.isInteger(nodeId) || nodeId <= 0) throw new Error(`File input selector not found: ${selector}`);
  const describeResult = await sendCdpCommandWithTimeout({ tabId }, 'DOM.describeNode', { nodeId }, timeoutMs);
  const backendNodeId = describeResult?.node?.backendNodeId;
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) throw new Error(`File input selector did not resolve backend node: ${selector}`);
  return backendNodeId;
}

async function readFileChooserTrapPayload(tabId, startedAt, timeoutMs) {
  if (!chrome.scripting?.executeScript) return null;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (waitStartedAt) => {
      const payload = window.__xwowFileChooserTrapMain && window.__xwowFileChooserTrapMain.lastPayload;
      if (!payload || Number(payload.emittedAt || 0) < Number(waitStartedAt || 0)) return null;
      return payload;
    },
    args: [startedAt],
  });
  return result?.result || null;
}

async function installFileChooserTrap(tabId, timeoutMs) {
  if (!chrome.scripting?.executeScript) return;
  const expiresAt = Date.now() + Math.max(100, timeoutMs);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (nextExpiresAt) => {
      const state = window.__xwowFileChooserTrap || { installed: false, expiresAt: 0 };
      state.expiresAt = Math.max(Number(state.expiresAt || 0), Number(nextExpiresAt || 0));
      window.__xwowFileChooserTrap = state;
      if (state.installed) return;
      state.installed = true;
      const forwardFileChooser = (payload) => {
        void chrome.runtime.sendMessage({
          type: 'xwow-data-ai:file-chooser-opened',
          selector: payload.selector || '',
          is_multiple: payload.is_multiple === true,
          mode: payload.mode || (payload.is_multiple === true ? 'selectMultiple' : 'selectSingle'),
          accept: payload.accept || '',
        }).catch(() => {});
      };
      const escapeCss = (value) => {
        if (window.CSS?.escape) return window.CSS.escape(value);
        return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
      };
      const selectorForFileInput = (input) => {
        if (input.id) return `#${escapeCss(input.id)}`;
        if (input.getAttribute('name')) return `input[type="file"][name="${String(input.getAttribute('name')).replace(/"/g, '\\"')}"]`;
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        const index = Math.max(0, inputs.indexOf(input));
        return `input[type="file"]:nth-of-type(${index + 1})`;
      };
      document.addEventListener('click', (event) => {
        if (Date.now() > Number(window.__xwowFileChooserTrap?.expiresAt || 0)) return;
        const target = event.target;
        const input = target?.matches?.('input[type="file"]') ? target : target?.closest?.('input[type="file"]');
        if (!input) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        forwardFileChooser({
          selector: selectorForFileInput(input),
          is_multiple: input.multiple === true,
          mode: input.multiple === true ? 'selectMultiple' : 'selectSingle',
          accept: input.getAttribute('accept') || '',
        });
      }, true);
      window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.source !== 'xwow-data-ai:file-chooser-trap') return;
        if (Date.now() > Number(window.__xwowFileChooserTrap?.expiresAt || 0)) return;
        forwardFileChooser(data);
      });
      window.addEventListener('xwow-data-ai:file-chooser-trap', (event) => {
        if (Date.now() > Number(window.__xwowFileChooserTrap?.expiresAt || 0)) return;
        try {
          const data = JSON.parse(String(event.detail || '{}'));
          if (data.source !== 'xwow-data-ai:file-chooser-trap') return;
          forwardFileChooser(data);
        } catch {
          // Ignore malformed page bridge events.
        }
      });
      const readAttributePayload = () => {
        const raw = document.documentElement.getAttribute('data-xwow-file-chooser-payload') || '';
        if (!raw) return;
        try {
          const data = JSON.parse(raw);
          if (data.source !== 'xwow-data-ai:file-chooser-trap') return;
          if (Date.now() > Number(window.__xwowFileChooserTrap?.expiresAt || 0)) return;
          forwardFileChooser(data);
        } catch {
          // Ignore malformed page bridge attributes.
        }
      };
      const observer = new MutationObserver(readAttributePayload);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-xwow-file-chooser-payload'] });
      readAttributePayload();
    },
    args: [expiresAt],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (nextExpiresAt) => {
      const state = window.__xwowFileChooserTrapMain || { installed: false, expiresAt: 0 };
      state.expiresAt = Math.max(Number(state.expiresAt || 0), Number(nextExpiresAt || 0));
      window.__xwowFileChooserTrapMain = state;
      if (state.installed) return;
      state.installed = true;
      const originalClick = window.HTMLInputElement?.prototype?.click;
      if (typeof originalClick !== 'function') return;
      const escapeCss = (value) => {
        if (window.CSS?.escape) return window.CSS.escape(value);
        return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
      };
      const selectorForFileInput = (input) => {
        if (input.id) return `#${escapeCss(input.id)}`;
        if (input.getAttribute('name')) return `input[type="file"][name="${String(input.getAttribute('name')).replace(/"/g, '\\"')}"]`;
        const parent = input.parentElement || document;
        const inputs = [...parent.querySelectorAll('input[type="file"]')];
        const index = Math.max(0, inputs.indexOf(input));
        const parentSelector = parent.id ? `#${escapeCss(parent.id)}` : '';
        return `${parentSelector ? `${parentSelector} ` : ''}input[type="file"]:nth-of-type(${index + 1})`;
      };
      const postFileChooser = (input) => {
        const payload = {
          source: 'xwow-data-ai:file-chooser-trap',
          selector: selectorForFileInput(input),
          is_multiple: input.multiple === true,
          mode: input.multiple === true ? 'selectMultiple' : 'selectSingle',
          accept: input.getAttribute('accept') || '',
          emittedAt: Date.now(),
        };
        window.__xwowFileChooserTrapMain.lastPayload = payload;
        document.documentElement.setAttribute('data-xwow-file-chooser-payload', JSON.stringify(payload));
        window.dispatchEvent(new CustomEvent('xwow-data-ai:file-chooser-trap', { detail: JSON.stringify(payload) }));
        window.postMessage(payload, '*');
      };
      window.HTMLInputElement.prototype.click = function (...args) {
        if (this?.type === 'file' && Date.now() <= Number(window.__xwowFileChooserTrapMain?.expiresAt || 0)) {
          postFileChooser(this);
          return undefined;
        }
        return originalClick.apply(this, args);
      };
      document.addEventListener('click', (event) => {
        if (Date.now() > Number(window.__xwowFileChooserTrapMain?.expiresAt || 0)) return;
        const target = event.target;
        const input = target?.matches?.('input[type="file"]') ? target : target?.closest?.('input[type="file"]');
        if (!input) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        postFileChooser(input);
      }, true);
    },
    args: [expiresAt],
  });
}

async function dispatchFileInputEvents(tabId, backendNodeId, timeoutMs) {
  const resolved = await sendCdpCommandWithTimeout({ tabId }, 'DOM.resolveNode', { backendNodeId }, timeoutMs);
  const objectId = resolved?.object?.objectId;
  if (!objectId) return;
  await sendCdpCommandWithTimeout({ tabId }, 'Runtime.callFunctionOn', {
    objectId,
    awaitPromise: true,
    returnByValue: true,
    functionDeclaration: `function () {
      this.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return true;
    }`,
  }, timeoutMs);
}

function normalizeFiles(action = {}) {
  const value = action.files || action.filePaths || action.paths || action.path;
  const files = (Array.isArray(value) ? value : [value])
    .map((file) => String(file || '').trim())
    .filter(Boolean);
  if (!files.length) throw new Error('File chooser action requires files');
  return files;
}

function requireTabId(action = {}, actionName = 'file chooser action') {
  const tabId = Number(action.tabId || action.tab_id || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`${actionName} requires integer tabId`);
  return tabId;
}

function normalizeTimeout(value, fallback) {
  const timeoutMs = Number(value || fallback);
  return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : fallback;
}

async function withLocalTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('file_chooser_bridge_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createFileChooserId(prefix) {
  nextFileChooserId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextFileChooserId.toString(36)}`;
}

function trimFileChooserEvents() {
  const entries = [...fileChooserEventsById.entries()];
  if (entries.length <= FILE_CHOOSER_EVENT_LIMIT) return;
  for (const [id] of entries.slice(0, entries.length - FILE_CHOOSER_EVENT_LIMIT)) {
    fileChooserEventsById.delete(id);
  }
}

function emitFileChooserTelemetry(kind, payload = {}) {
  if (!onFileChooserTelemetry) return;
  const event = {
    kind,
    tabId: Number.isInteger(Number(payload.tabId)) ? Number(payload.tabId) : null,
    fileChooserId: payload.fileChooserId ? String(payload.fileChooserId) : '',
    backendNodeId: Number.isInteger(Number(payload.backendNodeId)) ? Number(payload.backendNodeId) : null,
    fileCount: Number.isInteger(Number(payload.fileCount)) ? Number(payload.fileCount) : null,
    timeoutMs: Number.isFinite(Number(payload.timeoutMs)) ? Number(payload.timeoutMs) : null,
    durationMs: Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null,
    mode: payload.mode ? String(payload.mode) : '',
    emittedAt: new Date().toISOString(),
  };
  void Promise.resolve(onFileChooserTelemetry(event)).catch(() => {});
}
