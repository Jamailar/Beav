const DEFAULT_POLL_INTERVAL_MS = 250;
const RETRYABLE_CLICK_PREPARATION_REASONS = new Set([
  'item_click_target_unavailable',
  'item_click_target_not_visible',
  'item_click_target_detached',
]);

export async function openSiteResearchItem(input = {}, deps = {}) {
  const sourceTabId = positiveInteger(input.tabId || input.sourceTabId);
  if (!sourceTabId) return failure('item_source_tab_missing', 'research item opening requires sourceTabId');
  if (typeof deps.getTab !== 'function'
    || typeof deps.listTabs !== 'function'
    || typeof deps.prepareItemClick !== 'function'
    || typeof deps.clickPoint !== 'function'
    || typeof deps.readSiteEvidence !== 'function') {
    return failure('item_open_runtime_unavailable', 'research item page-click dependencies are unavailable');
  }

  const sourceBefore = await deps.getTab(sourceTabId);
  if (!sourceBefore?.id) return failure('item_source_tab_unavailable', 'research source tab is unavailable');
  const beforeTabs = await deps.listTabs();
  const beforeTabIds = new Set((beforeTabs || []).map((tab) => Number(tab?.id)).filter(Number.isInteger));
  let prepared = unwrapContentDelivery(await deps.prepareItemClick(sourceTabId, input));
  let preparationAttempts = 1;
  if (prepared?.success !== true && RETRYABLE_CLICK_PREPARATION_REASONS.has(prepared?.reason)) {
    const refreshedItem = await refreshItemForClick(sourceTabId, input, deps);
    await delay(DEFAULT_POLL_INTERVAL_MS, deps);
    prepared = unwrapContentDelivery(await deps.prepareItemClick(sourceTabId, {
      ...input,
      item: refreshedItem || input.item,
      interactionRef: refreshedItem?.interactionRef || input.interactionRef,
    }));
    preparationAttempts += 1;
  }
  if (prepared?.success !== true) {
    return {
      ...failure(
        prepared?.reason || 'item_click_target_unavailable',
        prepared?.message || 'the selected social-media card cannot be clicked on the source page',
      ),
      itemId: prepared?.itemId || input.item?.id || '',
      sourceUrl: sourceBefore.url || '',
      preparationAttempts,
    };
  }
  const clickPoint = normalizeClickPoint(prepared.clickPoint);
  if (!clickPoint) {
    return failure('item_click_point_invalid', 'the selected social-media card did not return a valid click point');
  }

  await deps.clickPoint(sourceTabId, clickPoint);
  const timeoutMs = clampNumber(input.timeoutMs, 1_000, 60_000, 20_000);
  const pollIntervalMs = clampNumber(input.pollIntervalMs, 100, 1_000, DEFAULT_POLL_INTERVAL_MS);
  const startedAt = Date.now();
  let lastEvidence = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const tabs = await deps.listTabs().catch(() => []);
    const child = findNewChildTab(
      tabs,
      beforeTabIds,
      sourceTabId,
      prepared.observedUrl || input.item?.sourceUrl || '',
      prepared.itemId || input.item?.id || '',
    );
    if (child?.id) {
      if (typeof deps.claimTab === 'function') {
        try {
          await deps.claimTab(child.id, 'research_detail');
        } catch (error) {
          if (typeof deps.closeNewTab === 'function') {
            await deps.closeNewTab(child.id).catch(() => null);
          }
          return failure(
            'item_child_tab_claim_failed',
            String(error?.message || error || 'the clicked detail tab could not be claimed'),
          );
        }
      }
      if (typeof deps.waitForTabComplete === 'function') {
        await deps.waitForTabComplete(child.id, timeoutMs).catch(() => {});
      }
      const currentChild = await deps.getTab(child.id).catch(() => child) || child;
      return openedResult('new_tab', sourceBefore, currentChild, prepared, clickPoint);
    }

    const sourceCurrent = await deps.getTab(sourceTabId).catch(() => null);
    if (!sourceCurrent?.id) {
      return failure('item_source_tab_closed', 'research source tab closed while opening the selected item');
    }
    if (meaningfulUrlChanged(sourceBefore.url, sourceCurrent.url)) {
      if (typeof deps.waitForTabComplete === 'function') {
        await deps.waitForTabComplete(sourceTabId, timeoutMs).catch(() => {});
      }
      return openedResult('same_tab_route', sourceBefore, sourceCurrent, prepared, clickPoint);
    }

    lastEvidence = await readDetailEvidence(deps, sourceTabId, input);
    if (isDetailEvidence(lastEvidence)) {
      return openedResult('same_tab_overlay', sourceBefore, sourceCurrent, prepared, clickPoint);
    }
    await delay(pollIntervalMs, deps);
  }

  await recoverUnconfirmedOpen(sourceTabId, sourceBefore.url || '', deps);
  return {
    ...failure('item_open_timeout', 'the selected social-media card click produced no detail surface'),
    itemId: prepared.itemId || input.item?.id || '',
    sourceUrl: sourceBefore.url || '',
    observedUrl: prepared.observedUrl || '',
    lastPageState: lastEvidence?.pageState || null,
  };
}

