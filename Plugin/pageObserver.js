let latestPageInfo = null;
let latestUrl = location.href;
let updateTimer = null;
let fastPollTimer = null;
let fastPollUntil = 0;
let urlWatchTimer = null;
let observerStopped = false;
let observer = null;

let dragOverlayHost = null;
let dragZoneElement = null;
let dragZoneTitleElement = null;
let dragZoneMetaElement = null;
let currentDragPayload = null;
let dragHideTimer = null;
let dragSaveInFlight = false;

const EMIT_DEBOUNCE_MS = 40;
const FAST_POLL_INTERVAL_MS = 120;
const FAST_POLL_DURATION_MS = 2500;
const URL_WATCH_INTERVAL_MS = 150;
const DRAG_HIDE_DELAY_MS = 140;
const DRAG_RESULT_HIDE_DELAY_MS = 1800;

function normalizeText(value) {
    return String(value || '').trim();
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(normalizeText(value));
}

function isDirectResourceSource(value) {
    const raw = normalizeText(value);
    return isHttpUrl(raw) || /^data:image\//i.test(raw);
}

function toAbsoluteUrl(value) {
    const raw = normalizeText(value);
    if (!raw) return '';
    try {
        return new URL(raw, location.href).toString();
    } catch {
        return raw;
    }
}

function isInspectHost() {
    const hostname = String(location.hostname || '').toLowerCase();
    return hostname === 'mp.weixin.qq.com'
        || hostname === 'youtu.be'
        || hostname === 'youtube.com'
        || hostname.endsWith('.youtube.com')
        || /(^|\.)xiaohongshu\.com$/i.test(hostname);
}

function createLinkFallbackPageInfo(overrides = {}) {
    return {
        kind: 'generic',
        action: 'save-page-link',
        label: '仅保存链接到知识库',
        description: '当前页面可作为链接收藏保存到知识库。',
        primaryEnabled: true,
        detected: false,
        statusText: '未检测到内容',
        ...overrides,
    };
}

function getInitialState() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
        const text = script.textContent || '';
        if (!text.includes('window.__INITIAL_STATE__=')) continue;
        try {
            const jsonText = text
                .replace('window.__INITIAL_STATE__=', '')
                .replace(/undefined/g, 'null')
                .replace(/;$/, '');
            return JSON.parse(jsonText);
        } catch {
            return null;
        }
    }
    return null;
}

function detectXhsNoteInfo() {
    function getCurrentStateNote() {
        try {
            const detailMap = getInitialState()?.note?.noteDetailMap || {};
            const keys = Object.keys(detailMap);
            if (keys.length === 0) return null;
            const pathPart = location.pathname.split('/').filter(Boolean).pop() || '';
            if (pathPart && detailMap[pathPart]) {
                return detailMap[pathPart]?.note || detailMap[pathPart];
            }
            return detailMap[keys[0]]?.note || detailMap[keys[0]];
        } catch {
            return null;
        }
    }

    function isNodeVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 24 && rect.height > 24;
    }

    const noteRoot = document.querySelector('#noteContainer, .note-container, .note-content');
    const articleRoot = document.querySelector('[class*="article"], .article-container, .content-container');
    const stateNote = getCurrentStateNote();
    const titleEl = document.querySelector('#detail-title, .note-content #detail-title, .note-content .title, .title');
    const descEl = document.querySelector('#detail-desc, .desc, .note-content .desc, .note-content');
    const imageEls = Array.from(document.querySelectorAll('.img-container img, .note-content .img-container img, .swiper-slide img'))
        .filter((el) => isNodeVisible(el));
    const hasVideo = Boolean(document.querySelector('video, .xgplayer video'));
    const hasStateContent = Boolean(stateNote && (stateNote.title || stateNote.desc || stateNote.video || stateNote.imageList || stateNote.images));
    const hasDomContent = Boolean(
        (titleEl && String(titleEl.textContent || '').trim())
        || (descEl && String(descEl.textContent || '').replace(/\s+/g, ' ').trim().length > 20)
        || imageEls.length > 0
        || hasVideo
    );
    const hasValidNote = Boolean(noteRoot || articleRoot || hasStateContent || hasDomContent);

    if (!hasValidNote) {
        return createLinkFallbackPageInfo({
            kind: 'xhs-pending',
            description: '当前页面还没有稳定识别到有效的小红书笔记内容。',
        });
    }

    return {
        kind: 'xhs-note',
        action: 'save-xhs',
        label: hasVideo && imageEls.length === 0 ? '保存小红书视频笔记到知识库' : '保存小红书图文到知识库',
        description: '当前页面已识别为小红书内容页。',
        primaryEnabled: true,
        detected: true,
    };
}

