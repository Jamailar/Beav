import { cssPath, normalizeWhitespace, sleep } from './domUtils.js';

const DANGEROUS_ACTION_TEXT = /(save|submit|publish|delete|remove|refund|cancel order|ship order|change price|change inventory|change budget|enable ad|disable ad|保存|提交|发布|删除|移除|退款|取消订单|发货|改价|库存|预算|开启广告|关闭广告)/i;
const nodeIds = new WeakMap();
const nodesById = new Map();
let nextNodeId = 1;

export async function scrollPage(options) {
  const maxSteps = Number(options.maxSteps || 8);
  const delayMs = Number(options.delayMs || 450);
  const direction = String(options.direction || 'down').toLowerCase();
  const explicitPixels = Number(options.pixels || 0);
  const scrollX = Number(options.scrollX ?? options.scroll_x ?? 0);
  const scrollY = Number(options.scrollY ?? options.scroll_y ?? 0);
  const scrollTarget = document.scrollingElement || document.documentElement;
  const before = pageScrollSnapshot(scrollTarget);
  if (scrollX || scrollY) {
    scrollTarget.scrollBy({ left: scrollX, top: scrollY, behavior: options.behavior || 'auto' });
    await sleep(Number(options.delayMs || options.waitAfterScrollMs || 80));
    return {
      success: true,
      mode: 'target-delta',
      scrollX,
      scrollY,
      before,
      after: pageScrollSnapshot(scrollTarget),
    };
  }
  let previousHeight = 0;
  let steps = 0;
  for (let i = 0; i < maxSteps; i += 1) {
    steps = i + 1;
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const top = direction === 'up'
      ? Math.max(0, window.scrollY - (explicitPixels || Math.floor(window.innerHeight * 0.85)))
      : explicitPixels
        ? window.scrollY + explicitPixels
        : height;
    window.scrollTo({ top, behavior: 'smooth' });
    for (const scroller of scrollableContainers()) {
      scroller.scrollTop = direction === 'up'
        ? Math.max(0, scroller.scrollTop - (explicitPixels || Math.floor(scroller.clientHeight * 0.85)))
        : explicitPixels
          ? scroller.scrollTop + explicitPixels
          : scroller.scrollHeight;
    }
    await sleep(delayMs);
    const nextHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    if (nextHeight === previousHeight && window.scrollY + window.innerHeight >= nextHeight - 12) break;
    previousHeight = nextHeight;
  }
  return {
    success: true,
    mode: 'legacy-auto',
    direction,
    pixels: explicitPixels,
    steps,
    before,
    after: pageScrollSnapshot(scrollTarget),
  };
}

export async function clickNextButton(options) {
  const selectors = [
    options.selector,
    'a[rel="next"]',
    'button[aria-label*="Next"]',
    'a[aria-label*="Next"]',
    'button[aria-label*="下一"]',
    'a[aria-label*="下一"]',
    'button[class*="next"]',
    'a[class*="next"]',
  ].filter(Boolean);
  const bySelector = selectors
    .flatMap((selector) => [...document.querySelectorAll(selector)])
    .find(isClickable);
  const byText = bySelector || [...document.querySelectorAll('button,a,[role="button"]')]
    .find((node) => {
      const label = normalizeWhitespace(node.innerText || node.textContent || node.getAttribute('aria-label') || '');
      return /^(next|more|load more|下一页|下页|更多|加载更多|继续)$/i.test(label) && isClickable(node);
    });
  if (!byText) return { success: false, error: 'Next button not found' };
  byText.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(180);
  byText.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  byText.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  byText.click();
  return { success: true, selector: cssPath(byText), text: normalizeWhitespace(byText.innerText || byText.textContent || '') };
}

export async function clickElement(options) {
  const target = findClickTarget(options);
  if (!target) return { success: false, error: 'Clickable element not found' };
  const label = elementLabel(target);
  if (isDangerousElement(target, label) && options.force !== true) {
    return { success: false, error: 'dangerous_action_denied', selector: cssPath(target), text: label };
  }
  target.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(Number(options.beforeClickDelayMs || 160));
  dispatchElementClick(target, options);
  return {
    success: true,
    selector: cssPath(target),
    text: label,
    href: target.href || target.getAttribute('href') || '',
    button: normalizeMouseButtonName(options.button),
    modifiers: normalizeEventModifierNames(options),
    clickCount: normalizeClickCount(options),
  };
}

