import { ensureContentScript, pingContentScript } from './dynamicContentInjection.js';

export async function listPageFrames(action = {}) {
  const tabId = requireTabId(action);
  const prepare = action.prepareContentScript === true || action.prepare === true || action.injectIfMissing === true;
  const includeContentScriptState = action.includeContentScriptState !== false;
  const navFrames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => [{ frameId: 0, parentFrameId: -1, url: '' }]);
  const frames = Array.isArray(navFrames) && navFrames.length ? navFrames : [{ frameId: 0, parentFrameId: -1, url: '' }];
  if (prepare) await ensureContentScript(tabId, { allFrames: true, frameId: 0 });
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
  return {
    success: true,
    tabId,
    frameCount: mapped.length,
    preparedContentScript: prepare,
    includeContentScriptState,
    frames: mapped.sort((a, b) => a.frameId - b.frameId),
    snapshotAt: new Date().toISOString(),
  };
}

function requireTabId(action = {}) {
  const tabId = Number(action.tabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('page.frames requires an integer tabId');
  return tabId;
}
