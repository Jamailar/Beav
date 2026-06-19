import './siteAdapters.js';
import { applyAgentCursorState, hideAgentCursor, moveAgentCursor } from './content/cursorOverlay.js';
import { readDomSnapshot, readFrame } from './content/domReader.js';
import { applyTabFaviconBadge } from './content/faviconBadge.js';
import { readPageAssets } from './content/pageAssetInventory.js';
import { checkElement, clickElement, clickNextButton, clickNode, getElementAttribute, getElementValue, getElementValues, hoverElement, inspectPoint, isCheckedElement, isElementVisible, queryElements, scrollNode, scrollPage, selectElement, typeElement, waitForDomStable, waitForNode, waitForSelector } from './content/pageActions.js';

const XWOW_READ_FRAME = 'xwow-data-ai:read-frame';
const XWOW_DOM_SNAPSHOT = 'xwow-data-ai:dom-snapshot';
const XWOW_SCROLL_PAGE = 'xwow-data-ai:scroll-page';
const XWOW_CLICK_NEXT = 'xwow-data-ai:click-next';
const XWOW_CLICK_ELEMENT = 'xwow-data-ai:click-element';
const XWOW_CLICK_NODE = 'xwow-data-ai:click-node';
const XWOW_HOVER_ELEMENT = 'xwow-data-ai:hover-element';
const XWOW_INSPECT_POINT = 'xwow-data-ai:inspect-point';
const XWOW_SCROLL_NODE = 'xwow-data-ai:scroll-node';
const XWOW_SELECT_ELEMENT = 'xwow-data-ai:select-element';
const XWOW_TYPE_ELEMENT = 'xwow-data-ai:type-element';
const XWOW_WAIT_STABLE = 'xwow-data-ai:wait-stable';
const XWOW_WAIT_SELECTOR = 'xwow-data-ai:wait-selector';
const XWOW_WAIT_NODE = 'xwow-data-ai:wait-node';
const XWOW_CHECK_ELEMENT = 'xwow-data-ai:check-element';
const XWOW_IS_CHECKED = 'xwow-data-ai:is-checked';
const XWOW_IS_VISIBLE = 'xwow-data-ai:is-visible';
const XWOW_GET_VALUE = 'xwow-data-ai:get-value';
const XWOW_GET_VALUES = 'xwow-data-ai:get-values';
const XWOW_GET_ATTRIBUTE = 'xwow-data-ai:get-attribute';
const XWOW_QUERY_ELEMENTS = 'xwow-data-ai:query-elements';
const XWOW_PAGE_ASSETS = 'xwow-data-ai:page-assets';
const XWOW_CURSOR_MOVE = 'xwow-data-ai:cursor-move';
const XWOW_CURSOR_HIDE = 'xwow-data-ai:cursor-hide';
const XWOW_CONTENT_PING = 'xwow-data-ai:content-ping';
const TARGET_CONTENT_PING = 'CONTENT_PING';
const XWOW_TAB_FAVICON_BADGE = 'TAB_FAVICON_BADGE';
const TARGET_CURSOR_STATE = 'AGENT_CURSOR_STATE';
const TARGET_GET_CURSOR_STATE = 'GET_AGENT_CURSOR_STATE';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (message?.type === XWOW_CONTENT_PING || message?.type === TARGET_CONTENT_PING) {
      sendResponse({ success: true, ok: true, frameUrl: location.href });
      return;
    }
    if (message?.type === XWOW_READ_FRAME) {
      sendResponse({ success: true, data: readFrame(message.options || {}) });
      return;
    }
    if (message?.type === XWOW_DOM_SNAPSHOT) {
      sendResponse(readDomSnapshot(message.options || {}));
      return;
    }
    if (message?.type === XWOW_SCROLL_PAGE) {
      sendResponse(await scrollPage(message.options || {}));
      return;
    }
    if (message?.type === XWOW_CLICK_NEXT) {
      sendResponse(await clickNextButton(message.options || {}));
      return;
    }
    if (message?.type === XWOW_CLICK_ELEMENT) {
      sendResponse(await clickElement(message.options || {}));
      return;
    }
    if (message?.type === XWOW_CLICK_NODE) {
      sendResponse(await clickNode(message.options || {}));
      return;
    }
    if (message?.type === XWOW_HOVER_ELEMENT) {
      sendResponse(await hoverElement(message.options || {}));
      return;
    }
    if (message?.type === XWOW_INSPECT_POINT) {
      sendResponse(inspectPoint(message.options || {}));
      return;
    }
    if (message?.type === XWOW_SCROLL_NODE) {
      sendResponse(scrollNode(message.options || {}));
      return;
    }
    if (message?.type === XWOW_SELECT_ELEMENT) {
      sendResponse(await selectElement(message.options || {}));
      return;
    }
    if (message?.type === XWOW_TYPE_ELEMENT) {
      sendResponse(await typeElement(message.options || {}));
      return;
    }
    if (message?.type === XWOW_WAIT_STABLE) {
      sendResponse(await waitForDomStable(message.options || {}));
      return;
    }
    if (message?.type === XWOW_WAIT_SELECTOR) {
      sendResponse(await waitForSelector(message.options || {}));
      return;
    }
    if (message?.type === XWOW_WAIT_NODE) {
      sendResponse(await waitForNode(message.options || {}));
      return;
    }
    if (message?.type === XWOW_CHECK_ELEMENT) {
      sendResponse(await checkElement(message.options || {}));
      return;
    }
    if (message?.type === XWOW_IS_CHECKED) {
      sendResponse(isCheckedElement(message.options || {}));
      return;
    }
    if (message?.type === XWOW_IS_VISIBLE) {
      sendResponse(isElementVisible(message.options || {}));
      return;
    }
    if (message?.type === XWOW_GET_VALUE) {
      sendResponse(getElementValue(message.options || {}));
      return;
    }
    if (message?.type === XWOW_GET_VALUES) {
      sendResponse(getElementValues(message.options || {}));
      return;
    }
    if (message?.type === XWOW_GET_ATTRIBUTE) {
      sendResponse(getElementAttribute(message.options || {}));
      return;
    }
    if (message?.type === XWOW_QUERY_ELEMENTS) {
      sendResponse(queryElements(message.options || {}));
      return;
    }
    if (message?.type === XWOW_PAGE_ASSETS) {
      sendResponse({ success: true, assets: readPageAssets(message.options || {}) });
      return;
    }
    if (message?.type === XWOW_CURSOR_MOVE) {
      sendResponse(moveAgentCursor(message.options || {}));
      return;
    }
    if (message?.type === TARGET_CURSOR_STATE) {
      sendResponse(applyAgentCursorState(message.state || message.options?.state || message.options || {}));
      return;
    }
    if (message?.type === XWOW_CURSOR_HIDE) {
      sendResponse(hideAgentCursor());
      return;
    }
    if (message?.type === XWOW_TAB_FAVICON_BADGE) {
      sendResponse(applyTabFaviconBadge(message.options || {}));
      return;
    }
    sendResponse({ success: false, error: 'Unknown content message type' });
  })().catch((error) => {
    sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

chrome.runtime.sendMessage({ type: TARGET_GET_CURSOR_STATE }).then((response) => {
  if (response?.state) applyAgentCursorState(response.state);
}).catch(() => {});
