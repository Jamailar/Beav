import { getStoredMap, setStoredMap } from './storage.js';

export const TAB_GROUPS_KEY = 'xwowBrowserDataAiTabGroups';
const DEFAULT_SESSION_GROUP_TITLE = 'Beav';
const TAB_GROUP_COLORS = ['grey', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

let initialized = false;
let initializing = null;
let listenersRegistered = false;
const groupMetadata = new Map();
const sessionGroupTitles = new Map();
const groupIdsReconcilingPresentation = new Set();
let managedTabGroupEventPublisher = null;

export function configureManagedTabGroupTelemetry(publisher) {
  managedTabGroupEventPublisher = typeof publisher === 'function' ? publisher : null;
}

export async function initializeManagedTabGroups() {
  if (!chrome.tabGroups) return { success: true, initialized: false, reason: 'tabGroups unavailable' };
  if (!initializing) {
    registerManagedGroupListeners();
    initializing = loadManagedTabGroups()
      .then(refreshManagedGroupsFromChrome)
      .then(() => {
        initialized = true;
        return { success: true, initialized: true };
      });
  }
  return await initializing;
}

export async function ensureAgentTabGroup(sessionId, tabId, existingTabIds = []) {
  if (!chrome.tabGroups) return { success: false, grouped: false, reason: 'tabGroups unavailable' };
  await initializeManagedTabGroups();
  const id = normalizeTabId(tabId);
  if (!id) throw new Error('ensureAgentTabGroup requires tabId');
  const existing = await findManagedGroupContainingTabs(existingTabIds);
  if (existing) {
    const titleChanged = syncSessionTitle(existing, sessionId);
    await addTabToManagedGroup(existing, id);
    await reconcileGroupPresentation(existing.chromeGroupId);
    if (titleChanged) await saveManagedTabGroups();
    await publishManagedTabGroupEvent('group.reused', {
      sessionId,
      tabId: id,
      group: serializeManagedGroup(existing),
      titleChanged,
    });
    return { success: true, grouped: true, group: existing, reused: true };
  }
  const group = await createManagedGroup(id, sessionGroupTitles.get(sessionId));
  await reconcileGroupPresentation(group.chromeGroupId);
  await saveManagedTabGroups();
  await publishManagedTabGroupEvent('group.created', {
    sessionId,
    tabId: id,
    group: serializeManagedGroup(group),
  });
  return { success: true, grouped: true, group, reused: false };
}

export async function releaseTabsFromManagedGroups(tabIds = []) {
  if (!chrome.tabGroups) return { success: true, released: false, releasedTabIds: [], groupIds: [] };
  await initializeManagedTabGroups();
  const ids = normalizeTabIds(tabIds);
  if (!ids.length) return { success: true, released: false, releasedTabIds: [], groupIds: [] };
  const checked = await Promise.all(ids.map(async (tabId) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !Number.isInteger(tab.groupId) || tab.groupId < 0 || !groupMetadata.has(tab.groupId)) return null;
    return { tabId, groupId: tab.groupId };
  }));
  const releasedTabIds = checked.filter(Boolean).map((item) => item.tabId);
  const groupIds = [...new Set(checked.filter(Boolean).map((item) => item.groupId))];
  if (releasedTabIds.length && chrome.tabs.ungroup) {
    await Promise.allSettled(releasedTabIds.map((tabId) => chrome.tabs.ungroup(tabId)));
  }
  let changed = false;
  for (const groupId of groupIds) {
    changed = (await removeManagedGroupIfEmpty(groupId)) || changed;
  }
  if (changed) await saveManagedTabGroups();
  if (releasedTabIds.length) {
    await publishManagedTabGroupEvent('group.tabs.released', {
      releasedTabIds,
      groupIds,
      removedEmptyGroups: changed,
    });
  }
  return { success: true, released: releasedTabIds.length > 0, releasedTabIds, groupIds };
}

export async function refreshManagedGroupsFromChrome() {
  if (!chrome.tabGroups) return { success: true, refreshed: false };
  await loadManagedTabGroups();
  let changed = false;
  for (const groupId of [...groupMetadata.keys()]) {
    changed = (await removeManagedGroupIfEmpty(groupId)) || changed;
  }
  for (const groupId of [...groupMetadata.keys()]) {
    await reconcileGroupPresentation(groupId).catch(() => {});
  }
  if (changed) await saveManagedTabGroups();
  await publishManagedTabGroupEvent('groups.refreshed', {
    changed,
    groupCount: groupMetadata.size,
  });
  return { success: true, refreshed: true, changed };
}

