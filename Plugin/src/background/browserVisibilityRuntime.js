let visibilityEventPublisher = null;

export function configureBrowserVisibilityTelemetry(publisher) {
  visibilityEventPublisher = typeof publisher === 'function' ? publisher : null;
}

export async function getBrowserVisibility(action = {}) {
  const windowId = normalizeWindowId(action.windowId ?? action.window_id);
  const includeWindows = action.includeWindows === true || action.include_windows === true;
  const targetWindow = windowId
    ? await chrome.windows.get(windowId, { populate: false }).catch(() => null)
    : await chrome.windows.getCurrent({ populate: false }).catch(() => null);
  const windows = includeWindows
    ? await chrome.windows.getAll({ populate: false, windowTypes: normalizeWindowTypes(action.windowTypes || action.windowType || action.type) }).catch(() => [])
    : [];
  return {
    success: true,
    visibility: normalizeWindowVisibility(targetWindow),
    windows: windows.map(normalizeWindowVisibility),
    includeWindows,
    checkedAt: new Date().toISOString(),
  };
}

export async function setBrowserVisibility(action = {}) {
  const windowId = normalizeWindowId(action.windowId ?? action.window_id);
  const targetWindow = windowId
    ? await chrome.windows.get(windowId, { populate: false })
    : await chrome.windows.getCurrent({ populate: false });
  if (!Number.isInteger(targetWindow?.id)) throw new Error('Unable to resolve Chrome window for visibility action');
  const before = normalizeWindowVisibility(targetWindow);
  const update = buildWindowVisibilityUpdate(action);
  const updatedWindow = await applyWindowVisibilityUpdate(targetWindow.id, update);
  const afterWindow = await waitForWindowVisibility(targetWindow.id, update, updatedWindow);
  const after = normalizeWindowVisibility(afterWindow || updatedWindow);
  await publishBrowserVisibilityEvent('browser_visibility.updated', {
    windowId: targetWindow.id,
    requested: normalizeVisibilityRequest(action),
    before,
    after,
  });
  return {
    success: true,
    windowId: targetWindow.id,
    requested: normalizeVisibilityRequest(action),
    before,
    after,
    changedAt: new Date().toISOString(),
  };
}

function buildWindowVisibilityUpdate(action = {}) {
  const requestedState = normalizeRequestedWindowState(action.state || action.windowState || action.window_state);
  const visibleProvided = action.visible != null || action.visibility != null || action.hidden != null || action.minimized != null;
  const visible = action.hidden === true || action.minimized === true
    ? false
    : (action.visible != null ? action.visible !== false : action.visibility !== 'hidden');
  if (requestedState) {
    return compactUpdate({
      state: requestedState,
      focused: action.focus === true || action.focused === true ? true : undefined,
    });
  }
  if (visibleProvided && !visible) return { state: 'minimized' };
  return compactUpdate({
    state: 'normal',
    focused: action.focus === false || action.focused === false ? undefined : true,
  });
}

async function applyWindowVisibilityUpdate(windowId, update = {}) {
  if (update.state && update.focused === true && update.state !== 'minimized') {
    await chrome.windows.update(windowId, { state: update.state });
    return await chrome.windows.update(windowId, { focused: true });
  }
  return await chrome.windows.update(windowId, update);
}

async function waitForWindowVisibility(windowId, update = {}, fallbackWindow = null) {
  const expectedState = update.state || '';
  const expectedFocused = update.focused === true;
  let latest = fallbackWindow;
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    latest = await chrome.windows.get(windowId, { populate: false }).catch(() => latest);
    const visibility = normalizeWindowVisibility(latest);
    const stateOk = !expectedState || visibility?.state === expectedState;
    const focusOk = !expectedFocused || visibility?.focused === true;
    if (stateOk && focusOk) return latest;
    if (expectedState && visibility?.state !== expectedState) {
      await chrome.windows.update(windowId, { state: expectedState }).catch(() => {});
    } else if (expectedFocused && visibility?.focused !== true) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    }
    await sleep(100);
  }
  return await chrome.windows.get(windowId, { populate: false }).catch(() => latest);
}

function normalizeVisibilityRequest(action = {}) {
  return {
    visible: action.hidden === true || action.minimized === true ? false : (action.visible == null ? null : action.visible !== false),
    hidden: action.hidden === true,
    minimized: action.minimized === true,
    state: normalizeRequestedWindowState(action.state || action.windowState || action.window_state) || '',
    focus: action.focus === true || action.focused === true ? true : (action.focus === false || action.focused === false ? false : null),
  };
}

function normalizeWindowVisibility(window = null) {
  if (!window || typeof window !== 'object') return null;
  const state = String(window.state || '');
  return {
    windowId: Number.isInteger(window.id) ? window.id : null,
    state,
    focused: window.focused === true,
    visible: state !== 'minimized',
    minimized: state === 'minimized',
    type: window.type || '',
    top: Number.isInteger(window.top) ? window.top : null,
    left: Number.isInteger(window.left) ? window.left : null,
    width: Number.isInteger(window.width) ? window.width : null,
    height: Number.isInteger(window.height) ? window.height : null,
    alwaysOnTop: window.alwaysOnTop === true,
  };
}

function normalizeRequestedWindowState(value) {
  const state = String(value || '').trim();
  if (!state) return '';
  if (!['normal', 'minimized', 'maximized', 'fullscreen'].includes(state)) {
    throw new Error('browser.visibility.set requires state to be normal, minimized, maximized, or fullscreen');
  }
  return state;
}

function normalizeWindowTypes(value) {
  const requested = Array.isArray(value) ? value : (value ? [value] : ['normal']);
  const allowed = new Set(['normal', 'popup', 'panel', 'app', 'devtools']);
  const types = requested.map((item) => String(item || '').trim()).filter((item) => allowed.has(item));
  return types.length ? types : ['normal'];
}

function normalizeWindowId(value) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function compactUpdate(update = {}) {
  return Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishBrowserVisibilityEvent(kind, payload = {}) {
  if (!visibilityEventPublisher) return null;
  try {
    return await visibilityEventPublisher({
      kind,
      ...payload,
      emittedBy: 'browserVisibilityRuntime',
    });
  } catch {
    return null;
  }
}
