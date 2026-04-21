let latestPageInfo = null;
let latestUrl = location.href;
let updateTimer = null;
let fastPollTimer = null;
let fastPollUntil = 0;
let urlWatchTimer = null;
let observerStopped = false;
let observer = null;
let pageRouteBridgeInstalled = false;

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
const PAGE_ROUTE_EVENT_NAME = 'redbox:locationchange';

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
        || /(^|\.)xiaohongshu\.com$/i.test(hostname)
        || /(^|\.)douyin\.com$/i.test(hostname);
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

function isNodeVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
        return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 24 && rect.height > 24;
}

function normalizeCollapsedText(value) {
    return String(value || '').replace(/\s+/g, '').trim();
}

function isCommentRelatedNode(el) {
    if (!el || !el.closest) return false;
    return Boolean(
        el.closest('.comments-el')
        || el.closest('.comment-list')
        || el.closest('.comment-item')
        || el.closest('.comment-container')
        || el.closest('.comments-container')
        || el.closest('[class*="comment"]')
        || el.closest('[id*="comment"]')
    );
}

function getActiveXhsDetailMask() {
    const strictMasks = Array.from(document.querySelectorAll('.note-detail-mask[note-id]'));
    const looseMasks = Array.from(document.querySelectorAll('.note-detail-mask'));
    const masks = strictMasks.length > 0 ? strictMasks : looseMasks;
    if (masks.length === 0) return null;
    const scored = masks
        .filter((mask) => mask instanceof Element)
        .map((mask, index) => {
            const style = window.getComputedStyle(mask);
            const rect = mask.getBoundingClientRect();
            const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 80 && rect.height > 80;
            const container = mask.querySelector('#noteContainer.note-container, #noteContainer, .note-container');
            const titleEl = container?.querySelector?.('#detail-title, .note-content #detail-title, .note-content .title');
            const titleText = normalizeText(titleEl?.textContent || '');
            const area = Math.max(0, rect.width * rect.height);
            let score = 0;
            if (visible) score += 100000;
            if (container) score += 10000;
            if (titleText) score += 1000;
            score += Math.floor(area / 100);
            score += index;
            return { mask, score };
        })
        .sort((a, b) => b.score - a.score);
    return scored[0]?.mask || masks[masks.length - 1] || null;
}

function getCurrentOpenedXhsNoteId() {
    const mask = getActiveXhsDetailMask();
    if (!mask) return '';
    return normalizeText(mask.getAttribute('note-id') || '');
}

function getCurrentXhsNoteRoot() {
    const directRoot =
        document.querySelector('#noteContainer.note-container[data-render-status]')
        || document.querySelector('#noteContainer.note-container')
        || document.querySelector('#noteContainer');
    if (directRoot && isNodeVisible(directRoot)) {
        return directRoot;
    }

    const mask = getActiveXhsDetailMask();
    if (mask) {
        const scoped =
            mask.querySelector('#noteContainer.note-container')
            || mask.querySelector('#noteContainer')
            || mask.querySelector('.note-container')
            || null;
        if (scoped && isNodeVisible(scoped)) {
            return scoped;
        }
    }

    const anchor =
        document.querySelector('#detail-desc')
        || document.querySelector('#detail-title')
        || document.querySelector('.note-content')
        || null;
    if (!anchor) return null;

    const resolved =
        anchor.closest('#noteContainer.note-container')
        || anchor.closest('#noteContainer')
        || anchor.closest('.note-container')
        || anchor.closest('#detail-container')
        || anchor.closest('.note-content')
        || anchor.closest('[class*="note-container"]')
        || anchor.closest('[class*="note-content"]')
        || anchor.parentElement
        || null;
    return resolved && isNodeVisible(resolved) ? resolved : null;
}

function getXhsNoteTitle(root) {
    return normalizeText(
        document.querySelector('#detail-title')?.innerText
        || root?.querySelector?.('#detail-title')?.innerText
        || root?.querySelector?.('.note-title')?.innerText
        || root?.querySelector?.('.title')?.innerText
        || document.querySelector('meta[property="og:title"]')?.getAttribute('content')
        || document.title
    );
}

