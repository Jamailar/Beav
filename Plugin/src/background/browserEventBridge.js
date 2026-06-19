import { getStoredMap, setStoredMap } from './storage.js';

export const NATIVE_CDP_EVENT_METHOD = 'onCDPEvent';
export const NATIVE_DOWNLOAD_EVENT_METHOD = 'onDownloadChange';
export const NATIVE_LIFECYCLE_EVENT_METHOD = 'onBrowserLifecycleEvent';
export const NATIVE_SESSION_EVENT_METHOD = 'onBrowserSessionEvent';
export const BROWSER_EVENT_LOG_KEY = 'xwowBrowserDataAiBrowserEvents';
export const BROWSER_EVENT_LOG_LIMIT = 500;

const browserEventMemoryLog = new Map();

export function createBrowserEventBridge(options = {}) {
  const sendNativeNotification = options.sendNativeNotification;
  if (typeof sendNativeNotification !== 'function') {
    throw new Error('createBrowserEventBridge requires sendNativeNotification');
  }
  const pluginId = options.pluginId || 'xwow-browser-data-ai';
  const getActiveSession = typeof options.getActiveSession === 'function'
    ? options.getActiveSession
    : () => null;

  async function publishNativeEvent(method, payload = {}) {
    const envelope = buildBrowserEventEnvelope(pluginId, getActiveSession(), payload);
    let recorded = await recordBrowserEvent(envelope, { method, posted: false, success: false, pending: true }).catch(() => null);
    try {
      const posted = await sendNativeNotification(method, envelope);
      recorded = await recordBrowserEvent(envelope, { method, posted: Boolean(posted), success: Boolean(posted) }).catch(() => recorded);
      return { success: Boolean(posted), method, posted: Boolean(posted), event: envelope, recorded };
    } catch (error) {
      const errorText = describeError(error);
      recorded = await recordBrowserEvent(envelope, { method, posted: false, success: false, error: errorText }).catch(() => recorded);
      return { success: false, method, posted: false, event: envelope, recorded, error: errorText };
    }
  }

  async function publishLocalEvent(method, payload = {}) {
    const envelope = buildBrowserEventEnvelope(pluginId, getActiveSession(), payload);
    const recorded = await recordBrowserEvent(envelope, { method, posted: false, success: false, pending: false }).catch(() => null);
    return { success: true, method, posted: false, event: envelope, recorded };
  }

  function sendCdpEvent({ source, method, params = {} } = {}) {
    return publishNativeEvent(NATIVE_CDP_EVENT_METHOD, {
      eventType: 'cdp',
      source: normalizeDebuggerSource(source),
      method,
      params,
    });
  }

  function sendDownloadChange(downloadEvent = {}) {
    return publishNativeEvent(NATIVE_DOWNLOAD_EVENT_METHOD, {
      eventType: 'download',
      ...downloadEvent,
    });
  }

  return {
    sendCdpEvent,
    sendDownloadChange,
    publishCdpEvent(source, method, params = {}) {
      return sendCdpEvent({ source, method, params });
    },
    publishCdpLifecycleEvent(lifecycleEvent = {}) {
      return publishNativeEvent(NATIVE_CDP_EVENT_METHOD, {
        eventType: 'cdpLifecycle',
        kind: lifecycleEvent.kind || 'cdp_lifecycle',
        ...lifecycleEvent,
      });
    },
    publishCdpCommandEvent(commandEvent = {}) {
      return publishLocalEvent('cdpCommand', {
        eventType: 'cdpCommand',
        kind: commandEvent.kind || 'command',
        ...commandEvent,
      });
    },
    publishPixelInputEvent(inputEvent = {}) {
      return publishLocalEvent('pixelInput', {
        eventType: 'pixelInput',
        kind: inputEvent.kind || 'input',
        ...inputEvent,
      });
    },
    publishFileChooserEvent(fileChooserEvent = {}) {
      return publishLocalEvent('fileChooser', {
        eventType: 'fileChooser',
        kind: fileChooserEvent.kind || 'file_chooser',
        ...fileChooserEvent,
      });
    },
    publishDownloadChange(downloadEvent = {}) {
      return sendDownloadChange(downloadEvent);
    },
    publishLifecycleEvent(kind, payload = {}) {
      return publishNativeEvent(NATIVE_LIFECYCLE_EVENT_METHOD, {
        eventType: 'lifecycle',
        kind,
        ...payload,
      });
    },
    publishSessionEvent(sessionEvent = {}) {
      return publishNativeEvent(NATIVE_SESSION_EVENT_METHOD, {
        ...sessionEvent,
        eventType: 'session',
        sessionEventType: sessionEvent.eventType || sessionEvent.sessionEventType || '',
      });
    },
    publishActiveTabObserverEvent(observerEvent = {}) {
      return publishNativeEvent(NATIVE_SESSION_EVENT_METHOD, {
        eventType: 'activeTabObserver',
        kind: observerEvent.kind || 'active_tab_changed',
        ...observerEvent,
      });
    },
    publishTabLifecycleEvent(lifecycleEvent = {}) {
      return publishNativeEvent(NATIVE_SESSION_EVENT_METHOD, {
        eventType: 'tabLifecycle',
        kind: lifecycleEvent.kind || 'tab_lifecycle',
        ...lifecycleEvent,
      });
    },
    publishManagedTabGroupEvent(groupEvent = {}) {
      return publishNativeEvent(NATIVE_SESSION_EVENT_METHOD, {
        eventType: 'managedTabGroup',
        kind: groupEvent.kind || 'group_reconciled',
        ...groupEvent,
      });
    },
    publishContentInjectionEvent(injectionEvent = {}) {
      return publishNativeEvent(NATIVE_SESSION_EVENT_METHOD, {
        eventType: 'contentInjection',
        kind: injectionEvent.kind || 'content_prepare',
        ...injectionEvent,
      });
    },
    publishPolicyDecisionEvent(policyEvent = {}) {
      return publishNativeEvent(NATIVE_SESSION_EVENT_METHOD, {
        eventType: 'policyDecision',
        kind: policyEvent.kind || 'policy_decision',
        ...policyEvent,
      });
    },
    publishSidePanelEvent(sidePanelEvent = {}) {
      return publishNativeEvent(NATIVE_SESSION_EVENT_METHOD, {
        eventType: 'sidePanel',
        kind: sidePanelEvent.kind || 'side_panel_status',
        ...sidePanelEvent,
      });
    },
    publishBrowserVisibilityEvent(visibilityEvent = {}) {
      return publishNativeEvent(NATIVE_SESSION_EVENT_METHOD, {
        eventType: 'browserVisibility',
        kind: visibilityEvent.kind || 'browser_visibility',
        ...visibilityEvent,
      });
    },
    publishWebMcpEvent(webMcpEvent = {}) {
      return publishNativeEvent(NATIVE_SESSION_EVENT_METHOD, {
        eventType: 'webMcp',
        kind: webMcpEvent.kind || 'webmcp',
        ...webMcpEvent,
      });
    },
    publishNativeTransportEvent(transportEvent = {}) {
      return publishLocalEvent('nativeTransport', {
        eventType: 'nativeTransport',
        kind: transportEvent.kind || transportEvent.type || 'native_transport',
        ...transportEvent,
      });
    },
    publishCommandRouterEvent(routerEvent = {}) {
      return publishLocalEvent('commandRouter', {
        eventType: 'commandRouter',
        kind: routerEvent.kind || 'route',
        ...routerEvent,
      });
    },
  };
}