export async function hoverElement(options) {
  const target = findHoverTarget(options);
  if (!target) return { success: false, error: 'Hover element not found' };
  const label = elementLabel(target);
  target.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(Number(options.beforeHoverDelayMs || 120));
  const rect = target.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove']) {
    const event = type.startsWith('pointer')
      ? new PointerEvent(type, { bubbles: !type.endsWith('enter'), cancelable: true, view: window, clientX: x, clientY: y, pointerType: 'mouse' })
      : new MouseEvent(type, { bubbles: !type.endsWith('enter'), cancelable: true, view: window, clientX: x, clientY: y });
    target.dispatchEvent(event);
  }
  if (options.focus === true && typeof target.focus === 'function') target.focus();
  return {
    success: true,
    selector: cssPath(target),
    text: label,
    rect: {
      x,
      y,
      width: rect.width,
      height: rect.height,
    },
  };
}

export async function typeElement(options) {
  const target = await waitForInputTarget(options);
  if (!target) return { success: false, error: 'Input element not found' };
  const label = elementLabel(target);
  const text = normalizeTypeValue(options);
  if ((isDangerousElement(target, label) && options.force !== true) || DANGEROUS_ACTION_TEXT.test(text)) {
    return { success: false, error: 'dangerous_action_denied', selector: cssPath(target), text: label };
  }
  const previousValue = readElementTextValue(target);
  const replace = normalizeTypeReplace(options);
  const nextValue = replace ? text : `${previousValue}${text}`;
  target.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(Number(options.beforeTypeDelayMs || 120));
  target.focus();
  if (replace) {
    setInputValue(target, '');
  }
  setInputValue(target, nextValue);
  target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: replace ? 'insertReplacementText' : 'insertText', data: text }));
  target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return {
    success: true,
    selector: cssPath(target),
    textLength: text.length,
    label,
    value: nextValue,
    previousValue,
    replace,
  };
}

export async function selectElement(options) {
  const target = findSelectTarget(options);
  if (!target) return { success: false, error: 'Select element not found' };
  const label = elementLabel(target);
  if (isDangerousElement(target, label)) {
    return { success: false, error: 'dangerous_action_denied', selector: cssPath(target), text: label };
  }
  const selections = normalizeSelectSelections(options);
  const selectedOptions = selections.map((selection) => findSelectOption(target, selection)).filter(Boolean);
  if (!selectedOptions.length) return { success: false, error: 'Select option not found', selector: cssPath(target), text: label };
  target.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(Number(options.beforeSelectDelayMs || 120));
  target.focus();
  if (target.multiple) {
    const selected = new Set(selectedOptions.map((option) => option.value));
    for (const option of target.options) option.selected = selected.has(option.value);
  } else {
    const option = selectedOptions[0];
    target.value = option.value;
    option.selected = true;
  }
  const selectedValues = [...target.selectedOptions].map((option) => option.value);
  target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: selectedValues.join(',') }));
  target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return {
    success: true,
    selector: cssPath(target),
    label,
    value: target.value,
    values: selectedValues,
    selectedIndex: target.selectedIndex,
    selectedText: [...target.selectedOptions].map((option) => normalizeWhitespace(option.textContent || option.label || '')).join(','),
    selections: selectedOptions.map((option) => ({
      value: option.value,
      label: normalizeWhitespace(option.textContent || option.label || ''),
      index: [...target.options].indexOf(option),
    })),
  };
}

export async function checkElement(options = {}) {
  const target = findCheckTarget(options);
  if (!target) return { success: false, error: 'Checkable element not found' };
  const label = elementLabel(target);
  if (!isCheckableInput(target)) {
    return { success: false, error: 'Element is not checkbox or radio input', selector: cssPath(target), text: label };
  }
  if (isDangerousElement(target, label) && options.force !== true) {
    return { success: false, error: 'dangerous_action_denied', selector: cssPath(target), text: label };
  }
  const desired = normalizeCheckedValue(options);
  target.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(Number(options.beforeCheckDelayMs || 120));
  target.focus();
  if (target.checked !== desired) {
    setCheckedValue(target, desired);
    target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: String(desired) }));
    target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }
  return {
    success: true,
    selector: cssPath(target),
    label,
    checked: Boolean(target.checked),
    value: Boolean(target.checked),
    inputType: target.type || '',
  };
}

