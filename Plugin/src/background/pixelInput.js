import { DANGEROUS_ACTION_TEXT, browserPolicyError } from './browserPolicy.js';
import { attachCdpTab, getDefaultCdpTimeoutMs, sendCdpCommandWithTimeout } from './cdpTransport.js';
import { sendContentMessage } from './dynamicContentInjection.js';

export const CONTENT_CURSOR_MOVE_TYPE = 'xwow-data-ai:cursor-move';
export const CONTENT_CURSOR_HIDE_TYPE = 'xwow-data-ai:cursor-hide';
export const CONTENT_CURSOR_ARRIVED_TYPE = 'xwow-data-ai:cursor-arrived';
export const TARGET_CURSOR_STATE_TYPE = 'AGENT_CURSOR_STATE';
export const TARGET_CURSOR_ARRIVED_TYPE = 'AGENT_CURSOR_ARRIVED';
export const TARGET_GET_CURSOR_STATE_TYPE = 'GET_AGENT_CURSOR_STATE';

const CDP_COMMAND_TIMEOUT_MS = getDefaultCdpTimeoutMs();
const pendingCursorArrivals = new Map();
const cursorStateByTabId = new Map();

let nextCursorMoveSequence = 0;
let onPixelInputTelemetry = null;

export function configurePixelInputTelemetry(handler) {
  if (typeof handler === 'function') onPixelInputTelemetry = handler;
}

export async function dispatchMouseMove(action = {}, options = {}) {
  const startedAt = Date.now();
  const tabId = requireTabId(action, options.activeTabId, 'input.mouseMove');
  requireFinitePoint(action, 'input.mouseMove');
  emitPixelInputTelemetry('input.started', { actionType: 'input.mouseMove', tabId, input: pointFromAction(action) });
  const tabContext = await focusTabForPixelInput(tabId);
  await attachCdpTab(tabId);
  const point = await normalizePixelInputPoint(tabId, action, tabContext, 'input.mouseMove');
  const moveSequence = createCursorMoveSequence();
  const params = {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    modifiers: modifierMaskFromAction(action),
  };
  await publishCursorState(tabId, { ...action, x: point.x, y: point.y }, options, true, moveSequence).catch(() => {});
  const arrival = action.waitForArrival === false ? null : waitForCursorArrival(moveSequence, Number(action.arrivalTimeoutMs || 1500), options.session || action);
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchMouseEvent', params, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  if (arrival) await arrival.catch(() => null);
  emitPixelInputTelemetry('input.succeeded', {
    actionType: 'input.mouseMove',
    tabId,
    point,
    moveSequence,
    durationMs: Date.now() - startedAt,
  });
  return { success: true, tabId, x: params.x, y: params.y, input: point.input, coordinateSpace: point.coordinateSpace, wasClamped: point.wasClamped, moveSequence };
}

export async function dispatchMouseClick(action = {}, options = {}) {
  const startedAt = Date.now();
  const tabId = requireTabId(action, options.activeTabId, 'input.mouseClick');
  requireFinitePoint(action, 'input.mouseClick');
  emitPixelInputTelemetry('input.started', { actionType: 'input.mouseClick', tabId, input: pointFromAction(action) });
  const tabContext = await focusTabForPixelInput(tabId);
  await attachCdpTab(tabId);
  const point = await normalizePixelInputPoint(tabId, action, tabContext, 'input.mouseClick');
  const x = point.x;
  const y = point.y;
  const button = action.button || 'left';
  const clickCount = clamp(Number(action.clickCount || 1), 1, 3);
  const modifiers = modifierMaskFromAction(action);
  const base = { x, y, button, clickCount, modifiers };
  const moveSequence = createCursorMoveSequence();
  const arrival = action.waitForArrival === false ? null : waitForCursorArrival(moveSequence, Number(action.arrivalTimeoutMs || 1500), options.session || action);
  await publishCursorState(tabId, { ...action, x, y }, options, true, moveSequence).catch(() => {});
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers }, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  if (arrival) await arrival.catch(() => null);
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  await sleep(Number(action.holdMs || 30));
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  emitPixelInputTelemetry('input.succeeded', {
    actionType: 'input.mouseClick',
    tabId,
    point,
    button,
    clickCount,
    moveSequence,
    durationMs: Date.now() - startedAt,
  });
  return { success: true, tabId, x, y, input: point.input, coordinateSpace: point.coordinateSpace, wasClamped: point.wasClamped, button, clickCount, moveSequence };
}