function getXhsTextContent(root) {
    const textEls = Array.from(root?.querySelectorAll?.('#detail-desc .note-text, .desc .note-text, .note-content .note-text') || []);
    const joined = textEls
        .map((el) => normalizeText(el.innerText))
        .filter(Boolean)
        .join('\n\n');
    if (joined) return joined;
    return normalizeText(
        document.querySelector('meta[property="og:description"]')?.getAttribute('content')
        || document.querySelector('meta[name="description"]')?.getAttribute('content')
    );
}

function getCurrentXhsStateEntry() {
    try {
        const detailMap = getInitialState()?.note?.noteDetailMap || {};
        const keys = Object.keys(detailMap);
        if (keys.length === 0) return null;

        const candidates = [];
        const openedNoteId = getCurrentOpenedXhsNoteId();
        if (openedNoteId) candidates.push(openedNoteId);
        const pathPart = location.pathname.split('/').filter(Boolean).pop() || '';
        if (pathPart) candidates.push(pathPart);
        const search = new URLSearchParams(location.search);
        ['noteId', 'note_id', 'id', 'itemId'].forEach((name) => {
            const value = search.get(name);
            if (value) candidates.push(value);
        });

        const uniqCandidates = Array.from(new Set(candidates.filter(Boolean)));
        for (const candidate of uniqCandidates) {
            if (detailMap[candidate]) return detailMap[candidate];
            const matchedKey = keys.find((key) => key === candidate || key.includes(candidate) || candidate.includes(key));
            if (matchedKey) return detailMap[matchedKey];
            const matchedByEntry = keys.find((key) => {
                const entry = detailMap[key];
                const note = entry?.note || entry;
                const entryIds = [note?.noteId, note?.id, entry?.noteId, entry?.id]
                    .filter(Boolean)
                    .map((id) => String(id));
                return entryIds.some((id) => id === candidate || id.includes(candidate) || candidate.includes(id));
            });
            if (matchedByEntry) return detailMap[matchedByEntry];
        }

        const domTitle = normalizeCollapsedText(getXhsNoteTitle(getCurrentXhsNoteRoot()));
        if (domTitle) {
            const titleMatchedKey = keys.find((key) => {
                const entry = detailMap[key];
                const note = entry?.note || entry;
                const entryTitle = normalizeCollapsedText(note?.title || note?.noteTitle || '');
                return entryTitle && (entryTitle === domTitle || entryTitle.includes(domTitle) || domTitle.includes(entryTitle));
            });
            if (titleMatchedKey) return detailMap[titleMatchedKey];
        }

        if (keys.length === 1) return detailMap[keys[0]];
        return null;
    } catch {
        return null;
    }
}

function getCurrentXhsStateNote() {
    const entry = getCurrentXhsStateEntry();
    return entry?.note || entry || null;
}

function isXhsStateAlignedWithDom(note, root) {
    if (!note) return false;
    const openedNoteId = getCurrentOpenedXhsNoteId();
    const stateIds = [note?.noteId, note?.id, note?.note_id]
        .filter(Boolean)
        .map((id) => normalizeText(id));
    if (openedNoteId && stateIds.length > 0) {
        return stateIds.some((id) => id === openedNoteId || id.includes(openedNoteId) || openedNoteId.includes(id));
    }
    const domTitle = normalizeCollapsedText(getXhsNoteTitle(root));
    const stateTitle = normalizeCollapsedText(note?.title || note?.noteTitle || '');
    if (domTitle && stateTitle) {
        return domTitle === stateTitle || domTitle.includes(stateTitle) || stateTitle.includes(domTitle);
    }
    if (domTitle && !stateTitle) return false;
    return true;
}