export async function getManagedGroupIdContainingTabs(tabIds = []) {
  if (!chrome.tabGroups) return null;
  await initializeManagedTabGroups();
  return (await findManagedGroupContainingTabs(tabIds))?.chromeGroupId || null;
}

export async function reconcileManagedGroupForTabs(sessionId, groupId, tabIds = []) {
  if (!chrome.tabGroups) return { success: true, reconciled: false };
  await initializeManagedTabGroups();
  const id = Number(groupId);
  const group = groupMetadata.get(id);
  if (!group || !(await readGroup(id)) || !(await hasAnyTabInGroup(id, tabIds))) {
    return { success: true, reconciled: false };
  }
  const titleChanged = syncSessionTitle(group, sessionId);
  await reconcileGroupPresentation(id);
  if (titleChanged) await saveManagedTabGroups();
  await publishManagedTabGroupEvent('group.reconciled', {
    sessionId,
    groupId: id,
    tabIds: normalizeTabIds(tabIds),
    group: serializeManagedGroup(group),
    titleChanged,
  });
  return { success: true, reconciled: true, group };
}

export async function setSessionGroupTitle(sessionId, title, tabIds = []) {
  if (!chrome.tabGroups) return { success: true, updated: false };
  await initializeManagedTabGroups();
  const normalizedTitle = normalizeTitle(title);
  let changed = sessionGroupTitles.get(sessionId) !== normalizedTitle;
  if (normalizedTitle) {
    sessionGroupTitles.set(sessionId, normalizedTitle);
  } else {
    sessionGroupTitles.delete(sessionId);
  }
  const group = await findManagedGroupContainingTabs(tabIds);
  if (group) {
    changed = syncSessionTitle(group, sessionId) || changed;
    await reconcileGroupPresentation(group.chromeGroupId);
  }
  if (changed) await saveManagedTabGroups();
  if (changed) {
    await publishManagedTabGroupEvent('group.title.updated', {
      sessionId,
      title: normalizedTitle || '',
      tabIds: normalizeTabIds(tabIds),
      group: group ? serializeManagedGroup(group) : null,
    });
  }
  return { success: true, updated: changed, group: group || null };
}

export async function listManagedTabGroups() {
  await initializeManagedTabGroups();
  return {
    success: true,
    groups: [...groupMetadata.values()],
    sessionGroupTitles: Object.fromEntries(sessionGroupTitles.entries()),
  };
}

async function loadManagedTabGroups() {
  const stored = await getStoredMap(TAB_GROUPS_KEY);
  groupMetadata.clear();
  sessionGroupTitles.clear();
  const groups = Array.isArray(stored.groups) ? stored.groups : (Array.isArray(stored) ? stored : []);
  for (const group of groups) {
    const chromeGroupId = Number(group?.chromeGroupId);
    if (!Number.isInteger(chromeGroupId)) continue;
    groupMetadata.set(chromeGroupId, {
      chromeGroupId,
      presentationColor: normalizeColor(group.presentationColor),
      title: normalizeTitle(group.title),
    });
  }
  const titles = stored.sessionGroupTitles && typeof stored.sessionGroupTitles === 'object'
    ? stored.sessionGroupTitles
    : {};
  for (const [sessionId, title] of Object.entries(titles)) {
    const normalizedTitle = normalizeTitle(title);
    if (sessionId && normalizedTitle) sessionGroupTitles.set(sessionId, normalizedTitle);
  }
}

async function saveManagedTabGroups() {
  await setStoredMap(TAB_GROUPS_KEY, {
    groups: [...groupMetadata.values()],
    sessionGroupTitles: Object.fromEntries(sessionGroupTitles.entries()),
  });
}

async function createManagedGroup(tabId, title) {
  const chromeGroupId = await chrome.tabs.group({ tabIds: [tabId] });
  const group = {
    chromeGroupId,
    presentationColor: randomGroupColor(),
    title: normalizeTitle(title),
  };
  groupMetadata.set(chromeGroupId, group);
  return group;
}

async function addTabToManagedGroup(group, tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId !== group.chromeGroupId) {
    await chrome.tabs.group({ groupId: group.chromeGroupId, tabIds: tabId });
  }
}