export async function dispatchMouseDrag(action = {}, options = {}) {
  const startedAt = Date.now();
  const tabId = requireTabId(action, options.activeTabId, 'input.mouseDrag');
  const dragPoints = normalizeDragActionPoints(action);
  emitPixelInputTelemetry('input.started', { actionType: 'input.mouseDrag', tabId, input: { x: dragPoints.from.x, y: dragPoints.from.y } });
  const tabContext = await focusTabForPixelInput(tabId);
  await attachCdpTab(tabId);
  const from = await normalizePixelInputPoint(tabId, { ...action, x: dragPoints.from.x, y: dragPoints.from.y }, tabContext, 'input.mouseDrag');
  const to = await normalizePixelInputPoint(tabId, { ...action, x: dragPoints.to.x, y: dragPoints.to.y }, tabContext, 'input.mouseDrag');
  const button = action.button || 'left';
  const modifiers = modifierMaskFromAction(action);
  const steps = clamp(Math.floor(Number(action.steps || 8)), 2, 80);
  const timeoutMs = Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS);
  const moveSequence = createCursorMoveSequence();
  const arrival = action.waitForArrival === false ? null : waitForCursorArrival(moveSequence, Number(action.arrivalTimeoutMs || 1500), options.session || action);
  await publishCursorState(tabId, { ...action, x: to.x, y: to.y }, options, true, moveSequence).catch(() => {});
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, modifiers }, timeoutMs);
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button, buttons: mouseButtonMask(button), clickCount: 1, modifiers }, timeoutMs);
  await sleep(Number(action.holdMs || 30));
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const x = from.x + ((to.x - from.x) * progress);
    const y = from.y + ((to.y - from.y) * progress);
    await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button, buttons: mouseButtonMask(button), modifiers }, timeoutMs);
    await sleep(Number(action.stepDelayMs || 16));
  }
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button, buttons: 0, clickCount: 1, modifiers }, timeoutMs);
  if (arrival) await arrival.catch(() => null);
  emitPixelInputTelemetry('input.succeeded', {
    actionType: 'input.mouseDrag',
    tabId,
    point: to,
    button,
    moveSequence,
    durationMs: Date.now() - startedAt,
  });
  return {
    success: true,
    tabId,
    from: { x: from.x, y: from.y, input: from.input, wasClamped: from.wasClamped },
    to: { x: to.x, y: to.y, input: to.input, wasClamped: to.wasClamped },
    coordinateSpace: to.coordinateSpace,
    button,
    steps,
    moveSequence,
  };
}

export async function dispatchMouseWheel(action = {}, options = {}) {
  const startedAt = Date.now();
  const tabId = requireTabId(action, options.activeTabId, 'input.mouseWheel');
  const deltaX = Number(action.deltaX || 0);
  const deltaY = Number(action.deltaY ?? action.delta ?? action.pixels ?? 0);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) {
    throw new Error('input.mouseWheel requires a finite non-zero deltaX or deltaY');
  }
  emitPixelInputTelemetry('input.started', { actionType: 'input.mouseWheel', tabId, deltaX, deltaY });
  const tabContext = await focusTabForPixelInput(tabId);
  await attachCdpTab(tabId);
  const point = await resolveWheelPoint(tabId, action, tabContext);
  const timeoutMs = Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS);
  const modifiers = modifierMaskFromAction(action);
  const params = {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
    modifiers,
  };
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchMouseEvent', params, timeoutMs);
  emitPixelInputTelemetry('input.succeeded', {
    actionType: 'input.mouseWheel',
    tabId,
    point,
    deltaX,
    deltaY,
    durationMs: Date.now() - startedAt,
  });
  return {
    success: true,
    tabId,
    x: point.x,
    y: point.y,
    input: point.input,
    coordinateSpace: point.coordinateSpace,
    wasClamped: point.wasClamped,
    deltaX,
    deltaY,
  };
}