function detectPageInfo() {
    const hostname = String(location.hostname || '').toLowerCase();
    const pathname = String(location.pathname || '');

    if (hostname === 'mp.weixin.qq.com') {
        return {
            kind: 'wechat-article',
            action: 'save-page-link',
            label: '保存公众号文章到知识库',
            description: '当前页面已识别为公众号文章，将完整保存正文、图片和排版。',
            primaryEnabled: true,
            detected: true,
        };
    }

    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') {
        const isVideoPage = pathname.startsWith('/watch') || pathname.startsWith('/shorts/') || hostname === 'youtu.be';
        if (!isVideoPage) {
            return createLinkFallbackPageInfo({
                kind: 'youtube-generic',
                description: '当前页面还没有稳定识别到有效的视频内容。',
            });
        }
        return {
            kind: 'youtube',
            action: 'save-youtube',
            label: '保存YouTube视频到知识库',
            description: '当前页面已识别为 YouTube 视频页。',
            primaryEnabled: true,
            detected: true,
        };
    }

    if (/(^|\.)xiaohongshu\.com$/i.test(hostname)) {
        return detectXhsNoteInfo();
    }

    return createLinkFallbackPageInfo();
}

function clearDragHideTimer() {
    if (dragHideTimer) {
        clearTimeout(dragHideTimer);
        dragHideTimer = null;
    }
}