function pushUniqueHttpUrl(list, value) {
    const url = normalizeText(value);
    if (!/^https?:\/\//i.test(url)) return;
    if (!list.includes(url)) {
        list.push(url);
    }
}

function getCurrentXhsMainVideoElement(root) {
    const scope = root || document;
    const candidates = Array.from(scope.querySelectorAll('video, video[mediatype="video"], .xgplayer video'));
    const visible = candidates.find((el) => !isCommentRelatedNode(el) && isNodeVisible(el));
    if (visible) return visible;
    return candidates.find((el) => {
        if (isCommentRelatedNode(el)) return false;
        const src = normalizeText(el.getAttribute('src') || '');
        return el.getAttribute('mediatype') === 'video'
            || src.startsWith('blob:')
            || /^https?:\/\//i.test(src)
            || Boolean(el.querySelector('source[src^="blob:"], source[src^="http"]'));
    }) || null;
}

function getCurrentXhsVideoElements(root) {
    const scope = root || document;
    const candidates = Array.from(scope.querySelectorAll('video, video[mediatype="video"], .xgplayer video'));
    const seen = new Set();
    const unique = [];
    candidates.forEach((el, index) => {
        if (isCommentRelatedNode(el)) return;
        const src = normalizeText(el.currentSrc || el.getAttribute('src') || '');
        const poster = normalizeText(el.getAttribute('poster') || '');
        const key = src || poster || `video-index-${index}`;
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(el);
    });
    return unique;
}

function parseDurationTextToSeconds(value) {
    const raw = normalizeText(value);
    if (!raw) return null;

    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
    }

    const parts = raw
        .split(':')
        .map((part) => Number(part.trim()))
        .filter((part) => Number.isFinite(part) && part >= 0);
    if (parts.length < 2 || parts.length > 3) return null;

    let seconds = 0;
    for (const part of parts) {
        seconds = (seconds * 60) + part;
    }
    return seconds > 0 ? seconds : null;
}

function getXhsStateVideoDurationSeconds(stateNote) {
    const candidates = [
        stateNote?.video?.duration,
        stateNote?.video?.durationSeconds,
        stateNote?.video?.media?.duration,
        stateNote?.video?.media?.durationSeconds,
        stateNote?.video?.durationMs,
        stateNote?.video?.duration_ms,
        stateNote?.video?.media?.durationMs,
        stateNote?.video?.media?.duration_ms,
    ];

    for (const candidate of candidates) {
        const seconds = parseDurationTextToSeconds(candidate);
        if (!seconds) continue;
        return seconds > 10000 || (Number.isInteger(seconds) && seconds > 2000 && seconds % 1000 === 0)
            ? seconds / 1000
            : seconds;
    }

    return null;
}

function getXhsVideoDurationSeconds(videoEl, root, stateNote) {
    const directDuration = Number(videoEl?.duration);
    if (Number.isFinite(directDuration) && directDuration > 0) {
        return directDuration;
    }

    const scopes = [
        videoEl?.closest?.('.media-container'),
        videoEl?.closest?.('.player-container'),
        videoEl?.closest?.('.player-el'),
        videoEl?.closest?.('.xgplayer'),
        root,
        document,
    ].filter(Boolean);
    for (const scope of scopes) {
        const timeEls = Array.from(scope.querySelectorAll('xg-time span, .xgplayer-time span'));
        const parsed = parseDurationTextToSeconds(timeEls[timeEls.length - 1]?.textContent || '');
        if (parsed) return parsed;
    }

    return getXhsStateVideoDurationSeconds(stateNote);
}

function resolveXhsNoteType(root, stateNote) {
    if (isLivePhotoNote(root)) {
        return 'image';
    }

    const videoElements = getCurrentXhsVideoElements(root);
    const hasStateVideo = Boolean(stateNote?.video);
    const videoCount = Math.max(videoElements.length, hasStateVideo ? 1 : 0);
    if (videoCount !== 1) {
        return 'image';
    }

    const mainVideo = getCurrentXhsMainVideoElement(root) || videoElements[0] || null;
    const durationSeconds = getXhsVideoDurationSeconds(mainVideo, root || document, stateNote);
    if (durationSeconds == null) {
        return 'video';
    }

    return durationSeconds > 2 ? 'video' : 'image';
}

function collectDeepHttpUrls(input, maxCount = 40) {
    const urls = [];
    const seenObjects = new WeakSet();
    const seenUrls = new Set();

    function walk(value) {
        if (!value || urls.length >= maxCount) return;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (/^https?:\/\//i.test(trimmed) && !seenUrls.has(trimmed)) {
                seenUrls.add(trimmed);
                urls.push(trimmed);
            }
            return;
        }
        if (typeof value !== 'object') return;
        if (seenObjects.has(value)) return;
        seenObjects.add(value);

        if (Array.isArray(value)) {
            for (const item of value) {
                walk(item);
                if (urls.length >= maxCount) break;
            }
            return;
        }

        for (const key of Object.keys(value)) {
            walk(value[key]);
            if (urls.length >= maxCount) break;
        }
    }

    walk(input);
    return urls;
}