export async function dispatchKeyboardType(action = {}, options = {}) {
  const startedAt = Date.now();
  const tabId = requireTabId(action, options.activeTabId, 'input.keyboardType');
  const text = String(action.text || '');
  if (!text) return { success: true, tabId, textLength: 0 };
  if (DANGEROUS_ACTION_TEXT.test(text)) throw browserPolicyError('denied_dangerous_action', action);
  emitPixelInputTelemetry('input.started', { actionType: 'input.keyboardType', tabId, textLength: text.length });
  await focusTabForPixelInput(tabId);
  await attachCdpTab(tabId);
  await sendCdpCommandWithTimeout({ tabId }, 'Input.insertText', { text }, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  emitPixelInputTelemetry('input.succeeded', {
    actionType: 'input.keyboardType',
    tabId,
    textLength: text.length,
    durationMs: Date.now() - startedAt,
  });
  return { success: true, tabId, textLength: text.length };
}

export async function dispatchKeyboardPress(action = {}, options = {}) {
  const startedAt = Date.now();
  const tabId = requireTabId(action, options.activeTabId, 'input.keyboardPress');
  const key = String(action.key || action.code || '');
  if (!key) throw new Error('input.keyboardPress requires key');
  emitPixelInputTelemetry('input.started', { actionType: 'input.keyboardPress', tabId, key });
  await focusTabForPixelInput(tabId);
  await attachCdpTab(tabId);
  const params = {
    key,
    code: String(action.code || key),
    windowsVirtualKeyCode: Number(action.windowsVirtualKeyCode || action.keyCode || 0) || undefined,
    nativeVirtualKeyCode: Number(action.nativeVirtualKeyCode || action.keyCode || 0) || undefined,
    modifiers: modifierMaskFromAction(action),
  };
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', { ...params, type: 'rawKeyDown' }, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' }, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  emitPixelInputTelemetry('input.succeeded', { actionType: 'input.keyboardPress', tabId, key, durationMs: Date.now() - startedAt });
  return { success: true, tabId, key };
}

export async function dispatchKeyboardCombo(action = {}, options = {}) {
  const startedAt = Date.now();
  const tabId = requireTabId(action, options.activeTabId, 'input.keyboardCombo');
  const parsed = parseKeyboardCombo(action);
  if (!parsed.key) throw new Error('input.keyboardCombo requires key or combo');
  emitPixelInputTelemetry('input.started', {
    actionType: 'input.keyboardCombo',
    tabId,
    key: parsed.combo,
  });
  await focusTabForPixelInput(tabId);
  await attachCdpTab(tabId);
  if (action.selector || action.focusSelector) await focusElementForKeyboardCombo(tabId, action.selector || action.focusSelector, action);
  const timeoutMs = Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS);
  const modifiers = modifierMask(parsed.modifiers);
  for (const modifier of parsed.modifiers) {
    await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', {
      ...keyEventParams(modifier),
      type: 'rawKeyDown',
      modifiers: modifierMask(parsed.modifiers.slice(0, parsed.modifiers.indexOf(modifier) + 1)),
    }, timeoutMs);
  }
  const keyParams = keyEventParams(parsed.key);
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', { ...keyParams, type: 'rawKeyDown', modifiers, ...(parsed.commands.length ? { commands: parsed.commands } : {}) }, timeoutMs);
  await sleep(Number(action.holdMs || 30));
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', { ...keyParams, type: 'keyUp', modifiers }, timeoutMs);
  for (const modifier of [...parsed.modifiers].reverse()) {
    const remaining = parsed.modifiers.filter((item) => item !== modifier);
    await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', {
      ...keyEventParams(modifier),
      type: 'keyUp',
      modifiers: modifierMask(remaining),
    }, timeoutMs);
  }
  emitPixelInputTelemetry('input.succeeded', {
    actionType: 'input.keyboardCombo',
    tabId,
    key: parsed.combo,
    durationMs: Date.now() - startedAt,
  });
  return { success: true, tabId, combo: parsed.combo, key: parsed.key, modifiers: parsed.modifiers };
}