function ensureDragDropUi() {
    if (dragOverlayHost?.isConnected) return;
    const host = document.createElement('div');
    host.id = 'redbox-image-dropzone-host';
    host.style.position = 'fixed';
    host.style.right = '18px';
    host.style.top = '50%';
    host.style.transform = 'translateY(-50%)';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    host.style.display = 'none';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .zone {
          width: 248px;
          min-height: 124px;
          box-sizing: border-box;
          border-radius: 20px;
          border: 2px dashed rgba(255, 255, 255, 0.28);
          background:
            linear-gradient(180deg, rgba(18, 23, 34, 0.92), rgba(18, 23, 34, 0.84));
          box-shadow:
            0 24px 60px rgba(0, 0, 0, 0.28),
            inset 0 1px 0 rgba(255, 255, 255, 0.08);
          color: #ffffff;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 10px;
          padding: 18px 18px 16px;
          pointer-events: auto;
          transform: translateY(16px) scale(0.96);
          opacity: 0;
          transition: opacity 0.16s ease, transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        .zone[data-visible="true"] {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        .zone[data-state="ready"] {
          border-color: rgba(115, 205, 255, 0.78);
          background:
            linear-gradient(180deg, rgba(16, 37, 54, 0.96), rgba(18, 30, 44, 0.9));
        }
        .zone[data-state="saving"] {
          border-color: rgba(255, 211, 112, 0.88);
          background:
            linear-gradient(180deg, rgba(64, 46, 15, 0.96), rgba(46, 31, 8, 0.92));
        }
        .zone[data-state="success"] {
          border-color: rgba(120, 226, 168, 0.9);
          background:
            linear-gradient(180deg, rgba(13, 54, 33, 0.96), rgba(10, 42, 26, 0.92));
        }
        .zone[data-state="error"] {
          border-color: rgba(255, 137, 137, 0.9);
          background:
            linear-gradient(180deg, rgba(74, 22, 22, 0.96), rgba(52, 14, 14, 0.92));
        }
        .eyebrow {
          font-size: 11px;
          line-height: 1.4;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.58);
        }
        .title {
          font-size: 16px;
          line-height: 1.35;
          font-weight: 650;
          color: #ffffff;
          word-break: break-word;
        }
        .meta {
          font-size: 12px;
          line-height: 1.55;
          color: rgba(255, 255, 255, 0.76);
          word-break: break-word;
        }
      </style>
	      <div class="zone" data-visible="false" data-state="idle">
	        <div class="eyebrow">RedBox Capture</div>
	        <div class="title">保存图片到 RedBox</div>
	        <div class="meta">松手后会直接保存到素材库，并保留来源域名与原页面链接。</div>
	      </div>
	    `;

    dragOverlayHost = host;
    dragZoneElement = shadow.querySelector('.zone');
    dragZoneTitleElement = shadow.querySelector('.title');
    dragZoneMetaElement = shadow.querySelector('.meta');

    dragZoneElement.addEventListener('dragenter', handleZoneDragEnter);
    dragZoneElement.addEventListener('dragover', handleZoneDragOver);
    dragZoneElement.addEventListener('dragleave', handleZoneDragLeave);
    dragZoneElement.addEventListener('drop', handleZoneDrop);

    (document.body || document.documentElement).appendChild(host);
}

function setDragZoneState(state, payload, message) {
    ensureDragDropUi();
    if (!dragOverlayHost || !dragZoneElement || !dragZoneTitleElement || !dragZoneMetaElement) return;

    const title = normalizeText(payload?.title) || '保存图片到 RedBox';
    dragOverlayHost.style.display = 'block';
    dragZoneElement.dataset.visible = 'true';
    dragZoneElement.dataset.state = state;

    if (state === 'saving') {
        dragZoneTitleElement.textContent = '正在保存到素材库…';
        dragZoneMetaElement.textContent = message || title;
        return;
    }
    if (state === 'success') {
        dragZoneTitleElement.textContent = '已保存到素材库';
        dragZoneMetaElement.textContent = message || title;
        return;
    }
    if (state === 'error') {
        dragZoneTitleElement.textContent = '保存失败';
        dragZoneMetaElement.textContent = message || '当前图片暂时无法导入。';
        return;
    }

    dragZoneTitleElement.textContent = '保存图片到 RedBox';
    dragZoneMetaElement.textContent = message || title;
}

function showDragZone(payload) {
    clearDragHideTimer();
    currentDragPayload = payload;
    setDragZoneState('ready', payload, '松手后会直接保存到素材库。');
}

function hideDragZone(immediate = false) {
    clearDragHideTimer();
    const applyHide = () => {
        if (!dragOverlayHost || !dragZoneElement) return;
        dragZoneElement.dataset.visible = 'false';
        dragZoneElement.dataset.state = 'idle';
        dragOverlayHost.style.display = 'none';
        if (!dragSaveInFlight) {
            currentDragPayload = null;
        }
    };

    if (immediate) {
        applyHide();
        return;
    }

    dragHideTimer = setTimeout(applyHide, DRAG_HIDE_DELAY_MS);
}

function readTransferData(dataTransfer, type) {
    try {
        return String(dataTransfer?.getData(type) || '');
    } catch {
        return '';
    }
}

function parseDownloadUrl(raw) {
    const firstColon = raw.indexOf(':');
    const secondColon = firstColon >= 0 ? raw.indexOf(':', firstColon + 1) : -1;
    if (firstColon <= 0 || secondColon <= firstColon) {
        return null;
    }
    return {
        mime: raw.slice(0, firstColon),
        filename: raw.slice(firstColon + 1, secondColon),
        url: raw.slice(secondColon + 1),
    };
}

function extractImagePayloadFromTransfer(dataTransfer) {
    const downloadUrl = parseDownloadUrl(readTransferData(dataTransfer, 'DownloadURL'));
    if (downloadUrl?.mime?.startsWith('image/')) {
        const imageUrl = toAbsoluteUrl(downloadUrl.url);
        if (isDirectResourceSource(imageUrl)) {
            return {
                imageUrl,
                title: normalizeText(downloadUrl.filename),
            };
        }
    }

    const html = readTransferData(dataTransfer, 'text/html');
    if (html) {
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const img = doc.querySelector('img');
            const imageUrl = toAbsoluteUrl(img?.getAttribute('src') || img?.getAttribute('data-src'));
            if (isDirectResourceSource(imageUrl)) {
                return {
                    imageUrl,
                    title: normalizeText(img?.getAttribute('alt') || img?.getAttribute('title')),
                };
            }
        } catch {
            // ignore malformed drag html
        }
    }

    return null;
}

function extractDraggedImagePayload(event) {
    const target = event.target instanceof Element ? event.target : null;
    const pathImage = Array.isArray(event.composedPath?.())
        ? event.composedPath().find((item) => item instanceof HTMLImageElement)
        : null;
    const imageElement = target?.closest('img') || pathImage || null;

    const elementUrl = toAbsoluteUrl(imageElement?.currentSrc || imageElement?.src);
    if (isDirectResourceSource(elementUrl)) {
        return {
            imageUrl: elementUrl,
            pageUrl: location.href,
            title: normalizeText(imageElement?.alt || imageElement?.title || document.title) || '网页图片',
        };
    }

    const transferPayload = extractImagePayloadFromTransfer(event.dataTransfer);
    if (transferPayload?.imageUrl) {
        return {
            imageUrl: transferPayload.imageUrl,
            pageUrl: location.href,
            title: transferPayload.title || normalizeText(document.title) || '网页图片',
        };
    }

    return null;
}

async function persistDraggedImage(payload) {
    dragSaveInFlight = true;
    setDragZoneState('saving', payload, normalizeText(payload?.title) || normalizeText(payload?.imageUrl));
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'save-drag-image',
            payload,
        });
        if (!response?.success) {
            throw new Error(response?.error || '图片保存失败');
        }
        setDragZoneState('success', payload, '图片已保存到素材库。');
    } catch (error) {
        const message = String(error?.message || error || '图片保存失败');
        console.warn('[redbox-plugin][page-observer] drag image save failed', message);
        setDragZoneState('error', payload, message);
    } finally {
        dragSaveInFlight = false;
        currentDragPayload = null;
        clearDragHideTimer();
        dragHideTimer = setTimeout(() => hideDragZone(true), DRAG_RESULT_HIDE_DELAY_MS);
    }
}

function handleZoneDragEnter(event) {
    const payload = currentDragPayload || extractDraggedImagePayload(event);
    if (!payload) return;
    event.preventDefault();
    event.stopPropagation();
    showDragZone(payload);
}

function handleZoneDragOver(event) {
    const payload = currentDragPayload || extractDraggedImagePayload(event);
    if (!payload || dragSaveInFlight) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
    }
    showDragZone(payload);
}

function handleZoneDragLeave(event) {
    if (dragSaveInFlight) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && dragZoneElement?.contains(nextTarget)) {
        return;
    }
    setDragZoneState('ready', currentDragPayload, '松手后会直接保存到素材库。');
}

function handleZoneDrop(event) {
    const payload = currentDragPayload || extractDraggedImagePayload(event);
    event.preventDefault();
    event.stopPropagation();
    if (!payload || dragSaveInFlight) {
        hideDragZone(true);
        return;
    }
    void persistDraggedImage(payload);
}

function handleDocumentDragStart(event) {
    if (observerStopped || dragSaveInFlight) return;
    const payload = extractDraggedImagePayload(event);
    if (!payload) {
        currentDragPayload = null;
        hideDragZone(true);
        return;
    }
    showDragZone(payload);
}

function handleDocumentDragEnd() {
    if (dragSaveInFlight) return;
    hideDragZone();
}

function handleDocumentDrop(event) {
    if (dragSaveInFlight) return;
    if (dragZoneElement && event.composedPath().includes(dragZoneElement)) {
        return;
    }
    hideDragZone(true);
}

function handleWindowBlur() {
    if (dragSaveInFlight) return;
    hideDragZone(true);
}

function handlePageHide() {
    if (dragSaveInFlight) return;
    hideDragZone(true);
}

function stopObservers() {
    observerStopped = true;
    if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
    }
    if (fastPollTimer) {
        clearInterval(fastPollTimer);
        fastPollTimer = null;
    }
    if (urlWatchTimer) {
        clearInterval(urlWatchTimer);
        urlWatchTimer = null;
    }
    clearDragHideTimer();
    currentDragPayload = null;
    dragSaveInFlight = false;
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    document.removeEventListener('dragstart', handleDocumentDragStart, true);
    document.removeEventListener('dragend', handleDocumentDragEnd, true);
    document.removeEventListener('drop', handleDocumentDrop, true);
    window.removeEventListener('blur', handleWindowBlur, true);
    window.removeEventListener('pagehide', handlePageHide, true);
    if (dragZoneElement) {
        dragZoneElement.removeEventListener('dragenter', handleZoneDragEnter);
        dragZoneElement.removeEventListener('dragover', handleZoneDragOver);
        dragZoneElement.removeEventListener('dragleave', handleZoneDragLeave);
        dragZoneElement.removeEventListener('drop', handleZoneDrop);
    }
    if (dragOverlayHost?.isConnected) {
        dragOverlayHost.remove();
    }
    dragOverlayHost = null;
    dragZoneElement = null;
    dragZoneTitleElement = null;
    dragZoneMetaElement = null;
}

function isContextInvalidatedError(error) {
    const message = String(error?.message || error || '');
    return message.includes('Extension context invalidated');
}

function emitPageState() {
    if (observerStopped) return;
    latestPageInfo = detectPageInfo();
    try {
        chrome.runtime.sendMessage({
            type: 'page-state:update',
            pageInfo: latestPageInfo,
            url: location.href,
        }).catch((error) => {
            if (isContextInvalidatedError(error)) {
                stopObservers();
                return;
            }
            console.warn('[redbox-plugin][page-observer] page-state:update failed', error);
        });
    } catch (error) {
        if (isContextInvalidatedError(error)) {
            stopObservers();
            return;
        }
        console.warn('[redbox-plugin][page-observer] page-state:update threw', error);
    }
}

function scheduleEmit(delay = EMIT_DEBOUNCE_MS) {
    if (observerStopped) return;
    if (updateTimer) {
        clearTimeout(updateTimer);
    }
    updateTimer = setTimeout(() => {
        if (latestUrl !== location.href) {
            latestUrl = location.href;
        }
        emitPageState();
    }, delay);
}

function startFastPolling(duration = FAST_POLL_DURATION_MS) {
    if (observerStopped) return;
    fastPollUntil = Math.max(fastPollUntil, Date.now() + duration);
    if (fastPollTimer) return;

    fastPollTimer = setInterval(() => {
        emitPageState();
        if (Date.now() >= fastPollUntil) {
            clearInterval(fastPollTimer);
            fastPollTimer = null;
        }
    }, FAST_POLL_INTERVAL_MS);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (observerStopped) {
        sendResponse({ success: false, error: 'observer-stopped' });
        return false;
    }
    if (message?.type === 'page-state:get') {
        if (!latestPageInfo || latestUrl !== location.href) {
            latestUrl = location.href;
            latestPageInfo = detectPageInfo();
        }
        sendResponse({ success: true, pageInfo: latestPageInfo });
        return true;
    }
    return false;
});

document.addEventListener('dragstart', handleDocumentDragStart, true);
document.addEventListener('dragend', handleDocumentDragEnd, true);
document.addEventListener('drop', handleDocumentDrop, true);
window.addEventListener('blur', handleWindowBlur, true);
window.addEventListener('pagehide', handlePageHide, true);

if (isInspectHost()) {
    observer = new MutationObserver(() => {
        scheduleEmit();
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: false,
    });

    urlWatchTimer = setInterval(() => {
        if (latestUrl !== location.href) {
            latestUrl = location.href;
            scheduleEmit(0);
            startFastPolling();
        }
    }, URL_WATCH_INTERVAL_MS);

    window.addEventListener('load', () => {
        scheduleEmit(0);
        startFastPolling();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            scheduleEmit(0);
            startFastPolling(1500);
        }
    });

    scheduleEmit(0);
    startFastPolling();
} else {
    latestPageInfo = detectPageInfo();
}