export function isCheckedElement(options = {}) {
  const target = findCheckTarget(options);
  if (!target) return { success: false, error: 'Checkable element not found' };
  if (!isCheckableInput(target)) {
    return { success: false, error: 'Element is not checkbox or radio input', selector: cssPath(target), text: elementLabel(target) };
  }
  return {
    success: true,
    selector: cssPath(target),
    label: elementLabel(target),
    checked: Boolean(target.checked),
    value: Boolean(target.checked),
    inputType: target.type || '',
  };
}

export function isElementVisible(options = {}) {
  const target = findAnyTarget(options);
  if (!target) return { success: false, error: 'Element not found' };
  return {
    success: true,
    selector: cssPath(target),
    label: elementLabel(target),
    value: isVisibleElement(target),
    visible: isVisibleElement(target),
    element: elementDescriptor(target),
  };
}

export function getElementValue(options = {}) {
  const target = findAnyTarget(options);
  if (!target) return { success: false, error: 'Element not found' };
  const value = readElementValue(target);
  return {
    success: true,
    selector: cssPath(target),
    label: elementLabel(target),
    value,
    values: readElementValues(target),
    element: elementDescriptor(target),
  };
}

export function getElementValues(options = {}) {
  const target = findAnyTarget(options);
  if (!target) return { success: false, error: 'Element not found' };
  return {
    success: true,
    selector: cssPath(target),
    label: elementLabel(target),
    values: readElementValues(target),
    value: readElementValue(target),
    element: elementDescriptor(target),
  };
}

export function getElementAttribute(options = {}) {
  const target = findAnyTarget(options);
  if (!target) return { success: false, error: 'Element not found' };
  const name = String(options.name || options.attribute || '').trim();
  if (!name) return { success: false, error: 'page.getAttribute requires name' };
  return {
    success: true,
    selector: cssPath(target),
    name,
    value: target.getAttribute(name),
    element: elementDescriptor(target),
  };
}

export function queryElements(options = {}) {
  const relativeSelector = String(options.relativeSelector || options.relative_selector || '').trim();
  const baseNodes = collectLocatorTargets(options);
  if (!baseNodes.length) return { success: false, error: 'Element not found' };
  const rawNodes = relativeSelector
    ? baseNodes.flatMap((base) => [...base.querySelectorAll(relativeSelector)])
    : baseNodes;
  const limit = normalizeLocatorLimit(options.limit ?? options.maxResults);
  const nodes = rawNodes.slice(0, limit);
  const values = nodes.map((node) => node instanceof Element ? elementReadSnapshot(node) : null).filter(Boolean);
  return {
    success: true,
    selector: cssPath(baseNodes[0]),
    relativeSelector: relativeSelector || null,
    count: rawNodes.length,
    returnedCount: values.length,
    first: values[0] || null,
    values,
    textContents: values.map((item) => item.text_content ?? ''),
    innerTexts: values.map((item) => item.inner_text ?? ''),
    allTextContents: values.map((item) => item.text_content ?? ''),
    allInnerTexts: values.map((item) => item.inner_text ?? ''),
    isEnabled: values[0]?.enabled ?? false,
    isVisible: values[0]?.visible ?? false,
    textContent: values[0]?.text_content ?? null,
    innerText: values[0]?.inner_text ?? null,
  };
}

export function inspectPoint(options = {}) {
  const x = Number(options.x);
  const y = Number(options.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { success: false, error: 'page.inspectPoint requires finite x and y' };
  }
  const includeNonInteractable = options.includeNonInteractable === true || options.include_non_interactable === true;
  const candidates = [...document.elementsFromPoint(x, y)]
    .filter((node) => node instanceof Element)
    .filter((node) => includeNonInteractable || isInteractableCandidate(node))
    .slice(0, Number(options.limit || 20))
    .map(elementDescriptor);
  return {
    success: true,
    x,
    y,
    includeNonInteractable,
    elements: candidates,
  };
}

export async function clickNode(options = {}) {
  const target = findNodeById(options);
  if (!target) return { success: false, error: 'Node not found', nodeId: normalizeNodeId(options) };
  const label = elementLabel(target);
  if (isDangerousElement(target, label) && options.force !== true) {
    return { success: false, error: 'dangerous_action_denied', nodeId: getNodeId(target), selector: cssPath(target), text: label };
  }
  target.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(Number(options.beforeClickDelayMs || 120));
  dispatchElementClick(target, options);
  return {
    success: true,
    nodeId: getNodeId(target),
    selector: cssPath(target),
    text: label,
    element: elementDescriptor(target),
  };
}