export async function moveCursorOverlay(action = {}, options = {}) {
  const startedAt = Date.now();
  const tabId = requireTabId(action, options.activeTabId, 'cursor.move');
  requireFinitePoint(action, 'cursor.move');
  emitPixelInputTelemetry('cursor.move.started', { actionType: 'cursor.move', tabId, input: pointFromAction(action) });
  const moveSequence = createCursorMoveSequence();
  const arrival = action.waitForArrival === false ? null : waitForCursorArrival(moveSequence, Number(action.arrivalTimeoutMs || 1500), options.session || action);
  const result = await publishCursorState(tabId, action, options, true, moveSequence, action.frameId || 0);
  if (arrival) await arrival.catch(() => null);
  emitPixelInputTelemetry('cursor.move.succeeded', { actionType: 'cursor.move', tabId, moveSequence, durationMs: Date.now() - startedAt });
  return { ...result, moveSequence };
}

export async function hideCursorOverlay(action = {}, options = {}) {
  const tabId = requireTabId(action, options.activeTabId, 'cursor.hide');
  const result = await publishCursorState(tabId, action, options, false, null, action.frameId || 0);
  emitPixelInputTelemetry('cursor.hidden', { actionType: 'cursor.hide', tabId });
  return result;
}

export async function clearCursorOverlayForTab(tabId, reason = 'clear_cursor_overlay') {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, cleared: false, error: 'clear cursor requires tabId' };
  const previous = cursorStateByTabId.get(id) || {};
  const state = buildCursorState(id, {
    sessionId: previous.sessionId || '',
    turnId: previous.turnId || '',
    label: previous.label || 'RedBox',
  }, {}, false, null);
  cursorStateByTabId.delete(id);
  const response = await sendContentMessage(id, TARGET_CURSOR_STATE_TYPE, { state, reason }, 0).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  emitPixelInputTelemetry('cursor.cleared', { tabId: id, reason, success: response?.success !== false });
  return { success: true, cleared: true, tabId: id, response };
}

export async function clearCursorOverlayForLeases(leases = [], reason = 'release_tab_leases') {
  const results = [];
  const seen = new Set();
  for (const lease of Array.isArray(leases) ? leases : []) {
    const tabId = Number(lease?.tabId || 0);
    if (!Number.isInteger(tabId) || tabId <= 0 || seen.has(tabId)) continue;
    seen.add(tabId);
    results.push(await clearCursorOverlayForTab(tabId, reason));
  }
  return { success: true, clearedCount: results.filter((item) => item?.cleared).length, results };
}

export function notifyCursorArrived(message = {}) {
  const moveSequence = Number(message.moveSequence);
  if (!Number.isInteger(moveSequence)) return;
  const key = cursorArrivalKey(message.sessionId || message.session_id || '', message.turnId || message.turn_id || '', moveSequence);
  const pending = pendingCursorArrivals.get(key) || pendingCursorArrivals.get(moveSequence);
  emitPixelInputTelemetry('cursor.arrived', {
    moveSequence,
    sessionId: message.sessionId || '',
    turnId: message.turnId || '',
    frameUrl: message.frameUrl || '',
  });
  if (pending) pending(message);
}

export function readCursorOverlayState(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return cursorStateByTabId.get(id) || null;
}

