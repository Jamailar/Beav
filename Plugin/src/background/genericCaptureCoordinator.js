import { normalizeCaptureDocument } from '../capture/captureDocument.js';
import { assessCaptureQuality, applyCaptureQuality } from '../capture/captureQuality.js';
import { GENERIC_CAPTURE_MESSAGE_TYPE } from '../capture/genericCaptureProtocol.js';

const CACHE_TTL_MS = 5_000;
const GENERIC_CAPTURE_SCRIPT = 'genericCaptureContent.js';
const captureCache = new Map();

function isWechatUrl(value) {
  try {
    return new URL(value).hostname === 'mp.weixin.qq.com';
  } catch {
    return false;
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export function clearGenericCaptureCache(tabId) {
  captureCache.delete(Number(tabId));
}

export function createGenericCaptureCoordinator(deps = {}) {
  const now = deps.now || (() => Date.now());
  const timeoutMs = Number(deps.timeoutMs || 4_000);

  function runtime() {
    const scripting = deps.scripting || globalThis.chrome?.scripting;
    const tabs = deps.tabs || globalThis.chrome?.tabs;
    if (!scripting?.executeScript || !tabs?.get || !tabs?.sendMessage) {
      throw new Error('浏览器扩展运行时不可用');
    }
    return { scripting, tabs };
  }

  async function requestDefuddledCapture(tabId) {
    const { scripting, tabs } = runtime();
    await scripting.executeScript({
      target: { tabId },
      files: [GENERIC_CAPTURE_SCRIPT],
      world: 'ISOLATED',
    });
    const response = await withTimeout(
      tabs.sendMessage(tabId, { type: GENERIC_CAPTURE_MESSAGE_TYPE }),
      timeoutMs,
      '网页正文提取',
    );
    if (!response?.ok || !response?.capture) {
      throw new Error(response?.error || '网页正文提取没有返回内容');
    }
    const capture = applyCaptureQuality(normalizeCaptureDocument(response.capture));
    if (!assessCaptureQuality(capture).accepted) {
      throw new Error(capture.status === 'blocked' ? '页面需要登录或安全验证' : '网页正文不足');
    }
    return capture;
  }

  return {
    async extract(tabId) {
      const { tabs } = runtime();
      const tab = await tabs.get(tabId);
      const sourceUrl = String(tab?.url || '');
      // WeChat has an established MAIN-world rich-HTML and image-localization
      // path. Leaving it there guarantees byte-for-byte compatibility.
      if (!sourceUrl || isWechatUrl(sourceUrl)) {
        return { capture: null, reason: 'legacy-required' };
      }
      const cached = captureCache.get(Number(tabId));
      if (cached && cached.url === sourceUrl && now() - cached.at <= CACHE_TTL_MS) {
        return { capture: cached.capture, reason: 'cache-hit' };
      }
      try {
        const capture = await requestDefuddledCapture(tabId);
        captureCache.set(Number(tabId), { url: sourceUrl, at: now(), capture });
        return { capture, reason: 'defuddle' };
      } catch (error) {
        return {
          capture: null,
          reason: 'legacy-required',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export const genericCaptureCoordinator = createGenericCaptureCoordinator();