function registerManagedGroupListeners() {
  if (listenersRegistered || !chrome.tabGroups) return;
  listenersRegistered = true;
  chrome.tabGroups.onCreated?.addListener((group) => {
    void handleObservedGroup(group).catch(() => {});
  });
  chrome.tabGroups.onUpdated?.addListener((group) => {
    void handleObservedGroup(group).catch(() => {});
  });
  chrome.tabGroups.onRemoved?.addListener((group) => {
    const groupId = Number(group?.id);
    if (Number.isInteger(groupId) && groupMetadata.delete(groupId)) {
      void saveManagedTabGroups().catch(() => {});
      void publishManagedTabGroupEvent('group.removed', {
        groupId,
        observedGroup: serializeChromeGroup(group),
      }).catch(() => {});
    }
  });
}

async function handleObservedGroup(group) {
  if (!groupMetadata.has(group.id)) return;
  await reconcileGroupPresentation(group.id, group);
  await publishManagedTabGroupEvent('group.observed', {
    groupId: Number(group.id),
    observedGroup: serializeChromeGroup(group),
    group: serializeManagedGroup(groupMetadata.get(group.id)),
  });
}

function syncSessionTitle(group, sessionId) {
  const title = sessionGroupTitles.get(sessionId) || DEFAULT_SESSION_GROUP_TITLE;
  if (group.title === title) return false;
  group.title = title;
  groupMetadata.set(group.chromeGroupId, group);
  return true;
}

async function reconcileGroupPresentation(groupId, observedGroup = null) {
  if (!chrome.tabGroups || groupIdsReconcilingPresentation.has(groupId)) return false;
  const group = groupMetadata.get(groupId);
  if (!group) return false;
  const observed = observedGroup || await readGroup(groupId);
  if (!observed) {
    groupMetadata.delete(groupId);
    await saveManagedTabGroups();
    return false;
  }
  groupIdsReconcilingPresentation.add(groupId);
  try {
    const title = group.title || DEFAULT_SESSION_GROUP_TITLE;
    const previousColor = group.presentationColor;
    const color = ensurePresentationColor(group);
    if (previousColor !== color) await saveManagedTabGroups();
    const update = { title, color, collapsed: false };
    await chrome.tabGroups.update(groupId, update).catch(() => {});
    groupMetadata.set(groupId, group);
    return true;
  } finally {
    groupIdsReconcilingPresentation.delete(groupId);
  }
}

async function findManagedGroupContainingTabs(tabIds = []) {
  const ids = normalizeTabIds(tabIds);
  for (const tabId of ids) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && groupMetadata.has(tab.groupId) && await readGroup(tab.groupId)) return groupMetadata.get(tab.groupId);
  }
  return null;
}

async function removeManagedGroupIfEmpty(groupId) {
  const id = Number(groupId);
  if (!Number.isInteger(id) || !groupMetadata.has(id)) return false;
  const tabs = await chrome.tabs.query({ groupId: id }).catch(() => []);
  if (tabs.length > 0) return false;
  groupMetadata.delete(id);
  return true;
}

async function hasAnyTabInGroup(groupId, tabIds = []) {
  for (const tabId of normalizeTabIds(tabIds)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.groupId === groupId) return true;
  }
  return false;
}

async function readGroup(groupId) {
  return await chrome.tabGroups?.get(Number(groupId)).catch(() => null);
}

function normalizeTabIds(value = []) {
  const values = Array.isArray(value) ? value : [value];
  const out = [];
  for (const candidate of values) {
    const id = normalizeTabId(candidate);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function normalizeTabId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeTitle(value) {
  if (typeof value !== 'string') return undefined;
  const title = value.trim();
  return title ? title.slice(0, 80) : undefined;
}

function normalizeColor(value) {
  return TAB_GROUP_COLORS.includes(value) ? value : undefined;
}

function ensurePresentationColor(group) {
  const color = normalizeColor(group.presentationColor) || randomGroupColor();
  group.presentationColor = color;
  return color;
}

function randomGroupColor() {
  return TAB_GROUP_COLORS[Math.floor(Math.random() * TAB_GROUP_COLORS.length)] || TAB_GROUP_COLORS[0];
}

async function publishManagedTabGroupEvent(kind, payload = {}) {
  if (!managedTabGroupEventPublisher) return null;
  try {
    return await managedTabGroupEventPublisher({
      kind,
      ...payload,
      emittedBy: 'tabGroupManager',
    });
  } catch {
    return null;
  }
}

function serializeManagedGroup(group) {
  if (!group) return null;
  return {
    chromeGroupId: Number(group.chromeGroupId),
    title: group.title || '',
    presentationColor: group.presentationColor || '',
  };
}

function serializeChromeGroup(group) {
  if (!group) return null;
  return {
    id: Number(group.id),
    title: group.title || '',
    color: group.color || '',
    windowId: Number.isInteger(group.windowId) ? group.windowId : null,
  };
}