export async function republishCursorOverlayStateForTab(tabId, options = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { success: false, republished: false, error: 'republish cursor requires tabId' };
  const state = deriveCursorOverlayStateForTab(id, options);
  const response = await sendContentMessage(id, TARGET_CURSOR_STATE_TYPE, { state, reason: options.reason || 'republish_cursor_state' }, 0, {
    injectIfMissing: options.injectIfMissing !== false,
  }).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  emitPixelInputTelemetry('cursor.republished', {
    tabId: id,
    reason: options.reason || 'republish_cursor_state',
    visible: state.isVisible === true,
    injected: response?.prepared?.injected === true,
    success: response?.success !== false,
  });
  return { success: response?.success !== false, republished: true, tabId: id, state, injected: response?.prepared?.injected === true, response };
}

export function hasPendingCursorArrivals() {
  return pendingCursorArrivals.size > 0;
}

async function publishCursorState(tabId, action = {}, options = {}, visible = true, moveSequence = null, frameId = 0) {
  const state = buildCursorState(tabId, action, options, visible, moveSequence);
  cursorStateByTabId.set(tabId, state);
  const message = { type: TARGET_CURSOR_STATE_TYPE, state };
  const response = await sendContentMessage(tabId, message.type, { state }, frameId);
  emitPixelInputTelemetry(visible ? 'cursor.state.published' : 'cursor.state.hidden', {
    tabId,
    moveSequence,
    visible,
    sessionId: state.sessionId || '',
    turnId: state.turnId || '',
    success: response?.success !== false,
  });
  return { ...response, state };
}

function buildCursorState(tabId, action = {}, options = {}, visible = true, moveSequence = null) {
  const session = options.session || {};
  const cursor = visible ? {
    x: Number(action.x),
    y: Number(action.y),
    visible: true,
    animateMovement: action.animateMovement !== false,
    ...(Number.isInteger(moveSequence) ? { moveSequence } : {}),
  } : {
    visible: false,
  };
  return {
    tabId,
    sessionId: session.sessionId || action.sessionId || '',
    turnId: session.turnId || action.turnId || '',
    isVisible: visible,
    cursor,
    label: action.label || 'RedBox',
    updatedAt: new Date().toISOString(),
  };
}

function deriveCursorOverlayStateForTab(tabId, options = {}) {
  const previous = cursorStateByTabId.get(tabId) || null;
  const observed = options.isObserved !== false;
  if (!previous) {
    return {
      tabId,
      sessionId: options.sessionId || '',
      turnId: options.turnId || '',
      isVisible: false,
      cursor: null,
      label: options.label || 'RedBox',
      updatedAt: new Date().toISOString(),
    };
  }
  if (observed) return previous;
  const cursor = previous.cursor && typeof previous.cursor === 'object'
    ? {
        ...previous.cursor,
        visible: false,
      }
    : { visible: false };
  return {
    ...previous,
    isVisible: false,
    cursor,
  };
}

function createCursorMoveSequence() {
  nextCursorMoveSequence += 1;
  return nextCursorMoveSequence;
}

function waitForCursorArrival(moveSequence, timeoutMs = 1500, session = {}) {
  const key = cursorArrivalKey(session.sessionId || session.session_id || '', session.turnId || session.turn_id || '', moveSequence);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCursorArrivals.delete(key);
      pendingCursorArrivals.delete(moveSequence);
      emitPixelInputTelemetry('cursor.arrival.timeout', { moveSequence, timeoutMs });
      resolve({ arrived: false, moveSequence, reason: 'timeout' });
    }, clamp(Number(timeoutMs || 1500), 50, 10_000));
    const resolveArrival = (message) => {
      clearTimeout(timer);
      pendingCursorArrivals.delete(key);
      pendingCursorArrivals.delete(moveSequence);
      resolve({ arrived: true, moveSequence, frameUrl: message.frameUrl || '' });
    };
    pendingCursorArrivals.set(key, resolveArrival);
    pendingCursorArrivals.set(moveSequence, resolveArrival);
  });
}

function cursorArrivalKey(sessionId = '', turnId = '', moveSequence = 0) {
  return `${sessionId}:${turnId}:${moveSequence}`;
}