function getXhsImageUrls(root, stateNote) {
    const urls = [];
    if (stateNote) {
        const imageList = Array.isArray(stateNote?.imageList)
            ? stateNote.imageList
            : Array.isArray(stateNote?.images)
                ? stateNote.images
                : [];
        imageList.forEach((item) => {
            if (typeof item === 'string') {
                pushUniqueHttpUrl(urls, item);
                return;
            }
            pushUniqueHttpUrl(urls, item?.urlDefault);
            pushUniqueHttpUrl(urls, item?.urlPre);
            pushUniqueHttpUrl(urls, item?.url);
            pushUniqueHttpUrl(urls, item?.urlDefaultWebp);
        });
    }
    if (urls.length > 0) return urls;

    const swiperSlides = Array.from((root || document).querySelectorAll('.note-slider .swiper-slide, .swiper .swiper-slide'))
        .filter((slide) => !isCommentRelatedNode(slide))
        .filter((slide) => !slide.classList?.contains('swiper-slide-duplicate'))
        .map((slide, domIndex) => ({
            slide,
            domIndex,
            slideIndex: Number.parseInt(slide.getAttribute('data-swiper-slide-index') || '', 10),
        }))
        .sort((a, b) => {
            const aHasIndex = Number.isFinite(a.slideIndex);
            const bHasIndex = Number.isFinite(b.slideIndex);
            if (aHasIndex && bHasIndex && a.slideIndex !== b.slideIndex) {
                return a.slideIndex - b.slideIndex;
            }
            if (aHasIndex !== bHasIndex) {
                return aHasIndex ? -1 : 1;
            }
            return a.domIndex - b.domIndex;
        });
    const imgEls = swiperSlides.length > 0
        ? swiperSlides.map(({ slide }) => slide.querySelector('img')).filter(Boolean)
        : Array.from((root || document).querySelectorAll('.img-container img, .note-content .img-container img, .swiper-slide img'));
    imgEls.forEach((img) => {
        if (isCommentRelatedNode(img)) return;
        if (img.closest('.avatar,[class*="avatar"]')) return;
        if (img.closest('.swiper-slide-duplicate')) return;
        pushUniqueHttpUrl(urls, img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || '');
    });
    return urls;
}

function getXhsVideoUrls(root, stateNote) {
    const urls = [];
    const h264 = stateNote?.video?.media?.stream?.h264 || [];
    const h265 = stateNote?.video?.media?.stream?.h265 || [];
    [...h264, ...h265].forEach((item) => {
        pushUniqueHttpUrl(urls, item?.masterUrl);
        if (Array.isArray(item?.backupUrls)) {
            item.backupUrls.forEach((backup) => pushUniqueHttpUrl(urls, backup));
        }
    });
    pushUniqueHttpUrl(urls, stateNote?.video?.media?.masterUrl);
    pushUniqueHttpUrl(urls, stateNote?.video?.media?.url);
    pushUniqueHttpUrl(urls, stateNote?.video?.url);
    collectDeepHttpUrls(stateNote?.video || stateNote, 60).forEach((url) => pushUniqueHttpUrl(urls, url));

    const videoEls = Array.from((root || document).querySelectorAll('video'));
    videoEls.forEach((videoEl) => {
        if (isCommentRelatedNode(videoEl)) return;
        pushUniqueHttpUrl(urls, videoEl.src || '');
        Array.from(videoEl.querySelectorAll('source')).forEach((source) => {
            pushUniqueHttpUrl(urls, source.src || '');
        });
    });

    if (urls.length === 0 && getCurrentXhsMainVideoElement(root)) {
        try {
            const entries = performance.getEntriesByType('resource') || [];
            entries.forEach((entry) => {
                const name = typeof entry?.name === 'string' ? entry.name : '';
                if (/(\.mp4|\.m3u8|\/hls\/|\/video\/|sns-video|xhscdn)/i.test(name)) {
                    pushUniqueHttpUrl(urls, name);
                }
            });
        } catch {
            // ignore performance access failures
        }
    }

    return urls;
}