async function refreshItemForClick(sourceTabId, input, deps) {
  try {
    const evidence = unwrapContentDelivery(await deps.readSiteEvidence(sourceTabId, {
      ...input,
      executionMode: 'extract',
    }));
    if (evidence?.success !== true || !Array.isArray(evidence.items)) return null;
    const interactionRef = input.interactionRef && typeof input.interactionRef === 'object'
      ? input.interactionRef
      : input.item?.interactionRef || {};
    const expectedId = String(interactionRef.itemId || input.item?.id || input.itemId || '').trim();
    const expectedUrl = String(interactionRef.sourceUrl || input.item?.sourceUrl || input.sourceUrl || '').trim();
    return evidence.items.find((item) => {
      const itemRef = item?.interactionRef || {};
      const itemId = String(itemRef.itemId || item?.id || '').trim();
      const itemUrl = String(itemRef.sourceUrl || item?.sourceUrl || item?.url || '').trim();
      return (expectedId && itemId === expectedId) || (expectedUrl && sameUrl(itemUrl, expectedUrl));
    }) || null;
  } catch {
    return null;
  }
}

export async function closeSiteResearchItem(input = {}, deps = {}) {
  const openState = input.openState && typeof input.openState === 'object' ? input.openState : {};
  const sourceTabId = positiveInteger(openState.sourceTabId || input.sourceTabId || input.tabId);
  const targetTabId = positiveInteger(openState.targetTabId || input.targetTabId || sourceTabId);
  const openedIn = String(openState.openedIn || input.openedIn || '').trim();
  if (!sourceTabId || !targetTabId || !openedIn) {
    return failure('item_close_state_invalid', 'research item cleanup requires the typed openState');
  }

  if (openedIn === 'new_tab') {
    if (typeof deps.closeTab !== 'function') {
      return failure('item_close_runtime_unavailable', 'research detail tab close dependency is unavailable');
    }
    await deps.closeTab(targetTabId);
    return { success: true, restored: true, method: 'close_tab', sourceTabId, targetTabId };
  }

  if (typeof deps.getTab !== 'function') {
    return failure('item_close_runtime_unavailable', 'research source-tab restore dependency is unavailable');
  }
  const sourceBeforeUrl = String(openState.sourceUrlBefore || '').trim();
  const requireListSurface = openedIn === 'same_tab_overlay';
  const preparedClose = typeof deps.prepareItemClose === 'function'
    ? unwrapContentDelivery(await deps.prepareItemClose(sourceTabId, input).catch(() => null))
    : null;
  if (preparedClose?.success === true && typeof deps.clickPoint === 'function') {
    const clickPoint = normalizeClickPoint(preparedClose.clickPoint);
    if (clickPoint) {
      await deps.clickPoint(sourceTabId, clickPoint);
      if (await waitForSourceRestored(sourceTabId, sourceBeforeUrl, input, deps, requireListSurface)) {
        return { success: true, restored: true, method: 'page_click', sourceTabId, targetTabId };
      }
    }
  }

  const current = await deps.getTab(sourceTabId).catch(() => null);
  if (meaningfulUrlChanged(sourceBeforeUrl, current?.url) && typeof deps.goBack === 'function') {
    await deps.goBack(sourceTabId).catch(() => null);
    if (await waitForSourceRestored(sourceTabId, sourceBeforeUrl, input, deps, requireListSurface)) {
      return { success: true, restored: true, method: 'history_back', sourceTabId, targetTabId };
    }
  }

  if (typeof deps.pressEscape === 'function') {
    await deps.pressEscape(sourceTabId).catch(() => null);
    if (await waitForSourceRestored(sourceTabId, sourceBeforeUrl, input, deps, requireListSurface)) {
      return { success: true, restored: true, method: 'escape', sourceTabId, targetTabId };
    }
  }

  return failure('item_close_failed', 'the social-media detail surface could not be closed back to its source page');
}