async function focusTabForPixelInput(tabId) {
  emitPixelInputTelemetry('focus.started', { tabId });
  const tab = await chrome.tabs.get(Number(tabId));
  let windowInfo = null;
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { state: 'normal', focused: true }).catch(() => {});
    windowInfo = await chrome.windows.get(tab.windowId).catch(() => null);
  }
  await chrome.tabs.update(Number(tabId), { active: true }).catch(() => {});
  const focusedTab = await chrome.tabs.get(Number(tabId));
  if (focusedTab.active !== true) throw new Error(`pixel input requires active tab ${tabId}`);
  if (windowInfo?.type && windowInfo.type !== 'normal') throw new Error(`pixel input requires a normal browser window for tab ${tabId}`);
  if (windowInfo?.state === 'minimized') throw new Error(`pixel input cannot target minimized window for tab ${tabId}`);
  emitPixelInputTelemetry('focus.succeeded', { tabId, windowId: focusedTab.windowId });
  return { tab: focusedTab, window: windowInfo };
}

async function normalizePixelInputPoint(tabId, action = {}, tabContext = {}, label = 'pixel input') {
  const input = {
    x: Number(action.x),
    y: Number(action.y),
  };
  const metrics = await readViewportMetrics(tabId);
  const coordinateSpace = String(action.coordinateSpace || action.space || 'css').toLowerCase();
  let x = input.x;
  let y = input.y;
  if (coordinateSpace === 'device' || coordinateSpace === 'screen' || coordinateSpace === 'physical') {
    const scale = Number(action.deviceScaleFactor || action.scale || metrics.devicePixelRatio || 1);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`${label} requires a positive device scale`);
    x = input.x / scale;
    y = input.y / scale;
  } else if (coordinateSpace === 'page' || coordinateSpace === 'document') {
    x = input.x - metrics.pageLeft;
    y = input.y - metrics.pageTop;
  } else if (coordinateSpace !== 'css' && coordinateSpace !== 'viewport') {
    throw new Error(`${label} received unsupported coordinateSpace ${coordinateSpace}`);
  }
  const unclamped = { x, y };
  if (action.clampToViewport !== false) {
    x = clamp(x, 0, Math.max(0, metrics.width - 1));
    y = clamp(y, 0, Math.max(0, metrics.height - 1));
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${label} produced invalid normalized coordinates`);
  return {
    x,
    y,
    input,
    coordinateSpace,
    wasClamped: x !== unclamped.x || y !== unclamped.y,
    viewport: {
      width: metrics.width,
      height: metrics.height,
      pageLeft: metrics.pageLeft,
      pageTop: metrics.pageTop,
      devicePixelRatio: metrics.devicePixelRatio,
    },
    tabActive: tabContext?.tab?.active === true,
  };
}

function emitPixelInputTelemetry(kind, payload = {}) {
  if (!onPixelInputTelemetry) return;
  const point = payload.point || {};
  const event = {
    kind,
    actionType: payload.actionType || '',
    tabId: Number.isInteger(Number(payload.tabId)) ? Number(payload.tabId) : null,
    windowId: Number.isInteger(Number(payload.windowId)) ? Number(payload.windowId) : null,
    moveSequence: Number.isInteger(Number(payload.moveSequence)) ? Number(payload.moveSequence) : null,
    sessionId: payload.sessionId || '',
    turnId: payload.turnId || '',
    key: payload.key ? String(payload.key).slice(0, 80) : '',
    textLength: Number.isInteger(Number(payload.textLength)) ? Number(payload.textLength) : null,
    button: payload.button || '',
    clickCount: Number.isInteger(Number(payload.clickCount)) ? Number(payload.clickCount) : null,
    input: sanitizePoint(payload.input || point.input || {}),
    normalized: sanitizePoint(point),
    coordinateSpace: point.coordinateSpace || '',
    wasClamped: point.wasClamped === true,
    visible: payload.visible === true,
    injected: payload.injected === true,
    success: payload.success === true,
    reason: payload.reason || '',
    frameUrl: payload.frameUrl ? String(payload.frameUrl).slice(0, 300) : '',
    timeoutMs: Number.isFinite(Number(payload.timeoutMs)) ? Number(payload.timeoutMs) : null,
    durationMs: Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null,
    emittedAt: new Date().toISOString(),
  };
  void Promise.resolve(onPixelInputTelemetry(event)).catch(() => {});
}

function pointFromAction(action = {}) {
  return {
    x: Number(action.x),
    y: Number(action.y),
  };
}

function sanitizePoint(point = {}) {
  return {
    x: Number.isFinite(Number(point.x)) ? Number(point.x) : null,
    y: Number.isFinite(Number(point.y)) ? Number(point.y) : null,
  };
}

async function readViewportMetrics(tabId) {
  const fallback = { width: 4096, height: 4096, pageLeft: 0, pageTop: 0, devicePixelRatio: 1 };
  const result = await sendCdpCommandWithTimeout({ tabId }, 'Runtime.evaluate', {
    expression: `(() => {
      const visual = window.visualViewport;
      return {
        width: Math.max(1, Math.floor(visual?.width || window.innerWidth || document.documentElement.clientWidth || 1)),
        height: Math.max(1, Math.floor(visual?.height || window.innerHeight || document.documentElement.clientHeight || 1)),
        pageLeft: Number(visual?.pageLeft ?? window.scrollX ?? 0),
        pageTop: Number(visual?.pageTop ?? window.scrollY ?? 0),
        devicePixelRatio: Number(window.devicePixelRatio || 1)
      };
    })()`,
    returnByValue: true,
  }, CDP_COMMAND_TIMEOUT_MS).catch(() => null);
  const value = result?.result?.value || {};
  return {
    width: positiveNumber(value.width, fallback.width),
    height: positiveNumber(value.height, fallback.height),
    pageLeft: finiteNumber(value.pageLeft, fallback.pageLeft),
    pageTop: finiteNumber(value.pageTop, fallback.pageTop),
    devicePixelRatio: positiveNumber(value.devicePixelRatio, fallback.devicePixelRatio),
  };
}

function requireTabId(action = {}, activeTabId = 0, label = 'browser action') {
  const tabId = Number(action.tabId || activeTabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`${label} requires an integer tabId`);
  return tabId;
}

function requireFinitePoint(action = {}, label = 'pixel input') {
  if (!Number.isFinite(Number(action.x)) || !Number.isFinite(Number(action.y))) {
    throw new Error(`${label} requires finite x and y coordinates`);
  }
}

function normalizeDragActionPoints(action = {}) {
  const from = normalizeDragPoint(action.from || action.start || action, action.x, action.y);
  const rawEndX = action.endX ?? action.toX ?? action.targetX ?? action.x2;
  const rawEndY = action.endY ?? action.toY ?? action.targetY ?? action.y2;
  const to = normalizeDragPoint(action.to || action.end || {}, rawEndX, rawEndY);
  requireFinitePoint(from, 'input.mouseDrag from');
  requireFinitePoint(to, 'input.mouseDrag to');
  return { from, to };
}

async function resolveWheelPoint(tabId, action = {}, tabContext = {}) {
  if (Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y))) {
    return await normalizePixelInputPoint(tabId, action, tabContext, 'input.mouseWheel');
  }
  const metrics = await readViewportMetrics(tabId, action);
  const x = Math.max(0, Math.floor(metrics.width / 2));
  const y = Math.max(0, Math.floor(metrics.height / 2));
  return await normalizePixelInputPoint(tabId, { ...action, x, y, coordinateSpace: 'viewport' }, { ...tabContext, viewport: metrics }, 'input.mouseWheel');
}

function normalizeDragPoint(point = {}, fallbackX, fallbackY) {
  const x = point.x ?? point.left ?? fallbackX;
  const y = point.y ?? point.top ?? fallbackY;
  return { x: Number(x), y: Number(y) };
}

function mouseButtonMask(button = 'left') {
  const normalized = String(button || 'left').toLowerCase();
  if (normalized === 'left') return 1;
  if (normalized === 'right') return 2;
  if (normalized === 'middle') return 4;
  return 1;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseKeyboardCombo(action = {}) {
  const combo = String(action.combo || action.shortcut || '').trim();
  const keys = Array.isArray(action.keys) ? action.keys.map(String) : [];
  const parts = combo ? combo.split(/[+\s]+/).filter(Boolean) : keys;
  if (!parts.length && action.key) parts.push(String(action.key));
  const normalized = parts.map(normalizeKeyName).filter(Boolean);
  const modifiers = [];
  let key = '';
  for (const part of normalized) {
    if (isModifierKey(part)) {
      if (!modifiers.includes(part)) modifiers.push(part);
    } else {
      key = part;
    }
  }
  if (!key && normalized.length === 1) key = normalized[0];
  return {
    combo: normalized.join('+'),
    modifiers,
    key,
    commands: keyboardComboCommands(modifiers, key),
  };
}

function modifierMaskFromAction(action = {}) {
  const explicit = Number(action.modifiers);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const keys = Array.isArray(action.keys) ? action.keys : [];
  const modifiers = keys.map(normalizeKeyName).filter(isModifierKey);
  return modifierMask(modifiers);
}

function normalizeKeyName(key = '') {
  const value = String(key || '').trim();
  const lower = value.toLowerCase();
  const aliases = {
    control: 'Control',
    ctrl: 'Control',
    controlormeta: isMacPlatform() ? 'Meta' : 'Control',
    cmd: 'Meta',
    command: 'Meta',
    meta: 'Meta',
    option: 'Alt',
    alt: 'Alt',
    shift: 'Shift',
    esc: 'Escape',
    escape: 'Escape',
    enter: 'Enter',
    return: 'Enter',
    tab: 'Tab',
    space: ' ',
    arrowleft: 'ArrowLeft',
    left: 'ArrowLeft',
    arrowright: 'ArrowRight',
    right: 'ArrowRight',
    arrowup: 'ArrowUp',
    up: 'ArrowUp',
    arrowdown: 'ArrowDown',
    down: 'ArrowDown',
    backspace: 'Backspace',
    delete: 'Delete',
  };
  if (aliases[lower]) return aliases[lower];
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  return value;
}

function isMacPlatform() {
  return /mac/i.test(String(globalThis.navigator?.platform || globalThis.navigator?.userAgent || ''));
}

function isModifierKey(key) {
  return key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta';
}

function modifierMask(modifiers = []) {
  let mask = 0;
  if (modifiers.includes('Alt')) mask |= 1;
  if (modifiers.includes('Control')) mask |= 2;
  if (modifiers.includes('Meta')) mask |= 4;
  if (modifiers.includes('Shift')) mask |= 8;
  return mask;
}

function keyEventParams(key) {
  const named = KEY_EVENT_MAP[key] || null;
  if (named) return { ...named };
  if (/^[A-Z]$/.test(key)) {
    const code = key.charCodeAt(0);
    return {
      key: key.toLowerCase(),
      code: `Key${key}`,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    };
  }
  return { key, code: key };
}

function keyboardComboCommands(modifiers = [], key = '') {
  if ((modifiers.includes('Control') || modifiers.includes('Meta')) && key === 'A') return ['selectAll'];
  return [];
}

async function focusElementForKeyboardCombo(tabId, selector, action = {}) {
  const rawSelector = String(selector || '').trim();
  if (!rawSelector) return;
  const result = await sendCdpCommandWithTimeout({ tabId }, 'Runtime.evaluate', {
    expression: `(() => {
      const target = document.querySelector(${JSON.stringify(rawSelector)});
      if (!target || typeof target.focus !== 'function') return { success: false, error: 'focus target not found' };
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.focus();
      return { success: true, active: document.activeElement === target };
    })()`,
    returnByValue: true,
  }, Number(action.timeoutMs || CDP_COMMAND_TIMEOUT_MS));
  const value = result?.result?.value || {};
  if (value.success !== true || value.active !== true) {
    throw new Error(`input.keyboardCombo could not focus selector ${rawSelector}`);
  }
}

const KEY_EVENT_MAP = {
  Control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 },
  Shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 },
  Alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
