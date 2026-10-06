export const SIDE_PANEL_OPEN_WINDOW_IDS_KEY = 'redboxBrowserControlSidePanelOpenWindowIds';
export const TARGET_SIDE_PANEL_OPEN_WINDOW_IDS_KEY = 'codexSidePanelOpenWindowIds';
export const TOGGLE_SIDE_PANEL_COMMANDS = new Set(['open-redbox-side-panel', 'open-codex-side-panel']);

const openWindowIds = new Set();
let sidePanelEventPublisher = null;

export function configureSidePanelTelemetry(publisher) {
  sidePanelEventPublisher = typeof publisher === 'function' ? publisher : null;
}

export function registerSidePanelStatus() {
  chrome.sidePanel?.onOpened?.addListener((details) => {
    if (Number.isInteger(details?.windowId)) void setSidePanelOpen(details.windowId, true).catch(() => {});
  });
  chrome.sidePanel?.onClosed?.addListener((details) => {
    if (Number.isInteger(details?.windowId)) void setSidePanelOpen(details.windowId, false).catch(() => {});
  });
  chrome.commands?.onCommand?.addListener((command, tab) => {
    if (TOGGLE_SIDE_PANEL_COMMANDS.has(command)) {
      void toggleSidePanel(tab?.windowId).catch(() => {});
    }
  });
}

export async function restoreSidePanelStatus() {
  const stored = await chrome.storage.session?.get([SIDE_PANEL_OPEN_WINDOW_IDS_KEY, TARGET_SIDE_PANEL_OPEN_WINDOW_IDS_KEY]).catch(() => ({}));
  openWindowIds.clear();
  for (const id of normalizeWindowIds([
    ...(Array.isArray(stored?.[SIDE_PANEL_OPEN_WINDOW_IDS_KEY]) ? stored[SIDE_PANEL_OPEN_WINDOW_IDS_KEY] : []),
    ...(Array.isArray(stored?.[TARGET_SIDE_PANEL_OPEN_WINDOW_IDS_KEY]) ? stored[TARGET_SIDE_PANEL_OPEN_WINDOW_IDS_KEY] : []),
  ])) {
    openWindowIds.add(id);
  }
  await publishSidePanelEvent('status.restored', getSidePanelStatus());
  return getSidePanelStatus();
}

export function getSidePanelStatus(windowId = null) {
  const id = Number(windowId || 0);
  return {
    success: true,
    storageKeys: [SIDE_PANEL_OPEN_WINDOW_IDS_KEY, TARGET_SIDE_PANEL_OPEN_WINDOW_IDS_KEY],
    commandAliases: [...TOGGLE_SIDE_PANEL_COMMANDS],
    openWindowIds: [...openWindowIds],
    windowId: Number.isInteger(id) && id > 0 ? id : null,
    sidePanelOpen: Number.isInteger(id) && id > 0 ? openWindowIds.has(id) : openWindowIds.size > 0,
    checkedAt: new Date().toISOString(),
  };
}

export async function requireSidePanelOpen(windowId = null, options = {}) {
  await restoreSidePanelStatus();
  const status = getSidePanelStatus(windowId);
  if (!status.sidePanelOpen) {
    const error = new Error(options.closedError || 'Beav side panel is not open.');
    error.code = 'side_panel_not_open';
    error.status = status;
    throw error;
  }
  return status;
}

export async function openSidePanel(windowId = null) {
  const id = await resolveWindowId(windowId);
  if (!chrome.sidePanel?.open) throw new Error('Chrome sidePanel.open is unavailable');
  await chrome.sidePanel.open({ windowId: id });
  await setSidePanelOpen(id, true);
  return getSidePanelStatus(id);
}

export async function closeSidePanel(windowId = null) {
  const id = await resolveWindowId(windowId);
  if (!chrome.sidePanel?.close) throw new Error('Chrome sidePanel.close is unavailable');
  await chrome.sidePanel.close({ windowId: id });
  await setSidePanelOpen(id, false);
  return getSidePanelStatus(id);
}

export async function toggleSidePanel(windowId = null) {
  const id = await resolveWindowId(windowId);
  await restoreSidePanelStatus();
  return openWindowIds.has(id) ? await closeSidePanel(id) : await openSidePanel(id);
}

async function setSidePanelOpen(windowId, isOpen) {
  const id = Number(windowId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (isOpen) openWindowIds.add(id);
  else openWindowIds.delete(id);
  await persistSidePanelOpenWindowIds();
  await publishSidePanelEvent(isOpen ? 'side_panel.opened' : 'side_panel.closed', getSidePanelStatus(id));
}

async function persistSidePanelOpenWindowIds() {
  const ids = [...openWindowIds];
  await chrome.storage.session?.set({
    [SIDE_PANEL_OPEN_WINDOW_IDS_KEY]: ids,
    [TARGET_SIDE_PANEL_OPEN_WINDOW_IDS_KEY]: ids,
  }).catch(() => {});
}

async function resolveWindowId(windowId = null) {
  const id = Number(windowId || 0);
  if (Number.isInteger(id) && id > 0) return id;
  const current = await chrome.windows.getCurrent();
  if (!Number.isInteger(current?.id)) throw new Error('Unable to resolve current Chrome window');
  return current.id;
}

function normalizeWindowIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

async function publishSidePanelEvent(kind, status = {}) {
  if (!sidePanelEventPublisher) return null;
  try {
    return await sidePanelEventPublisher({
      kind,
      sidePanelOpen: status.sidePanelOpen === true,
      openWindowIds: Array.isArray(status.openWindowIds) ? status.openWindowIds : [],
      emittedBy: 'sidePanelStatus',
    });
  } catch {
    return null;
  }
}
