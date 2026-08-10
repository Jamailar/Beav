export const BROWSER_CONTROL_STATE_REVISION_KEY = 'xwowBrowserDataAiStateRevision';

let browserControlMutationQueue = Promise.resolve();

export async function getStoredMap(key) {
  const storage = browserStateStorage();
  const result = await storage.get(key);
  return normalizeStoredMap(result?.[key]);
}

export async function setStoredMap(key, value) {
  const storage = browserStateStorage();
  await storage.set({ [key]: normalizeStoredMap(value) });
}

/**
 * Serializes mutations that jointly own browser-session and tab-lease state.
 *
 * Chrome storage does not provide compare-and-swap. The service worker can be
 * resumed while two independent events are both doing read/modify/write, so
 * callers that modify browser control truth must use this function instead of
 * separately calling getStoredMap()/setStoredMap(). The reducer receives owned
 * JSON snapshots and must be synchronous: no Chrome API, network, file IO or
 * other await may run while the mutation lane is held.
 */
export async function mutateBrowserControlState(keys, reducer) {
  const requestedKeys = normalizeMutationKeys(keys);
  if (typeof reducer !== 'function') throw new Error('mutateBrowserControlState requires a reducer function');
  const run = async () => {
    const storage = browserStateStorage();
    const stored = await storage.get([...requestedKeys, BROWSER_CONTROL_STATE_REVISION_KEY]);
    const maps = Object.fromEntries(requestedKeys.map((key) => [key, normalizeStoredMap(stored?.[key])]));
    const currentRevision = normalizeStateRevision(stored?.[BROWSER_CONTROL_STATE_REVISION_KEY]);
    const result = reducer(maps, {
      currentRevision,
      keys: requestedKeys,
    });
    if (result && typeof result.then === 'function') {
      throw new Error('mutateBrowserControlState reducer must be synchronous');
    }
    const stateRevision = currentRevision + 1;
    await storage.set({
      ...maps,
      [BROWSER_CONTROL_STATE_REVISION_KEY]: stateRevision,
    });
    return { result, stateRevision };
  };
  const queued = browserControlMutationQueue.then(run, run);
  browserControlMutationQueue = queued.then(() => undefined, () => undefined);
  return await queued;
}

export async function getBrowserControlStateRevision() {
  const storage = browserStateStorage();
  const result = await storage.get(BROWSER_CONTROL_STATE_REVISION_KEY);
  return normalizeStateRevision(result?.[BROWSER_CONTROL_STATE_REVISION_KEY]);
}

export async function waitForBrowserControlMutations() {
  await browserControlMutationQueue;
}

function browserStateStorage() {
  return chrome.storage.session || chrome.storage.local;
}

function normalizeStoredMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeMutationKeys(keys) {
  const source = Array.isArray(keys) ? keys : [keys];
  const normalized = [...new Set(source.map((key) => String(key || '').trim()).filter(Boolean))];
  if (!normalized.length) throw new Error('mutateBrowserControlState requires at least one storage key');
  if (normalized.includes(BROWSER_CONTROL_STATE_REVISION_KEY)) {
    throw new Error(`${BROWSER_CONTROL_STATE_REVISION_KEY} is managed by mutateBrowserControlState`);
  }
  return normalized;
}

function normalizeStateRevision(value) {
  const revision = Number(value || 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}
