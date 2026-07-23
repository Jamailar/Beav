const TARGET_CONTENT_PING_TYPE = 'CONTENT_PING';
const CONTENT_PING_TYPE = 'xwow-data-ai:content-ping';
const CONTENT_PING_TYPES = [TARGET_CONTENT_PING_TYPE, CONTENT_PING_TYPE];
const CONTENT_SCRIPT_FILES = ['browserControlContent.js'];
const injectionPromises = new Map();
let contentInjectionEventPublisher = null;

export function configureDynamicContentInjectionTelemetry(publisher) {
  contentInjectionEventPublisher = typeof publisher === 'function' ? publisher : null;
}

export async function sendContentMessage(tabId, type, options = {}, frameId = 0, delivery = {}) {
  const id = Number(tabId);
  const targetFrameId = Number(frameId || 0);
  const startedAt = Date.now();
  await publishContentInjectionEvent('message.started', {
    tabId: id,
    frameId: targetFrameId,
    messageType: String(type || ''),
    injectIfMissing: delivery.injectIfMissing !== false,
  });
  let prepared;
  try {
    prepared = await prepareContentScript(id, {
      allFrames: delivery.allFrames === true,
      frameId: targetFrameId,
      injectIfMissing: delivery.injectIfMissing !== false,
    });
  } catch (error) {
    await publishContentInjectionEvent('message.failed', {
      tabId: id,
      frameId: targetFrameId,
      messageType: String(type || ''),
      durationMs: Date.now() - startedAt,
      phase: 'prepare',
      error: describeChromeError(error),
    });
    throw error;
  }
  if (!prepared.available) {
    await publishContentInjectionEvent('message.failed', {
      tabId: id,
      frameId: targetFrameId,
      messageType: String(type || ''),
      durationMs: Date.now() - startedAt,
      phase: 'prepare',
      error: prepared.error || 'content_script_unavailable',
      prepared,
    });
    return {
      success: false,
      tabId: id,
      prepared,
      response: {
        success: false,
        error: prepared.error || 'content_script_unavailable',
      },
    };
  }
  const sendPromise = chrome.tabs.sendMessage(id, {
    type,
    options,
  }, { frameId: targetFrameId }).catch((error) => ({ success: false, error: describeChromeError(error) }));
  await publishContentInjectionEvent('message.sent', {
    tabId: id,
    frameId: targetFrameId,
    messageType: type,
    prepared,
  });
  const response = await sendPromise;
  const eventKind = response?.success === true ? 'message.completed' : 'message.failed';
  await publishContentInjectionEvent(eventKind, {
    tabId: id,
    frameId: targetFrameId,
    messageType: String(type || ''),
    durationMs: Date.now() - startedAt,
    phase: 'handler',
    success: response?.success === true,
    error: response?.error || '',
    reason: response?.reason || '',
    message: response?.message || '',
    prepared,
  });
  return { success: Boolean(response?.success), tabId: id, prepared, response };
}

export async function prepareContentScript(tabId, options = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('content script requires a valid tabId');
  const frameId = Number(options.frameId || 0);
  const injectAllFrames = options.allFrames === true;
  if (!injectAllFrames && await pingContentScript(id, frameId)) {
    await publishContentInjectionEvent('prepare.pinged', { tabId: id, frameId, injected: false, available: true });
    return { success: true, available: true, injected: false, pinged: true, tabId: id, frameId };
  }
  if (options.injectIfMissing === false) {
    await publishContentInjectionEvent('prepare.missing', { tabId: id, frameId, injected: false, available: false });
    return {
      success: true,
      available: false,
      injected: false,
      pinged: false,
      tabId: id,
      frameId,
      error: 'content_script_not_present',
    };
  }
  await ensureContentScript(id, { ...options, frameId });
  await publishContentInjectionEvent('prepare.injected', { tabId: id, frameId, injected: true, available: true });
  return { success: true, available: true, injected: true, pinged: true, tabId: id, frameId };
}

export async function ensureContentScript(tabId, options = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('content script requires a valid tabId');
  const frameId = Number(options.frameId || 0);
  const injectAllFrames = options.allFrames === true;
  if (!injectAllFrames && await pingContentScript(id, frameId)) return true;
  const key = injectAllFrames ? `${id}:all` : `${id}:${frameId}`;
  let injection = injectionPromises.get(key);
  if (!injection) {
    injection = injectContentScript(id, { ...options, frameId });
    injectionPromises.set(key, injection);
    injection.finally(() => injectionPromises.delete(key));
    void publishContentInjectionEvent('inject.started', {
      tabId: id,
      frameId,
      allFrames: injectAllFrames,
      key,
      files: CONTENT_SCRIPT_FILES,
    }).catch(() => {});
  }
  try {
    await injection;
    await publishContentInjectionEvent('inject.completed', {
      tabId: id,
      frameId,
      allFrames: injectAllFrames,
      key,
      files: CONTENT_SCRIPT_FILES,
    });
  } catch (error) {
    await publishContentInjectionEvent('inject.failed', {
      tabId: id,
      frameId,
      allFrames: injectAllFrames,
      key,
      error: describeChromeError(error),
    });
    throw error;
  }
  if (await pingContentScript(id, frameId)) return true;
  throw new Error(`content_script_unavailable: ${id}:${frameId}`);
}

export async function pingContentScript(tabId, frameId = 0) {
  for (const type of CONTENT_PING_TYPES) {
    try {
      const response = await chrome.tabs.sendMessage(Number(tabId), { type }, { frameId: Number(frameId || 0) });
      if (response?.ok === true || response?.success === true) return true;
    } catch {
      // Try the next ping alias before declaring the content script missing.
    }
  }
  return false;
}

async function injectContentScript(tabId, options = {}) {
  const frameId = Number(options.frameId || 0);
  const target = options.allFrames === true
    ? { tabId, allFrames: true }
    : frameId > 0
      ? { tabId, frameIds: [frameId] }
      : { tabId };
  await chrome.scripting.executeScript({
    target,
    files: CONTENT_SCRIPT_FILES,
    injectImmediately: true,
  });
}

async function publishContentInjectionEvent(kind, payload = {}) {
  if (!contentInjectionEventPublisher) return null;
  try {
    return await contentInjectionEventPublisher({
      kind,
      ...payload,
      emittedBy: 'dynamicContentInjection',
    });
  } catch {
    return null;
  }
}

function describeChromeError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