function openedResult(openedIn, sourceBefore, target, prepared, clickPoint) {
  const sourceTabId = Number(sourceBefore.id);
  const targetTabId = Number(target.id);
  return {
    success: true,
    openedIn,
    sourceTabId,
    targetTabId,
    sourceUrl: target.url || prepared.observedUrl || '',
    tab: normalizeTab(target),
    openState: {
      openedIn,
      sourceTabId,
      targetTabId,
      sourceUrlBefore: sourceBefore.url || '',
      observedCardUrl: prepared.observedUrl || '',
      itemId: prepared.itemId || '',
      clickPoint,
    },
  };
}

async function readDetailEvidence(deps, tabId, input) {
  try {
    return unwrapContentDelivery(await deps.readSiteEvidence(tabId, {
      ...input,
      operation: 'content_scan',
      researchOperation: 'content_scan',
      executionMode: 'extract',
    }));
  } catch {
    return null;
  }
}

function isDetailEvidence(value) {
  if (value?.success !== true || !value?.content || typeof value.content !== 'object') return false;
  const surface = String(value?.pageState?.surface || '').trim();
  return surface === 'detail' || surface === 'detail_overlay';
}

async function waitForSourceRestored(tabId, expectedUrl, input, deps, requireListSurface = false) {
  const timeoutMs = clampNumber(input.closeTimeoutMs, 500, 10_000, 3_000);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const current = await deps.getTab(tabId).catch(() => null);
    if (!current?.id) return false;
    if (!requireListSurface && sameUrl(expectedUrl, current.url)) return true;
    if (typeof deps.readSiteEvidence === 'function') {
      try {
        const evidence = unwrapContentDelivery(await deps.readSiteEvidence(tabId, {
          ...input,
          operation: input.operation || input.researchOperation || 'search',
          executionMode: 'extract',
        }));
        const surface = String(evidence?.pageState?.surface || '').trim();
        if (evidence?.success === true && (surface === 'search_results' || surface === 'entry')) return true;
      } catch {
        // The page may be between routes; continue the bounded restore wait.
      }
    }
    await delay(DEFAULT_POLL_INTERVAL_MS, deps);
  }
  return false;
}

function findNewChildTab(tabs, beforeTabIds, sourceTabId, observedUrl, itemId) {
  const candidates = (tabs || [])
    .filter((tab) => Number.isInteger(Number(tab?.id)) && !beforeTabIds.has(Number(tab.id)));
  const openerMatch = candidates.find((tab) => Number(tab?.openerTabId) === sourceTabId);
  if (openerMatch) return openerMatch;
  if (String(observedUrl || '').trim()) {
    const exactUrlMatch = candidates.find((tab) => sameUrl(observedUrl, tab?.pendingUrl || tab?.url));
    if (exactUrlMatch) return exactUrlMatch;
  }
  const normalizedItemId = String(itemId || '').trim();
  if (normalizedItemId) {
    const itemMatch = candidates.find((tab) => String(tab?.pendingUrl || tab?.url || '').includes(normalizedItemId));
    if (itemMatch) return itemMatch;
  }
  return null;
}

async function recoverUnconfirmedOpen(sourceTabId, sourceBeforeUrl, deps) {
  const current = await deps.getTab(sourceTabId).catch(() => null);
  if (meaningfulUrlChanged(sourceBeforeUrl, current?.url) && typeof deps.goBack === 'function') {
    await deps.goBack(sourceTabId).catch(() => null);
    return;
  }
  if (typeof deps.pressEscape === 'function') {
    await deps.pressEscape(sourceTabId).catch(() => null);
  }
}

function normalizeClickPoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, coordinateSpace: 'viewport' };
}

function meaningfulUrlChanged(before, after) {
  return Boolean(String(before || '').trim() && String(after || '').trim() && !sameUrl(before, after));
}

function sameUrl(left, right) {
  try {
    return new URL(String(left || '')).toString() === new URL(String(right || '')).toString();
  } catch {
    return String(left || '') === String(right || '');
  }
}

function unwrapContentDelivery(value) {
  if (value?.response && typeof value.response === 'object' && !Array.isArray(value.response)) {
    return value.response;
  }
  return value;
}

function normalizeTab(tab = {}) {
  return {
    id: Number(tab.id),
    windowId: Number.isInteger(Number(tab.windowId)) ? Number(tab.windowId) : null,
    openerTabId: Number.isInteger(Number(tab.openerTabId)) ? Number(tab.openerTabId) : null,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    active: tab.active === true,
  };
}

function failure(reason, message) {
  return { success: false, reason, message, retryable: false };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function delay(ms, deps) {
  if (typeof deps.delay === 'function') return deps.delay(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
