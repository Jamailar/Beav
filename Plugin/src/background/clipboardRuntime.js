import { attachCdpTab, getDefaultCdpTimeoutMs, sendCdpCommandWithTimeout } from './cdpTransport.js';

const CDP_COMMAND_TIMEOUT_MS = getDefaultCdpTimeoutMs();

export async function readPageClipboard(action = {}) {
  const tabId = requireTabId(action, 'page.readClipboard');
  const timeoutMs = normalizeTimeout(action.timeoutMs ?? action.timeout_ms, CDP_COMMAND_TIMEOUT_MS);
  await withLocalTimeout(grantClipboardPermissions(tabId, timeoutMs), Math.min(timeoutMs, 5_000), 'clipboard permission grant').catch(() => {});
  const [result] = await withLocalTimeout(chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (pageTimeoutMs) => {
      const timeoutMs = Math.max(250, Math.min(Number(pageTimeoutMs || 1_500), 3_000));
      const errors = [];
      if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
        try {
          const clipboardItems = await withPageTimeout(navigator.clipboard.read(), timeoutMs, 'navigator.clipboard.read');
          const items = [];
          for (const clipboardItem of clipboardItems) {
            const entries = [];
            for (const mimeType of clipboardItem.types || []) {
              const blob = await withPageTimeout(clipboardItem.getType(mimeType), timeoutMs, `clipboardItem.getType(${mimeType})`);
              if (/^text\//i.test(mimeType) || mimeType === 'application/json') {
                entries.push({ mime_type: mimeType, text: await withPageTimeout(blob.text(), timeoutMs, `clipboard blob text ${mimeType}`) });
              } else {
                entries.push({ mime_type: mimeType, base64: await withPageTimeout(blobToBase64(blob), timeoutMs, `clipboard blob base64 ${mimeType}`) });
              }
            }
            items.push({ entries, presentation_style: clipboardItem.presentationStyle || 'unspecified' });
          }
          return { success: true, items };
        } catch (error) {
          errors.push(error?.message || String(error));
        }
      }
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        try {
          const text = await withPageTimeout(navigator.clipboard.readText(), timeoutMs, 'navigator.clipboard.readText');
          return { success: true, items: [{ entries: [{ mime_type: 'text/plain', text }], presentation_style: 'unspecified' }] };
        } catch (error) {
          errors.push(error?.message || String(error));
        }
      }
      try {
        const textarea = document.createElement('textarea');
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const ok = document.execCommand('paste');
        const text = textarea.value || '';
        textarea.remove();
        if (ok) return { success: true, items: [{ entries: [{ mime_type: 'text/plain', text }], presentation_style: 'unspecified' }] };
        errors.push('document.execCommand("paste") returned false');
      } catch (error) {
        errors.push(error?.message || String(error));
      }
      return { success: false, error: `Clipboard read is not available on this page: ${errors.join('; ') || 'no supported API'}` };

      function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
          reader.onerror = () => reject(reader.error || new Error('Failed to read clipboard blob'));
          reader.readAsDataURL(blob);
        });
      }

      function withPageTimeout(promise, timeoutMs, label) {
        let timer = null;
        return Promise.race([
          promise,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
      }
    },
    args: [Math.min(timeoutMs, 2_000)],
  }), timeoutMs, 'page.readClipboard');
  const value = result?.result || {};
  const error = result?.error?.message || value.error || '';
  if (value.success !== true && action.pasteFallback !== false && action.allowPasteFallback !== false) {
    return await readClipboardViaPasteShortcut(tabId, timeoutMs, error);
  }
  return {
    success: value.success === true,
    tabId,
    items: Array.isArray(value.items) ? value.items : [],
    ...(error ? { error } : {}),
  };
}

export async function readPageClipboardText(action = {}) {
  const result = await readPageClipboard(action);
  const text = extractClipboardText(result.items);
  return {
    success: result.success === true,
    tabId: result.tabId,
    text,
    ...(result.error ? { error: result.error } : {}),
  };
}