export function scrollNode(options = {}) {
  const nodeId = normalizeNodeId(options);
  const target = nodeId ? findNodeById(options) : null;
  const scrollX = Number(options.scrollX ?? options.scroll_x ?? 0);
  const scrollY = Number(options.scrollY ?? options.scroll_y ?? 0);
  if (nodeId && !target) return { success: false, error: 'Node not found', nodeId };
  const scrollTarget = target || document.scrollingElement || document.documentElement;
  if (scrollX || scrollY) {
    scrollTarget.scrollBy({ left: scrollX, top: scrollY, behavior: options.behavior || 'auto' });
  } else if (target) {
    target.scrollIntoView({ block: options.block || 'center', inline: options.inline || 'center' });
  }
  return {
    success: true,
    nodeId: target ? getNodeId(target) : null,
    scrollX,
    scrollY,
    selector: target ? cssPath(target) : null,
    element: target ? elementDescriptor(target) : null,
  };
}

export async function waitForNode(options = {}) {
  const nodeId = normalizeNodeId(options);
  if (!nodeId) return { success: false, error: 'page.waitForNode requires node_id' };
  const timeoutMs = Number(options.timeoutMs || options.timeout_ms || 8000);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const target = findNodeById(options);
    if (target) {
      return {
        success: true,
        nodeId,
        elapsedMs: Date.now() - startedAt,
        element: elementDescriptor(target),
      };
    }
    await sleep(100);
  }
  return {
    success: false,
    error: 'node_wait_timeout',
    nodeId,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function waitForSelector(options = {}) {
  const selector = String(options.selector || '').trim();
  if (!selector) return { success: false, error: 'page.waitForSelector requires selector' };
  const state = normalizeSelectorWaitState(options.state);
  const timeoutMs = Number(options.timeoutMs || options.timeout_ms || 8000);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const node = document.querySelector(selector);
    const visible = node ? isVisibleElement(node) : false;
    if (
      (state === 'attached' && node)
      || (state === 'detached' && !node)
      || (state === 'visible' && visible)
      || (state === 'hidden' && (!node || !visible))
    ) {
      return {
        success: true,
        selector,
        state,
        elapsedMs: Date.now() - startedAt,
        element: node ? elementDescriptor(node) : null,
      };
    }
    await sleep(100);
  }
  return {
    success: false,
    error: 'selector_wait_timeout',
    selector,
    state,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function waitForDomStable(options) {
  const timeoutMs = Number(options.timeoutMs || 8000);
  const quietMs = Number(options.quietMs || 500);
  const startedAt = Date.now();
  let lastMutationAt = Date.now();
  let mutationCount = 0;
  const observer = new MutationObserver(() => {
    mutationCount += 1;
    lastMutationAt = Date.now();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (document.readyState === 'complete' && Date.now() - lastMutationAt >= quietMs) {
        return {
          success: true,
          readyState: document.readyState,
          elapsedMs: Date.now() - startedAt,
          mutationCount,
          scrollHeight: document.documentElement.scrollHeight,
        };
      }
      await sleep(100);
    }
    return {
      success: false,
      error: 'dom_stable_timeout',
      readyState: document.readyState,
      elapsedMs: Date.now() - startedAt,
      mutationCount,
    };
  } finally {
    observer.disconnect();
  }
}

function setInputValue(target, value) {
  if (target.isContentEditable) {
    target.textContent = value;
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value');
  if (descriptor?.set) {
    descriptor.set.call(target, value);
  } else {
    target.value = value;
  }
}

async function waitForInputTarget(options = {}) {
  const timeoutMs = Number(options.timeoutMs || options.timeout_ms || 0);
  if (!timeoutMs) return findInputTarget(options);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const target = findInputTarget(options);
    if (target) return target;
    await sleep(100);
  }
  return null;
}

function normalizeTypeValue(options = {}) {
  if (options.value != null) return String(options.value);
  return String(options.text || '');
}

function normalizeTypeReplace(options = {}) {
  if (typeof options.replace === 'boolean') return options.replace;
  if (typeof options.clear === 'boolean') return options.clear;
  return true;
}

function readElementTextValue(target) {
  if (target.isContentEditable) return target.textContent || '';
  return target.value ?? '';
}

function pageScrollSnapshot(target) {
  return {
    scrollLeft: Math.round(Number(target?.scrollLeft ?? window.scrollX ?? 0)),
    scrollTop: Math.round(Number(target?.scrollTop ?? window.scrollY ?? 0)),
    scrollWidth: Math.round(Number(target?.scrollWidth ?? document.documentElement.scrollWidth ?? 0)),
    scrollHeight: Math.round(Number(target?.scrollHeight ?? document.documentElement.scrollHeight ?? 0)),
    viewportWidth: Math.round(window.visualViewport?.width ?? window.innerWidth),
    viewportHeight: Math.round(window.visualViewport?.height ?? window.innerHeight),
  };
}

function setCheckedValue(target, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'checked');
  if (descriptor?.set) {
    descriptor.set.call(target, value);
  } else {
    target.checked = value;
  }
}

function findClickTarget(options) {
  if (options.selector) {
    const bySelector = [...document.querySelectorAll(options.selector)].find(isClickable);
    if (bySelector) return bySelector;
  }
  const text = String(options.text || options.label || '').trim();
  const textRegex = options.textRegex ? new RegExp(options.textRegex, options.flags || 'i') : null;
  if (!text && !textRegex) return null;
  return [...document.querySelectorAll('button,a,input,[role="button"],[tabindex]')]
    .find((node) => {
      if (!isClickable(node)) return false;
      const label = normalizeWhitespace(
        node.innerText || node.textContent || node.value || node.getAttribute('aria-label') || node.getAttribute('title') || ''
      );
      if (text && label === text) return true;
      if (textRegex && textRegex.test(label)) return true;
      return false;
    }) || null;
}

function findHoverTarget(options) {
  if (options.selector) {
    const bySelector = [...document.querySelectorAll(options.selector)].find(isHoverable);
    if (bySelector) return bySelector;
  }
  const text = String(options.text || options.label || '').trim();
  const textRegex = options.textRegex ? new RegExp(options.textRegex, options.flags || 'i') : null;
  if (!text && !textRegex) return null;
  return [...document.querySelectorAll('button,a,input,textarea,select,[role="button"],[tabindex],[aria-label],[title]')]
    .find((node) => {
      if (!isHoverable(node)) return false;
      const label = elementLabel(node);
      if (text && label === text) return true;
      if (textRegex && textRegex.test(label)) return true;
      return false;
    }) || null;
}

function findInputTarget(options) {
  if (options.selector) {
    const bySelector = [...document.querySelectorAll(options.selector)]
      .find((node) => isInputLike(node) && isClickable(node));
    if (bySelector) return bySelector;
  }
  const text = String(options.label || options.textLabel || '').trim();
  if (!text) return null;
  const labels = [...document.querySelectorAll('label')];
  const label = labels.find((node) => normalizeWhitespace(node.innerText || node.textContent || '') === text);
  if (label?.htmlFor) {
    const target = document.getElementById(label.htmlFor);
    if (target && isInputLike(target) && isClickable(target)) return target;
  }
  return [...document.querySelectorAll('input,textarea,[contenteditable="true"]')]
    .find((node) => {
      if (!isClickable(node)) return false;
      const candidate = elementLabel(node);
      return candidate === text;
    }) || null;
}

function findSelectTarget(options) {
  if (options.selector) {
    const bySelector = [...document.querySelectorAll(options.selector)]
      .find((node) => node.tagName?.toLowerCase() === 'select' && isClickable(node));
    if (bySelector) return bySelector;
  }
  const text = String(options.label || options.textLabel || '').trim();
  if (!text) return null;
  const labels = [...document.querySelectorAll('label')];
  const label = labels.find((node) => normalizeWhitespace(node.innerText || node.textContent || '') === text);
  if (label?.htmlFor) {
    const target = document.getElementById(label.htmlFor);
    if (target?.tagName?.toLowerCase() === 'select' && isClickable(target)) return target;
  }
  return [...document.querySelectorAll('select')]
    .find((node) => {
      if (!isClickable(node)) return false;
      return elementLabel(node) === text;
    }) || null;
}

function findCheckTarget(options) {
  if (options.selector) {
    const bySelector = [...document.querySelectorAll(options.selector)]
      .find((node) => isCheckableInput(node) && (options.force === true || isClickable(node)));
    if (bySelector) return bySelector;
  }
  const text = String(options.label || options.textLabel || '').trim();
  if (!text) return null;
  const labels = [...document.querySelectorAll('label')];
  const label = labels.find((node) => normalizeWhitespace(node.innerText || node.textContent || '') === text);
  if (label?.htmlFor) {
    const target = document.getElementById(label.htmlFor);
    if (isCheckableInput(target) && (options.force === true || isClickable(target))) return target;
  }
  if (label) {
    const nested = label.querySelector('input[type="checkbox"],input[type="radio"]');
    if (isCheckableInput(nested) && (options.force === true || isClickable(nested))) return nested;
  }
  return [...document.querySelectorAll('input[type="checkbox"],input[type="radio"]')]
    .find((node) => {
      if (options.force !== true && !isClickable(node)) return false;
      return elementLabel(node) === text;
    }) || null;
}

function findAnyTarget(options) {
  if (options.selector) {
    const node = document.querySelector(options.selector);
    if (node instanceof Element) return node;
  }
  const text = String(options.label || options.textLabel || options.text || '').trim();
  if (!text) return null;
  const labels = [...document.querySelectorAll('label')];
  const label = labels.find((node) => normalizeWhitespace(node.innerText || node.textContent || '') === text);
  if (label?.htmlFor) {
    const target = document.getElementById(label.htmlFor);
    if (target instanceof Element) return target;
  }
  return [...document.querySelectorAll('input,textarea,select,button,a,[role],[aria-label],[title],[data-testid]')]
    .find((node) => elementLabel(node) === text) || null;
}

function collectLocatorTargets(options = {}) {
  let nodes = [];
  if (options.selector) {
    nodes = [...document.querySelectorAll(String(options.selector))];
  } else {
    const text = String(options.label || options.textLabel || options.name || options.text || '').trim();
    const exact = options.exact !== false;
    const role = String(options.role || '').trim().toLowerCase();
    const candidates = [...document.querySelectorAll('input,textarea,select,button,a,[role],[aria-label],[title],[data-testid]')];
    nodes = candidates.filter((node) => {
      if (!(node instanceof Element)) return false;
      if (role) {
        const nodeRole = String(node.getAttribute('role') || implicitRole(node) || '').toLowerCase();
        if (nodeRole !== role) return false;
      }
      if (!text) return true;
      const label = elementLabel(node);
      return exact ? label === text : label.toLowerCase().includes(text.toLowerCase());
    });
  }
  if (options.visible === true) {
    nodes = nodes.filter(isElementActuallyVisible);
  } else if (options.visible === false) {
    nodes = nodes.filter((node) => !isElementActuallyVisible(node));
  }
  const nth = Number(options.nth ?? options.index);
  if (Number.isInteger(nth) && nth >= 0) return nodes[nth] ? [nodes[nth]] : [];
  if (options.first === true) return nodes[0] ? [nodes[0]] : [];
  if (options.last === true) return nodes.length ? [nodes[nodes.length - 1]] : [];
  if (options.all === true || options.multiple === true || options.mode === 'all' || options.mode === 'count') {
    return nodes;
  }
  return nodes[0] ? [nodes[0]] : [];
}

function normalizeLocatorLimit(value) {
  const limit = Number(value || 50);
  return Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
}

function findSelectOption(select, options) {
  const optionValue = options.value != null ? String(options.value) : '';
  const optionText = String(options.optionText || options.text || options.label || options.labelText || '').trim();
  const optionIndex = options.index != null ? Number(options.index) : null;
  const entries = [...select.options];
  if (optionValue) {
    const option = entries.find((entry) => entry.value === optionValue);
    if (option) return option;
  }
  if (optionText) {
    const option = entries.find((entry) => normalizeWhitespace(entry.textContent || entry.label || '') === optionText);
    if (option) return option;
  }
  if (Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < entries.length) return entries[optionIndex];
  return null;
}

function normalizeSelectSelections(options = {}) {
  if (Array.isArray(options.selections) && options.selections.length) {
    return options.selections.filter((item) => item && typeof item === 'object');
  }
  return [{
    value: options.value,
    label: options.label,
    text: options.optionText || options.text || options.labelText,
    index: options.index,
  }];
}

function readElementValue(node) {
  const tag = node.tagName?.toLowerCase();
  if (tag === 'select') {
    const selected = [...(node.selectedOptions || [])];
    if (node.multiple) return selected[0]?.value ?? null;
    return node.value ?? null;
  }
  if (tag === 'input') {
    const type = String(node.type || '').toLowerCase();
    if (['checkbox', 'radio'].includes(type)) return node.checked ? (node.value || 'on') : null;
    return node.value ?? '';
  }
  if (tag === 'textarea') return node.value ?? '';
  if (node.isContentEditable) return node.textContent ?? '';
  return node.getAttribute('value') ?? (normalizeWhitespace(node.innerText || node.textContent || '') || null);
}

function readElementValues(node) {
  const tag = node.tagName?.toLowerCase();
  if (tag === 'select') return [...(node.selectedOptions || [])].map((option) => option.value);
  if (tag === 'input') {
    const type = String(node.type || '').toLowerCase();
    if (['checkbox', 'radio'].includes(type)) return node.checked ? [node.value || 'on'] : [];
    return [node.value ?? ''];
  }
  const value = readElementValue(node);
  return value == null ? [] : [String(value)];
}

function elementReadSnapshot(node) {
  return {
    attributes: Object.fromEntries([...node.attributes || []].map((attr) => [attr.name, attr.value])),
    inner_text: normalizeWhitespace(node.innerText || ''),
    text_content: node.textContent,
    value: readElementValue(node),
    enabled: isElementEnabled(node),
    visible: isElementActuallyVisible(node),
    selector: cssPath(node),
    descriptor: elementDescriptor(node),
  };
}

function isElementEnabled(node) {
  if (!(node instanceof Element)) return false;
  if (node.hasAttribute('disabled')) return false;
  if (String(node.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
  return true;
}

function isElementActuallyVisible(node) {
  if (!(node instanceof Element)) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeCheckedValue(options = {}) {
  if (typeof options.checked === 'boolean') return options.checked;
  if (typeof options.value === 'boolean') return options.value;
  return true;
}

function isInputLike(node) {
  if (!node) return false;
  const tag = node.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || node.isContentEditable;
}

function isCheckableInput(node) {
  if (!node || node.tagName?.toLowerCase() !== 'input') return false;
  return ['checkbox', 'radio'].includes(String(node.type || '').toLowerCase());
}

function elementLabel(node) {
  return normalizeWhitespace(
    node.innerText
    || node.textContent
    || node.value
    || node.getAttribute('aria-label')
    || node.getAttribute('title')
    || node.getAttribute('placeholder')
    || ''
  );
}

function isDangerousElement(node, label = '') {
  const text = [
    label,
    node.getAttribute?.('aria-label') || '',
    node.getAttribute?.('title') || '',
    node.getAttribute?.('data-testid') || '',
    node.getAttribute?.('class') || '',
    node.getAttribute?.('id') || '',
    node.getAttribute?.('type') || '',
  ].join(' ');
  return DANGEROUS_ACTION_TEXT.test(text);
}

function isClickable(node) {
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
  return !disabled && rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
}

function isHoverable(node) {
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
}

function isInteractableCandidate(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') return false;
  return true;
}

function isVisibleElement(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function normalizeSelectorWaitState(value) {
  const state = String(value || 'visible').trim();
  if (['attached', 'detached', 'visible', 'hidden'].includes(state)) return state;
  return 'visible';
}

function elementDescriptor(node) {
  const rect = node.getBoundingClientRect();
  const selector = cssPath(node);
  const text = visibleText(node);
  const ariaName = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('alt') || null;
  const testId = node.getAttribute('data-testid') || node.getAttribute('data-test') || node.getAttribute('data-test-id') || null;
  return {
    nodeId: getNodeId(node),
    tagName: node.tagName.toLowerCase(),
    role: node.getAttribute('role') || implicitRole(node) || null,
    visibleText: text || null,
    ariaName,
    testId,
    boundingBox: {
      x: Number(rect.left.toFixed(3)),
      y: Number(rect.top.toFixed(3)),
      width: Number(rect.width.toFixed(3)),
      height: Number(rect.height.toFixed(3)),
    },
    preview: buildElementPreview(node, text, ariaName),
    selector: {
      primary: selector || null,
      candidates: selector ? [selector] : [],
      frameSelectors: [],
    },
  };
}

function getNodeId(node) {
  if (!(node instanceof Element)) return null;
  const existing = nodeIds.get(node);
  if (existing) return existing;
  const id = nextNodeId;
  nextNodeId += 1;
  nodeIds.set(node, id);
  nodesById.set(id, node);
  return id;
}

function findNodeById(options = {}) {
  const nodeId = normalizeNodeId(options);
  if (!nodeId) return null;
  const node = nodesById.get(nodeId);
  if (!(node instanceof Element) || !node.isConnected) {
    nodesById.delete(nodeId);
    return null;
  }
  return node;
}

function normalizeNodeId(options = {}) {
  const raw = options.nodeId ?? options.node_id;
  const nodeId = Number(raw);
  return Number.isInteger(nodeId) && nodeId > 0 ? nodeId : 0;
}

function dispatchElementClick(target, options = {}) {
  const rect = target.getBoundingClientRect();
  const x = Number.isFinite(Number(options.x)) ? Number(options.x) : rect.left + rect.width / 2;
  const y = Number.isFinite(Number(options.y)) ? Number(options.y) : rect.top + rect.height / 2;
  const clickCount = normalizeClickCount(options);
  const init = mouseEventInit(options, x, y);
  for (let index = 0; index < clickCount; index += 1) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const event = type.startsWith('pointer')
        ? new PointerEvent(type, { ...init, pointerType: 'mouse' })
        : new MouseEvent(type, init);
      target.dispatchEvent(event);
    }
  }
  if (clickCount > 1) {
    target.dispatchEvent(new MouseEvent('dblclick', init));
  }
}

function mouseEventInit(options, x, y) {
  const button = normalizeMouseButton(options.button);
  return {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button,
    buttons: button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : 0,
    ...eventModifierFlags(options),
  };
}

function eventModifierFlags(options = {}) {
  const modifiers = normalizeEventModifierNames(options);
  return {
    altKey: modifiers.includes('Alt'),
    ctrlKey: modifiers.includes('Control'),
    metaKey: modifiers.includes('Meta'),
    shiftKey: modifiers.includes('Shift'),
  };
}

function normalizeEventModifierNames(options = {}) {
  const raw = [
    ...(Array.isArray(options.modifiers) ? options.modifiers : []),
    ...(Array.isArray(options.keys) ? options.keys : []),
  ];
  const modifiers = new Set();
  for (const item of raw) {
    const key = normalizeModifierName(item);
    if (key) modifiers.add(key);
  }
  return [...modifiers].sort();
}

function normalizeModifierName(value) {
  switch (String(value || '').replace(/[\s_-]/g, '').toLowerCase()) {
    case 'alt':
    case 'option':
      return 'Alt';
    case 'control':
    case 'ctrl':
      return 'Control';
    case 'controlormeta':
    case 'cmdorctrl':
    case 'commandorcontrol':
      return isMacPlatform() ? 'Meta' : 'Control';
    case 'meta':
    case 'cmd':
    case 'command':
      return 'Meta';
    case 'shift':
      return 'Shift';
    default:
      return '';
  }
}

function normalizeMouseButton(value) {
  switch (String(value || 'left').toLowerCase()) {
    case 'middle':
      return 1;
    case 'right':
      return 2;
    case 'left':
    default:
      return 0;
  }
}

function normalizeMouseButtonName(value) {
  switch (normalizeMouseButton(value)) {
    case 1:
      return 'middle';
    case 2:
      return 'right';
    case 0:
    default:
      return 'left';
  }
}

function normalizeClickCount(options = {}) {
  const explicit = Number(options.clickCount || options.click_count || 0);
  if (Number.isInteger(explicit) && explicit > 1) return Math.min(explicit, 2);
  return options.doubleClick === true || options.double_click === true ? 2 : 1;
}

function isMacPlatform() {
  return /mac/i.test(String(globalThis.navigator?.platform || globalThis.navigator?.userAgent || ''));
}

function visibleText(node) {
  return normalizeWhitespace(
    node.innerText
    || node.textContent
    || node.value
    || ''
  ).slice(0, 240);
}

function buildElementPreview(node, text, ariaName) {
  const parts = [node.tagName.toLowerCase()];
  const id = node.getAttribute('id');
  if (id) parts.push(`#${id}`);
  const role = node.getAttribute('role') || implicitRole(node);
  if (role) parts.push(`[role=${role}]`);
  if (ariaName) parts.push(`aria="${ariaName.slice(0, 120)}"`);
  if (text) parts.push(`text="${text.slice(0, 120)}"`);
  return parts.join(' ');
}

function implicitRole(node) {
  const tag = node.tagName?.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && node.getAttribute('href')) return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = String(node.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    return 'textbox';
  }
  if (tag === 'img') return 'img';
  return null;
}

function scrollableContainers() {
  return [...document.querySelectorAll('main,section,div,ul,ol')]
    .filter((node) => {
      const style = window.getComputedStyle(node);
      return /(auto|scroll)/.test(`${style.overflow}${style.overflowY}`) && node.scrollHeight > node.clientHeight + 120;
    })
    .slice(0, 20);
}
