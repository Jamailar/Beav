import { ensureContentScript, pingContentScript } from './dynamicContentInjection.js';

export async function listPageFrames(action = {}) {
  const tabId = requireTabId(action);
  const prepare = action.prepareContentScript === true || action.prepare === true || action.injectIfMissing === true;
  const includeContentScriptState = action.includeContentScriptState !== false;
  const navFrames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => [{ frameId: 0, parentFrameId: -1, url: '' }]);
  const frames = Array.isArray(navFrames) && navFrames.length ? navFrames : [{ frameId: 0, parentFrameId: -1, url: '' }];
  const injectableFrames = frames.filter((frame) => isControllableFrameUrl(frame?.url));
  if (prepare && injectableFrames.length) {
    await mapWithConcurrency(injectableFrames, 4, async (frame) => {
      await ensureContentScript(tabId, { allFrames: false, frameId: Number(frame.frameId || 0) });
    });
  }
  const mapped = [];
  for (const frame of frames) {
    const frameId = Number(frame.frameId || 0);
    const contentScriptAvailable = includeContentScriptState ? await pingContentScript(tabId, frameId) : undefined;
    mapped.push({
      frameId,
      parentFrameId: Number.isInteger(frame.parentFrameId) ? frame.parentFrameId : -1,
      url: frame.url || '',
      errorOccurred: frame.errorOccurred === true,
      ...(includeContentScriptState ? { contentScriptAvailable } : {}),
    });
  }
  const foreignExtensionFrames = (await mapWithConcurrency(mapped, 4, async (frame) => await summarizeForeignExtensionFrame(frame)))
    .filter(Boolean);
  return {
    success: true,
    tabId,
    frameCount: mapped.length,
    preparedContentScript: prepare,
    includeContentScriptState,
    frames: mapped.sort((a, b) => a.frameId - b.frameId),
    foreignExtensionInterference: {
      detected: foreignExtensionFrames.length > 0,
      code: foreignExtensionFrames.length ? 'FOREIGN_EXTENSION_FRAME_INTERFERENCE' : null,
      count: foreignExtensionFrames.length,
      frames: foreignExtensionFrames,
    },
    snapshotAt: new Date().toISOString(),
  };
}

function isControllableFrameUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

async function summarizeForeignExtensionFrame(frame = {}) {
  const match = /^(?:chrome|edge|brave)-extension:\/\/([a-z0-9-]+)/i.exec(String(frame.url || ''));
  if (!match) return null;
  return {
    frameId: Number(frame.frameId || 0),
    parentFrameId: Number.isInteger(frame.parentFrameId) ? frame.parentFrameId : -1,
    extensionIdHash: await hashExtensionId(match[1]),
    contentScriptAvailable: frame.contentScriptAvailable === true,
  };
}

async function hashExtensionId(extensionId) {
  const source = new TextEncoder().encode(String(extensionId || ''));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', source);
    return `sha256:${Array.from(new Uint8Array(digest)).slice(0, 8).map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  let hash = 2166136261;
  for (const byte of source) hash = Math.imul(hash ^ byte, 16777619);
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

async function mapWithConcurrency(items, limit, mapper) {
  const source = Array.isArray(items) ? items : [];
  const results = new Array(source.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Number(limit) || 1), source.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < source.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(source[index], index);
    }
  }));
  return results;
}

function requireTabId(action = {}) {
  const tabId = Number(action.tabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('page.frames requires an integer tabId');
  return tabId;
}