export async function writePageClipboard(action = {}) {
  const tabId = requireTabId(action, 'page.writeClipboard');
  const items = normalizeClipboardItems(action);
  const timeoutMs = normalizeTimeout(action.timeoutMs ?? action.timeout_ms, CDP_COMMAND_TIMEOUT_MS);
  await withLocalTimeout(grantClipboardPermissions(tabId, timeoutMs), Math.min(timeoutMs, 5_000), 'clipboard permission grant').catch(() => {});
  const [result] = await withLocalTimeout(chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (clipboardItems, pageTimeoutMs) => {
      const timeoutMs = Math.max(250, Math.min(Number(pageTimeoutMs || 1_500), 3_000));
      const textEntry = clipboardItems.flatMap((item) => item.entries || []).find((entry) => entry.mime_type === 'text/plain' && entry.text != null);
      const errors = [];
      if (navigator.clipboard && typeof ClipboardItem === 'function' && typeof navigator.clipboard.write === 'function') {
        try {
          const nativeItems = clipboardItems.map((item) => {
            const entries = {};
            for (const entry of item.entries || []) {
              entries[entry.mime_type] = entry.text != null
                ? new Blob([entry.text], { type: entry.mime_type })
                : new Blob([base64ToBytes(entry.base64 || '')], { type: entry.mime_type });
            }
            return new ClipboardItem(entries, { presentationStyle: item.presentation_style || 'unspecified' });
          });
          await withPageTimeout(navigator.clipboard.write(nativeItems), timeoutMs, 'navigator.clipboard.write');
          return { success: true, itemCount: clipboardItems.length };
        } catch (error) {
          errors.push(error?.message || String(error));
        }
      }
      if (!textEntry) throw new Error('Clipboard write fallback only supports text/plain');
      if (typeof navigator.clipboard.writeText === 'function') {
        try {
          await withPageTimeout(navigator.clipboard.writeText(textEntry.text), timeoutMs, 'navigator.clipboard.writeText');
          return { success: true, itemCount: 1 };
        } catch (error) {
          errors.push(error?.message || String(error));
        }
      }
      const textarea = document.createElement('textarea');
      textarea.value = textEntry.text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      if (!ok) throw new Error('Clipboard execCommand fallback failed');
      return { success: true, itemCount: 1 };

      function base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
      }

      function withPageTimeout(promise, timeoutMs, label) {
        let timer = null;
        return Promise.race([
          promise,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
      }
    },
    args: [items, Math.min(timeoutMs, 2_000)],
  }), timeoutMs, 'page.writeClipboard');
  const value = result?.result || {};
  const error = result?.error?.message || value.error || '';
  return {
    success: value.success === true,
    tabId,
    items,
    itemCount: Number(value.itemCount || items.length),
    ...(error ? { error } : {}),
  };
}

export async function writePageClipboardText(action = {}) {
  const result = await writePageClipboard({
    ...action,
    text: String(action.text ?? ''),
  });
  return {
    success: result.success === true,
    tabId: result.tabId,
    text: String(action.text ?? ''),
    itemCount: result.itemCount,
    ...(result.error ? { error: result.error } : {}),
  };
}

function extractClipboardText(items = []) {
  return String((Array.isArray(items) ? items : [])
    .flatMap((item) => item.entries || [])
    .find((entry) => entry.mime_type === 'text/plain' && entry.text != null)?.text || '');
}

function normalizeClipboardItems(action = {}) {
  const rawItems = Array.isArray(action.items) ? action.items : [];
  if (!rawItems.length && action.text != null) {
    return [{ entries: [{ mime_type: 'text/plain', text: String(action.text) }], presentation_style: 'unspecified' }];
  }
  const items = rawItems.map((item, itemIndex) => {
    const entries = (Array.isArray(item.entries) ? item.entries : []).map((entry, entryIndex) => {
      const mimeType = String(entry.mime_type || entry.mimeType || '').trim();
      if (!mimeType) throw new Error(`Clipboard item ${itemIndex} entry ${entryIndex} requires mime_type`);
      const hasText = entry.text !== undefined;
      const hasBase64 = entry.base64 !== undefined;
      if (hasText === hasBase64) throw new Error(`Clipboard item ${itemIndex} entry ${entryIndex} must set exactly one of text or base64`);
      return {
        mime_type: mimeType,
        ...(hasText ? { text: String(entry.text) } : { base64: String(entry.base64 || '') }),
      };
    });
    if (!entries.length) throw new Error(`Clipboard item ${itemIndex} requires entries`);
    const presentationStyle = String(item.presentation_style || item.presentationStyle || 'unspecified');
    if (!['unspecified', 'inline', 'attachment'].includes(presentationStyle)) throw new Error(`Invalid clipboard presentation_style: ${presentationStyle}`);
    return { entries, presentation_style: presentationStyle };
  });
  if (!items.length) throw new Error('page.writeClipboard requires items or text');
  return items;
}