export function buildBrowserEventEnvelope(pluginId, session, payload = {}) {
  const emittedAt = new Date().toISOString();
  return {
    eventId: payload.eventId || `browser-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    pluginId,
    extensionId: chrome.runtime.id,
    sessionId: session?.sessionId || payload.sessionId || '',
    turnId: session?.turnId || payload.turnId || '',
    activeTabId: session?.activeTabId || payload.activeTabId || null,
    owner: session?.owner || '',
    jobMetadata: session?.metadata || {},
    emittedAt,
    ...payload,
  };
}

export async function recordBrowserEvent(envelope = {}, delivery = {}) {
  const eventId = String(envelope.eventId || `browser-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  const record = {
    ...envelope,
    eventId,
    bridgeMethod: delivery.method || envelope.bridgeMethod || '',
    nativeDelivery: {
      posted: delivery.posted === true,
      success: delivery.success === true,
      pending: delivery.pending === true,
      error: delivery.error || '',
    },
    recordedAt: new Date().toISOString(),
  };
  rememberBrowserEvent(record);
  const events = await getStoredMap(BROWSER_EVENT_LOG_KEY);
  events[eventId] = record;
  const sorted = Object.values(events)
    .sort((a, b) => String(b.emittedAt || b.recordedAt || '').localeCompare(String(a.emittedAt || a.recordedAt || '')))
    .slice(0, BROWSER_EVENT_LOG_LIMIT);
  await setStoredMap(BROWSER_EVENT_LOG_KEY, Object.fromEntries(sorted.map((event) => [event.eventId, event])));
  return record;
}

export async function listBrowserEvents(options = {}) {
  const limit = clamp(Number(options.limit || 100), 1, BROWSER_EVENT_LOG_LIMIT);
  const eventType = String(options.eventType || options.type || '');
  const sessionId = String(options.sessionId || '');
  const turnId = String(options.turnId || '');
  const bridgeMethod = String(options.bridgeMethod || options.method || '');
  const since = String(options.since || options.sinceEmittedAt || '');
  const afterEventId = String(options.afterEventId || '');
  const stored = Object.values(await getStoredMap(BROWSER_EVENT_LOG_KEY).catch(() => ({})));
  const events = dedupeBrowserEvents([...browserEventMemoryLog.values(), ...stored])
    .filter((event) => !eventType || event.eventType === eventType)
    .filter((event) => !sessionId || event.sessionId === sessionId)
    .filter((event) => !turnId || event.turnId === turnId)
    .filter((event) => !bridgeMethod || event.bridgeMethod === bridgeMethod)
    .filter((event) => !since || String(event.emittedAt || event.recordedAt || '') > since)
    .sort((a, b) => String(b.emittedAt || b.recordedAt || '').localeCompare(String(a.emittedAt || a.recordedAt || '')));
  const afterIndex = afterEventId ? events.findIndex((event) => event.eventId === afterEventId) : -1;
  const windowed = afterIndex >= 0 ? events.slice(afterIndex + 1) : events;
  const selected = windowed.slice(0, limit);
  return {
    success: true,
    events: selected,
    hasMore: windowed.length > selected.length,
    newestEventId: events[0]?.eventId || '',
    newestEmittedAt: events[0]?.emittedAt || '',
  };
}

function rememberBrowserEvent(record) {
  browserEventMemoryLog.set(record.eventId, record);
  const sorted = [...browserEventMemoryLog.values()]
    .sort((a, b) => String(b.emittedAt || b.recordedAt || '').localeCompare(String(a.emittedAt || a.recordedAt || '')))
    .slice(0, BROWSER_EVENT_LOG_LIMIT);
  browserEventMemoryLog.clear();
  for (const event of sorted) browserEventMemoryLog.set(event.eventId, event);
}

function dedupeBrowserEvents(events = []) {
  const byId = new Map();
  for (const event of events) {
    if (!event?.eventId) continue;
    byId.set(event.eventId, event);
  }
  return [...byId.values()];
}

function normalizeDebuggerSource(source = {}) {
  return {
    tabId: source.tabId || null,
    targetId: source.targetId || '',
    extensionId: source.extensionId || '',
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function describeError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