function detectXhsNoteInfo() {
    const noteRoot = getCurrentXhsNoteRoot();
    const articleRoot = document.querySelector('[class*="article"], .article-container, .content-container');
    const rawStateNote = getCurrentXhsStateNote();
    const stateNote = isXhsStateAlignedWithDom(rawStateNote, noteRoot) ? rawStateNote : null;
    const effectiveRoot = noteRoot || articleRoot || document.body;
    const title = getXhsNoteTitle(effectiveRoot);
    const text = getXhsTextContent(effectiveRoot);
    const imageUrls = getXhsImageUrls(noteRoot, stateNote);
    const noteType = resolveXhsNoteType(noteRoot, stateNote);
    const hasVideo = noteType === 'video' || getCurrentXhsVideoElements(noteRoot).length > 0 || Boolean(stateNote?.video);
    const hasStateContent = Boolean(stateNote && (stateNote.title || stateNote.desc || stateNote.video || stateNote.imageList || stateNote.images));
    const hasDomContent = Boolean(title || text.length > 20 || imageUrls.length > 0 || hasVideo);
    const hasValidNote = Boolean((noteRoot || articleRoot) && hasDomContent) || hasStateContent;

    if (!hasValidNote) {
        return createLinkFallbackPageInfo({
            kind: 'xhs-pending',
            description: '当前页面还没有稳定识别到有效的小红书笔记内容。',
        });
    }

    const isVideoNote = noteType === 'video';
    return {
        kind: isVideoNote ? 'xhs-video' : 'xhs-image',
        action: 'save-xhs',
        label: isVideoNote ? '保存小红书视频笔记到知识库' : '保存小红书图文到知识库',
        description: isVideoNote ? '当前页面已识别为小红书视频笔记。' : '当前页面已识别为小红书图文笔记。',
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

    if (/(^|\.)douyin\.com$/i.test(hostname)) {
        const title = normalizeText(
            document.querySelector('[data-e2e="video-desc"]')?.textContent
            || document.querySelector('h1')?.textContent
            || document.querySelector('meta[property="og:title"]')?.getAttribute('content')
            || '',
        ).replace(/\s*[-|_|]\s*抖音.*$/i, '').trim();
        const videoEl = Array.from(document.querySelectorAll('video'))
            .sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (br.width * br.height) - (ar.width * ar.height);
            })
            .find((item) => isNodeVisible(item) || normalizeText(item.currentSrc || item.src));
        if (pathname.startsWith('/video/') || pathname.startsWith('/note/') || videoEl || title) {
            return {
                kind: 'douyin-video',
                action: 'save-douyin',
                label: '保存抖音视频到知识库',
                description: '当前页面已识别为抖音视频页。',
                primaryEnabled: true,
                detected: true,
            };
        }
        return createLinkFallbackPageInfo({
            kind: 'douyin-pending',
            description: '当前页面还没有稳定识别到有效的抖音视频内容。',
        });
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

function handleLikelyNavigation(duration = FAST_POLL_DURATION_MS) {
    if (observerStopped) return;
    latestUrl = location.href;
    scheduleEmit(0);
    startFastPolling(duration);
}

function handlePageRouteChange() {
    handleLikelyNavigation(2200);
}

function installPageRouteBridge() {
    if (pageRouteBridgeInstalled || !document.documentElement) return;
    pageRouteBridgeInstalled = true;
    const existing = document.getElementById('redbox-page-route-bridge');
    if (existing) return;

    const script = document.createElement('script');
    script.id = 'redbox-page-route-bridge';
    script.src = chrome.runtime.getURL('pageRouteBridge.js');
    script.async = false;
    script.onload = () => {
        script.remove();
    };
    script.onerror = () => {
        console.warn('[redbox-plugin][page-observer] failed to install page route bridge');
    };
    (document.head || document.documentElement).appendChild(script);
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
    window.removeEventListener(PAGE_ROUTE_EVENT_NAME, handlePageRouteChange, true);
    window.removeEventListener('popstate', handlePageRouteChange, true);
    window.removeEventListener('hashchange', handlePageRouteChange, true);
    window.removeEventListener('pageshow', handlePageRouteChange, true);
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
    installPageRouteBridge();
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
        handleLikelyNavigation();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            handleLikelyNavigation(1500);
        }
    });

    window.addEventListener(PAGE_ROUTE_EVENT_NAME, handlePageRouteChange, true);
    window.addEventListener('popstate', handlePageRouteChange, true);
    window.addEventListener('hashchange', handlePageRouteChange, true);
    window.addEventListener('pageshow', handlePageRouteChange, true);

    scheduleEmit(0);
    startFastPolling();
} else {
    latestPageInfo = detectPageInfo();
}