async function grantClipboardPermissions(tabId, timeoutMs) {
  const tab = await chrome.tabs.get(tabId);
  const origin = getOrigin(tab.url || '');
  if (!origin) return;
  await attachCdpTab(tabId);
  const errors = [];
  try {
    await sendCdpCommandWithTimeout({ tabId }, 'Browser.grantPermissions', {
      origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    }, timeoutMs);
    return;
  } catch (error) {
    errors.push(error?.message || String(error));
  }
  for (const name of ['clipboard-read', 'clipboard-write']) {
    try {
      await sendCdpCommandWithTimeout({ tabId }, 'Browser.setPermission', {
        origin,
        setting: 'granted',
        permission: { name },
      }, timeoutMs);
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  if (errors.length >= 3) throw new Error(`clipboard permission grant failed: ${errors.join('; ')}`);
}

async function readClipboardViaPasteShortcut(tabId, timeoutMs, priorError = '') {
  const targetId = `xwow-clipboard-paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await withLocalTimeout(chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (id) => {
      const previous = document.getElementById(id);
      if (previous) previous.remove();
      const textarea = document.createElement('textarea');
      textarea.id = id;
      textarea.setAttribute('aria-hidden', 'true');
      textarea.style.position = 'fixed';
      textarea.style.left = '-10000px';
      textarea.style.top = '0';
      textarea.style.width = '1px';
      textarea.style.height = '1px';
      textarea.style.opacity = '0';
      document.documentElement.appendChild(textarea);
      textarea.focus();
      textarea.select();
      return { success: document.activeElement === textarea };
    },
    args: [targetId],
  }), timeoutMs, 'clipboard paste target setup');
  await attachCdpTab(tabId);
  await dispatchPasteShortcut(tabId, timeoutMs).catch(async () => {
    await dispatchPasteShortcut(tabId, timeoutMs, 'Control');
  });
  await sleep(120);
  const [result] = await withLocalTimeout(chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (id) => {
      const textarea = document.getElementById(id);
      const text = textarea?.value || '';
      textarea?.remove();
      return { success: text.length > 0, text };
    },
    args: [targetId],
  }), timeoutMs, 'clipboard paste target read');
  const text = result?.result?.text || '';
  if (text || result?.result?.success === true) {
    return {
      success: true,
      tabId,
      items: [{ entries: [{ mime_type: 'text/plain', text }], presentation_style: 'unspecified' }],
      source: 'paste_shortcut',
    };
  }
  return {
    success: false,
    tabId,
    items: [],
    error: priorError || 'Clipboard paste shortcut fallback returned empty text',
  };
}

async function dispatchPasteShortcut(tabId, timeoutMs, modifier = 'Meta') {
  const modifierParams = keyEventParams(modifier);
  const modifierMask = modifier === 'Meta' ? 4 : 2;
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', {
    ...modifierParams,
    type: 'rawKeyDown',
    modifiers: modifierMask,
  }, timeoutMs);
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', {
    key: 'v',
    code: 'KeyV',
    text: '',
    unmodifiedText: '',
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    type: 'rawKeyDown',
    modifiers: modifierMask,
    commands: ['paste'],
  }, timeoutMs);
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', {
    key: 'v',
    code: 'KeyV',
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    type: 'keyUp',
    modifiers: modifierMask,
  }, timeoutMs);
  await sendCdpCommandWithTimeout({ tabId }, 'Input.dispatchKeyEvent', {
    ...modifierParams,
    type: 'keyUp',
    modifiers: 0,
  }, timeoutMs);
}

function keyEventParams(key) {
  if (key === 'Meta') {
    return { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91 };
  }
  if (key === 'Control') {
    return { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
  }
  return { key, code: key };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? '' : parsed.origin;
  } catch {
    return '';
  }
}

function requireTabId(action = {}, actionName = 'clipboard action') {
  const tabId = Number(action.tabId || action.tab_id || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`${actionName} requires integer tabId`);
  return tabId;
}

function normalizeTimeout(value, fallback) {
  const timeoutMs = Number(value || fallback);
  return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : fallback;
}

function withLocalTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
