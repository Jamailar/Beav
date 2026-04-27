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
let xhsOverlayHost = null;
let xhsOverlayStatusElement = null;
let xhsOverlayStatusTimer = null;
let xhsDomStyleElement = null;
let xhsDomStatusTimer = null;
let xhsDomInjectionTimer = null;

const EMIT_DEBOUNCE_MS = 40;
const FAST_POLL_INTERVAL_MS = 120;
const FAST_POLL_DURATION_MS = 2500;
const URL_WATCH_INTERVAL_MS = 150;
const DRAG_HIDE_DELAY_MS = 140;
const DRAG_RESULT_HIDE_DELAY_MS = 1800;
const PAGE_ROUTE_EVENT_NAME = 'redbox:locationchange';
const REDBOX_XHS_DETAIL_ACTIONS_ID = 'redbox-xhs-detail-actions';
const REDBOX_XHS_PROFILE_ACTIONS_ID = 'redbox-xhs-profile-actions';
const REDBOX_XHS_STYLE_ID = 'redbox-xhs-dom-style';
const REDBOX_XHS_DETAIL_HOST_TAG = 'redbox-xhs-explore';

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
        || /(^|\.)rednote\.com$/i.test(hostname)
        || /(^|\.)douyin\.com$/i.test(hostname);
}

function isXhsHost() {
    const hostname = String(location.hostname || '').toLowerCase();
    return /(^|\.)xiaohongshu\.com$/i.test(hostname) || /(^|\.)rednote\.com$/i.test(hostname);
}

function isXhsNoteDetailPath() {
    return /^\/(?:explore|discovery\/item)\/[A-Za-z0-9]+/i.test(String(location.pathname || ''));
}

function isXhsProfilePath() {
    return /^\/user\/profile\/[^/]+/i.test(String(location.pathname || ''));
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

    if (/(^|\.)xiaohongshu\.com$/i.test(hostname) || /(^|\.)rednote\.com$/i.test(hostname)) {
        if (isXhsProfilePath()) {
            return {
                kind: 'xhs-profile',
                action: 'xhs:collect-current-blogger',
                label: '保存小红书博主资料到知识库',
                description: '当前页面已识别为小红书博主页。',
                primaryEnabled: true,
                detected: true,
            };
        }
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

    if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com') || hostname === 'b23.tv') {
        const isVideoPage = pathname.startsWith('/video/') || pathname.startsWith('/bangumi/play/');
        const isSpacePage = hostname === 'space.bilibili.com' || pathname.startsWith('/space/');
        const isSearchPage = hostname === 'search.bilibili.com';
        return {
            kind: isVideoPage ? 'bilibili-video' : isSpacePage ? 'bilibili-profile' : isSearchPage ? 'bilibili-search' : 'bilibili-page',
            platform: 'bilibili',
            action: 'save-bilibili',
            label: isVideoPage ? '保存 Bilibili 视频页到知识库' : '保存 Bilibili 页面到知识库',
            description: isVideoPage ? '当前页面已识别为 Bilibili 视频页。' : '当前页面已识别为 Bilibili 页面。',
            primaryEnabled: true,
            detected: true,
        };
    }

    if (hostname === 'kuaishou.com' || hostname.endsWith('.kuaishou.com') || hostname === 'kwai.com' || hostname.endsWith('.kwai.com')) {
        const isVideoPage = pathname.startsWith('/short-video/') || pathname.startsWith('/fw/photo/');
        return {
            kind: isVideoPage ? 'kuaishou-video' : 'kuaishou-page',
            platform: 'kuaishou',
            action: 'save-kuaishou',
            label: isVideoPage ? '保存快手视频页到知识库' : '保存快手页面到知识库',
            description: isVideoPage ? '当前页面已识别为快手视频页。' : '当前页面已识别为快手页面。',
            primaryEnabled: true,
            detected: true,
        };
    }

    if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) {
        const isVideoPage = pathname.includes('/video/');
        return {
            kind: isVideoPage ? 'tiktok-video' : 'tiktok-page',
            platform: 'tiktok',
            action: 'save-tiktok',
            label: isVideoPage ? '保存 TikTok 视频页到知识库' : '保存 TikTok 页面到知识库',
            description: isVideoPage ? '当前页面已识别为 TikTok 视频页。' : '当前页面已识别为 TikTok 页面。',
            primaryEnabled: true,
            detected: true,
        };
    }

    if (hostname === 'reddit.com' || hostname.endsWith('.reddit.com')) {
        const isPostPage = pathname.includes('/comments/');
        return {
            kind: isPostPage ? 'reddit-post' : 'reddit-page',
            platform: 'reddit',
            action: 'save-reddit',
            label: isPostPage ? '保存 Reddit 帖子到知识库' : '保存 Reddit 页面到知识库',
            description: isPostPage ? '当前页面已识别为 Reddit 帖子。' : '当前页面已识别为 Reddit 页面。',
            primaryEnabled: true,
            detected: true,
        };
    }

    if (hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com' || hostname.endsWith('.twitter.com')) {
        const isPostPage = pathname.includes('/status/');
        return {
            kind: isPostPage ? 'x-post' : 'x-page',
            platform: 'x',
            action: 'save-x',
            label: isPostPage ? '保存 X 推文到知识库' : '保存 X 页面到知识库',
            description: isPostPage ? '当前页面已识别为 X 推文。' : '当前页面已识别为 X 页面。',
            primaryEnabled: true,
            detected: true,
        };
    }

    if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) {
        const isPostPage = pathname.startsWith('/p/') || pathname.startsWith('/reel/');
        return {
            kind: isPostPage ? 'instagram-post' : 'instagram-page',
            platform: 'instagram',
            action: 'save-instagram',
            label: isPostPage ? '保存 Instagram 内容到知识库' : '保存 Instagram 页面到知识库',
            description: isPostPage ? '当前页面已识别为 Instagram 内容页。' : '当前页面已识别为 Instagram 页面。',
            primaryEnabled: true,
            detected: true,
        };
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

function setXhsOverlayStatus(message, state = 'idle') {
    if (!xhsOverlayStatusElement) return;
    clearTimeout(xhsOverlayStatusTimer);
    xhsOverlayStatusElement.textContent = normalizeText(message);
    xhsOverlayStatusElement.dataset.state = state;
    xhsOverlayStatusElement.hidden = !message;
    if (message) {
        xhsOverlayStatusTimer = setTimeout(() => {
            if (!xhsOverlayStatusElement) return;
            xhsOverlayStatusElement.textContent = '';
            xhsOverlayStatusElement.hidden = true;
        }, state === 'error' ? 3200 : 2200);
    }
}

function setXhsDomStatus(container, message, state = 'idle') {
    const statusEl = container?.querySelector?.('.redbox-xhs-status');
    if (!statusEl) return;
    clearTimeout(xhsDomStatusTimer);
    statusEl.textContent = normalizeText(message);
    statusEl.dataset.state = state;
    statusEl.hidden = !message;
    if (message) {
        xhsDomStatusTimer = setTimeout(() => {
            if (!statusEl.isConnected) return;
            statusEl.textContent = '';
            statusEl.hidden = true;
        }, state === 'error' ? 3200 : 2200);
    }
}

function summarizeActionResponse(response, fallback) {
    if (response?.noteId) {
        return response.duplicate ? '知识库中已存在' : '已保存到 RedBox';
    }
    if (response?.mode === 'xhs-link-batch') {
        return `成功 ${Number(response.count || 0)} 条，失败 ${Number(response.failed || 0)} 条`;
    }
    if (response?.mode === 'xhs-blogger-notes') {
        return `博主笔记 ${Number(response.count || 0)} 条，失败 ${Number(response.failed || 0)} 条`;
    }
    if (response?.mode === 'xhs-download') {
        return `下载 ${Number(response.count || 0)} 个素材`;
    }
    if (response?.mode === 'xhs-comments') {
        return `评论 ${Number(response.count || 0)} 条`;
    }
    if (/^(bilibili|kuaishou|tiktok|reddit|x|instagram)-/.test(String(response?.mode || ''))) {
        return response.duplicate ? '知识库中已存在' : fallback;
    }
    return fallback;
}

async function runXhsDomAction(action, options = {}) {
    const actionMap = {
        save: { type: 'save-xhs', pending: '保存中...', done: '已保存到 RedBox' },
        download: { type: 'xhs:download-current-note', pending: '下载中...', done: '已创建下载任务' },
        comments: { type: 'xhs:collect-current-comments', pending: '采集中...', done: '评论已写入知识库' },
        blogger: { type: 'xhs:collect-current-blogger', pending: '采集中...', done: '已保存博主资料' },
        bloggerNotes: { type: 'xhs:collect-blogger-notes', pending: '采集中...', done: '已采集主页笔记' },
        exportJson: { type: 'xhs:export-current-note-json', pending: '导出中...', done: '已导出 JSON' },
        collectLink: { type: 'xhs:collect-note-links', pending: '采集中...', done: '已采集' },
        savePageAuto: { type: 'save-page-auto', pending: '保存中...', done: '已保存到 RedBox' },
        savePageLink: { type: 'save-page-link', pending: '保存中...', done: '已保存到 RedBox' },
        saveYoutube: { type: 'save-youtube', pending: '保存中...', done: '已保存 YouTube 视频' },
        saveDouyin: { type: 'save-douyin', pending: '保存中...', done: '已保存抖音视频' },
        saveBilibili: { type: 'save-bilibili', pending: '保存中...', done: '已保存 Bilibili 内容' },
        saveKuaishou: { type: 'save-kuaishou', pending: '保存中...', done: '已保存快手内容' },
        saveTiktok: { type: 'save-tiktok', pending: '保存中...', done: '已保存 TikTok 内容' },
        saveReddit: { type: 'save-reddit', pending: '保存中...', done: '已保存 Reddit 内容' },
        saveX: { type: 'save-x', pending: '保存中...', done: '已保存 X 内容' },
        saveInstagram: { type: 'save-instagram', pending: '保存中...', done: '已保存 Instagram 内容' },
    };
    const config = actionMap[action];
    if (!config) return;
    const statusTarget = options.statusTarget || null;
    if (statusTarget) {
        setXhsDomStatus(statusTarget, config.pending, 'pending');
    } else {
        setXhsOverlayStatus(config.pending, 'pending');
    }
    try {
        const message = action === 'collectLink'
            ? {
                type: config.type,
                urls: [options.url].filter(Boolean),
                options: { saveToRedBox: true, limit: 1 },
            }
            : { type: config.type };
        const response = await chrome.runtime.sendMessage(message);
        if (!response?.success) {
            throw new Error(response?.error || '操作失败');
        }
        const doneText = summarizeActionResponse(response, config.done || '');
        if (statusTarget) {
            setXhsDomStatus(statusTarget, doneText, 'success');
        } else {
            setXhsOverlayStatus(doneText, 'success');
        }
    } catch (error) {
        const message = String(error?.message || error || '操作失败');
        console.warn('[redbox-plugin][page-observer] xhs dom action failed', action, message);
        if (statusTarget) {
            setXhsDomStatus(statusTarget, message, 'error');
        } else {
            setXhsOverlayStatus(message, 'error');
        }
    }
}

async function runXhsOverlayAction(action) {
    await runXhsDomAction(action);
}

function removeXhsOverlay() {
    clearTimeout(xhsOverlayStatusTimer);
    xhsOverlayStatusTimer = null;
    xhsOverlayStatusElement = null;
    if (xhsOverlayHost?.isConnected) {
        xhsOverlayHost.remove();
    }
    xhsOverlayHost = null;
}

function ensureXhsDomStyle() {
    if (xhsDomStyleElement?.isConnected) return;
    const style = document.createElement('style');
    style.id = REDBOX_XHS_STYLE_ID;
    style.textContent = `
      .redbox-xhs-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin: 10px 0;
        padding: 8px 0;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .redbox-xhs-profile-actions {
        padding: 12px 0;
        margin: 8px 0 12px;
      }
      .redbox-xhs-detail-actions {
        margin: 0;
        padding: 0 16px 16px !important;
        gap: 12px;
      }
      @media (min-width: 1280px) {
        .redbox-xhs-detail-actions {
          padding: 0 24px 24px !important;
          gap: 16px;
        }
      }
      .redbox-xhs-btn,
      .redbox-xhs-card-btn {
        border: 1px solid rgba(194, 65, 12, 0.26);
        border-radius: 8px;
        background: #ffffff;
        color: #9a3412;
        cursor: pointer;
        font: 650 12px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .redbox-xhs-btn {
        min-height: 30px;
        padding: 7px 10px;
      }
      .redbox-xhs-btn.primary {
        background: #c2410c;
        border-color: #c2410c;
        color: #fff7ed;
      }
      .redbox-xhs-btn:hover,
      .redbox-xhs-card-btn:hover {
        border-color: #9a3412;
        box-shadow: 0 6px 18px rgba(154, 52, 18, 0.14);
      }
      .redbox-xhs-btn:disabled,
      .redbox-xhs-card-btn:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .redbox-xhs-status {
        min-width: 88px;
        color: #166534;
        font-size: 12px;
        line-height: 1.35;
        word-break: break-word;
      }
      .redbox-xhs-status[data-state="pending"] {
        color: #9a3412;
      }
      .redbox-xhs-status[data-state="error"] {
        color: #b91c1c;
      }
      .redbox-xhs-card-btn {
        position: absolute;
        right: 8px;
        top: 8px;
        z-index: 8;
        min-height: 28px;
        padding: 6px 8px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.12);
      }
      .redbox-xhs-card-status {
        position: absolute;
        right: 8px;
        top: 42px;
        z-index: 8;
        max-width: 150px;
        border: 1px solid rgba(15, 23, 42, 0.1);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.96);
        color: #166534;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.1);
        padding: 6px 8px;
        font-size: 12px;
        line-height: 1.3;
        word-break: break-word;
      }
      .redbox-xhs-card-status[data-state="pending"] {
        color: #9a3412;
      }
      .redbox-xhs-card-status[data-state="error"] {
        color: #b91c1c;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    xhsDomStyleElement = style;
}

function makeXhsDomButton(label, action, options = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `redbox-xhs-btn${options.primary ? ' primary' : ''}`;
    button.textContent = label;
    button.title = options.title || label;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runXhsDomAction(action, { statusTarget: options.statusTarget, url: options.url });
    });
    return button;
}

function findXhsDetailActionMount(root) {
    const scopes = [
        root,
        getActiveXhsDetailMask(),
        document.querySelector('#noteContainer'),
        document,
    ].filter(Boolean);
    const selectors = [
        '#noteContainer div.interaction-container div.note-content',
        '#noteContainer .interaction-container .note-content',
        '#noteContainer .interaction-container',
        '.note-detail-mask #noteContainer div.interaction-container div.note-content',
        '.note-detail-mask #noteContainer .interaction-container .note-content',
        '#noteContainer .interactions-container',
        '#noteContainer .interactions',
        '#noteContainer .bottom-container',
        '#noteContainer .action-container',
        '#noteContainer .engage-bar',
        '#noteContainer .note-content',
        '#noteContainer #detail-desc',
        '#noteContainer #detail-title',
        '.note-detail-mask #noteContainer .interactions-container',
        '.note-detail-mask .interactions',
        '.note-detail-mask #noteContainer .bottom-container',
        '.note-detail-mask #noteContainer .action-container',
        '.note-detail-mask .note-content',
        '.interactions-container',
        '.interactions',
        '.bottom-container',
        '.action-container',
        '.engage-bar',
        '.note-actions',
        '.author-container',
        '.note-scroller',
        '.note-content',
        '#detail-desc',
        '#detail-title',
    ];
    for (const scope of scopes) {
        for (const selector of selectors) {
            const target = scope.querySelector?.(selector);
            if (target && isNodeVisible(target)) {
                return target;
            }
        }
    }
    if (root) return root;
    const fallback =
        document.querySelector('#noteContainer')
        || document.querySelector('.note-detail-mask')
        || document.querySelector('.note-container')
        || document.querySelector('main')
        || document.body;
    return fallback instanceof Element ? fallback : null;
}

function findXhsReferenceDetailAnchor(root) {
    const scopes = [
        root,
        getActiveXhsDetailMask(),
        document,
    ].filter(Boolean);
    const selectors = [
        '#noteContainer div.interaction-container div.note-content',
        '#noteContainer .interaction-container .note-content',
        '#noteContainer [class*="interaction-container"] [class*="note-content"]',
        '#noteContainer [class*="interaction"] [class*="note-content"]',
        '.note-detail-mask #noteContainer div.interaction-container div.note-content',
        '.note-detail-mask #noteContainer .interaction-container .note-content',
        '.note-detail-mask #noteContainer [class*="interaction-container"] [class*="note-content"]',
    ];
    for (const scope of scopes) {
        const hasAuthorAvatar = scope.querySelector?.('#noteContainer div.interaction-container div.author-container .info img.avatar-item');
        for (const selector of selectors) {
            const target = scope.querySelector?.(selector);
            if (target && (hasAuthorAvatar || target.querySelector?.('#detail-title, #detail-desc, .note-text') || target.closest?.('#noteContainer'))) {
                return target;
            }
        }
    }
    return null;
}

function getXhsDetailInjectionKey() {
    const openedNoteId = getCurrentOpenedXhsNoteId();
    if (openedNoteId) return openedNoteId;
    const pathNoteId = String(location.pathname || '').match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/i)?.[1];
    if (pathNoteId) return pathNoteId;
    const stateNote = getCurrentXhsStateNote();
    return normalizeText(stateNote?.noteId || stateNote?.id || stateNote?.note_id || '');
}

function isXhsNotePageInfo(pageInfo) {
    return /^xhs-(?:note|image|video|article)$/i.test(String(pageInfo?.kind || ''));
}

function hasXhsDetailDom() {
    return Boolean(
        getActiveXhsDetailMask()
        || document.querySelector('#noteContainer')
        || document.querySelector('#detail-title')
        || document.querySelector('#detail-desc')
    );
}

function shouldInjectXhsDetailActions(pageInfo) {
    return isXhsNoteDetailPath() || isXhsNotePageInfo(pageInfo) || hasXhsDetailDom();
}

function createXhsDetailHost(injectionKey) {
    const host = document.createElement(REDBOX_XHS_DETAIL_HOST_TAG);
    host.id = REDBOX_XHS_DETAIL_ACTIONS_ID;
    host.dataset.redboxInjected = 'detail-actions';
    if (injectionKey) {
        host.dataset.redboxNoteKey = injectionKey;
    }
    host.style.display = 'block';
    host.style.position = 'relative';
    host.style.zIndex = '9';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        display: block;
        box-sizing: border-box;
      }
      *, *::before, *::after {
        box-sizing: border-box;
      }
      .redbox-xhs-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 12px;
        padding: 0 16px 16px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      @media (min-width: 1280px) {
        .redbox-xhs-actions {
          gap: 16px;
          padding: 0 24px 24px;
        }
      }
      button {
        min-height: 32px;
        border: 1px solid #c2410c;
        border-radius: 8px;
        background: #c2410c;
        color: #fff7ed;
        cursor: pointer;
        padding: 7px 14px;
        font: 700 13px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
        white-space: nowrap;
        box-shadow: 0 6px 18px rgba(194, 65, 12, 0.14);
      }
      button:hover {
        background: #9a3412;
        border-color: #9a3412;
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .redbox-xhs-status {
        color: #166534;
        font-size: 12px;
        line-height: 1.35;
        word-break: break-word;
      }
      .redbox-xhs-status[data-state="pending"] {
        color: #9a3412;
      }
      .redbox-xhs-status[data-state="error"] {
        color: #b91c1c;
      }
    `;
    const actions = document.createElement('div');
    actions.className = 'redbox-xhs-actions p-4 xl:p-6 !pt-0 flex gap-3 xl:gap-4 flex-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.redboxAction = 'save';
    button.textContent = '保存笔记';
    button.title = '保存当前小红书笔记到 RedBox';
    const status = document.createElement('span');
    status.className = 'redbox-xhs-status';
    status.hidden = true;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runXhsDomAction('save', { statusTarget: actions });
    });
    actions.append(button, status);
    shadow.append(style, actions);
    return host;
}

function injectXhsDetailActions(pageInfo) {
    const root = getCurrentXhsNoteRoot();
    const hasDetectedNote = shouldInjectXhsDetailActions(pageInfo);
    if (!hasDetectedNote) return;
    const injectionKey = getXhsDetailInjectionKey();
    let container = document.getElementById(REDBOX_XHS_DETAIL_ACTIONS_ID);
    if (container?.isConnected) {
        if (injectionKey && container.dataset.redboxNoteKey !== injectionKey) {
            container.remove();
            container = null;
        } else if (root && !root.contains(container)) {
            const referenceAnchor = findXhsReferenceDetailAnchor(root);
            const isPlacedBeforeReference = referenceAnchor
                && (container.nextElementSibling === referenceAnchor || referenceAnchor.parentElement?.contains(container));
            if (!isPlacedBeforeReference) {
                container.remove();
                container = null;
            }
        }
    }
    if (container?.isConnected) {
        const saveButton = container.shadowRoot?.querySelector?.('[data-redbox-action="save"]')
            || container.querySelector?.('[data-redbox-action="save"]');
        if (saveButton) saveButton.disabled = false;
        return;
    }

    const referenceAnchor = findXhsReferenceDetailAnchor(root);
    const mount = referenceAnchor || findXhsDetailActionMount(root);
    if (!mount) return;
    container = createXhsDetailHost(injectionKey);

    if (referenceAnchor) {
        referenceAnchor.insertAdjacentElement('beforebegin', container);
    } else if (mount.matches?.('#noteContainer div.interaction-container div.note-content, #noteContainer .interaction-container .note-content')) {
        mount.insertAdjacentElement('beforebegin', container);
    } else if (mount.id === 'detail-title' || mount.id === 'detail-desc') {
        mount.insertAdjacentElement('afterend', container);
    } else if (mount.classList?.contains('note-scroller')) {
        mount.insertAdjacentElement('afterbegin', container);
    } else {
        mount.insertAdjacentElement('afterend', container);
    }
}

function findXhsProfileActionMount() {
    const selectors = [
        '.user-page .user-info',
        '.user-page .info-part',
        '.user-page .user',
        '.user-info',
        '[class*="user-info"]',
        '[class*="userInfo"]',
        '[class*="profile"]',
        'main',
    ];
    for (const selector of selectors) {
        const target = document.querySelector(selector);
        if (target instanceof Element && isNodeVisible(target)) {
            return target;
        }
    }
    return document.body;
}

function injectXhsProfileActions() {
    if (!isXhsProfilePath()) return;
    let container = document.getElementById(REDBOX_XHS_PROFILE_ACTIONS_ID);
    if (container?.isConnected) return;
    const mount = findXhsProfileActionMount();
    if (!mount) return;
    ensureXhsDomStyle();

    container = document.createElement('div');
    container.id = REDBOX_XHS_PROFILE_ACTIONS_ID;
    container.className = 'redbox-xhs-actions redbox-xhs-profile-actions';
    container.dataset.redboxInjected = 'profile-actions';
    const status = document.createElement('span');
    status.className = 'redbox-xhs-status';
    status.hidden = true;
    container.append(
        makeXhsDomButton('保存博主', 'blogger', { primary: true, statusTarget: container, title: '保存当前小红书博主资料到 RedBox' }),
        makeXhsDomButton('采集博主笔记', 'bloggerNotes', { statusTarget: container, title: '采集当前博主主页全部可加载笔记' }),
        status,
    );

    if (mount === document.body) {
        document.body.insertAdjacentElement('afterbegin', container);
    } else {
        mount.insertAdjacentElement('afterend', container);
    }
}

function normalizeXhsNoteUrl(value) {
    const raw = toAbsoluteUrl(value);
    if (!isHttpUrl(raw)) return '';
    try {
        const parsed = new URL(raw);
        if (!/xiaohongshu\.com|rednote\.com/i.test(parsed.hostname)) return '';
        const match = parsed.pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
        if (!match?.[1]) return '';
        return `https://www.xiaohongshu.com/explore/${match[1]}`;
    } catch {
        return '';
    }
}

function findXhsCardRoot(anchor) {
    return anchor.closest('.note-item')
        || anchor.closest('[class*="note-item"]')
        || anchor.closest('.feed-card')
        || anchor.closest('[class*="feed-card"]')
        || anchor.closest('.cover')?.parentElement
        || anchor.closest('[class*="cover"]')?.parentElement
        || anchor.closest('article')
        || anchor.parentElement;
}

function injectXhsCardButtons() {
    ensureXhsDomStyle();
    const anchors = Array.from(document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]'))
        .filter((anchor) => isNodeVisible(anchor))
        .slice(0, 80);
    let injected = 0;
    for (const anchor of anchors) {
        if (injected >= 30) break;
        const url = normalizeXhsNoteUrl(anchor.getAttribute('href') || anchor.href || '');
        if (!url) continue;
        const card = findXhsCardRoot(anchor);
        if (!card || card.querySelector(':scope > .redbox-xhs-card-btn')) continue;
        const style = window.getComputedStyle(card);
        if (style.position === 'static') {
            card.dataset.redboxPreviousPosition = 'static';
            card.style.position = 'relative';
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'redbox-xhs-card-btn';
        button.textContent = '采集';
        button.title = '采集这条小红书笔记到 RedBox';
        const status = document.createElement('span');
        status.className = 'redbox-xhs-card-status redbox-xhs-status';
        status.hidden = true;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void runXhsDomAction('collectLink', { statusTarget: card, url });
        });
        card.append(button, status);
        injected += 1;
    }
}

function ensureXhsDomButtons(pageInfo) {
    if (!isXhsHost()) {
        removeXhsDomButtons();
        return;
    }
    if (!xhsDomInjectionTimer) {
        xhsDomInjectionTimer = setInterval(() => {
            if (!isXhsHost() || observerStopped) {
                removeXhsDomButtons();
                return;
            }
            if (shouldInjectXhsDetailActions(latestPageInfo)) {
                injectXhsDetailActions(latestPageInfo);
            }
        }, 500);
    }
    if (shouldInjectXhsDetailActions(pageInfo)) {
        injectXhsDetailActions(pageInfo);
    } else {
        document.getElementById(REDBOX_XHS_DETAIL_ACTIONS_ID)?.remove();
    }
    if (isXhsProfilePath() || pageInfo?.kind === 'xhs-profile') {
        injectXhsProfileActions(pageInfo);
    } else {
        document.getElementById(REDBOX_XHS_PROFILE_ACTIONS_ID)?.remove();
    }
    injectXhsCardButtons();
}

function removeXhsDomButtons() {
    clearTimeout(xhsDomStatusTimer);
    xhsDomStatusTimer = null;
    if (xhsDomInjectionTimer) {
        clearInterval(xhsDomInjectionTimer);
        xhsDomInjectionTimer = null;
    }
    document.getElementById(REDBOX_XHS_DETAIL_ACTIONS_ID)?.remove();
    document.getElementById(REDBOX_XHS_PROFILE_ACTIONS_ID)?.remove();
    document.querySelectorAll('.redbox-xhs-card-btn, .redbox-xhs-card-status').forEach((node) => node.remove());
    document.querySelectorAll('[data-redbox-previous-position="static"]').forEach((node) => {
        node.style.position = '';
        delete node.dataset.redboxPreviousPosition;
    });
    if (xhsDomStyleElement?.isConnected) {
        xhsDomStyleElement.remove();
    }
    xhsDomStyleElement = null;
}

function getRedboxOverlayConfig(pageInfo) {
    if (isXhsProfilePath() || pageInfo?.kind === 'xhs-profile') {
        return {
            variant: 'profile',
            title: 'RedBox 博主采集',
            subtitle: '小红书博主页',
            actions: [
                { label: '保存博主', action: 'blogger', primary: true, title: '保存当前博主资料到 RedBox' },
                { label: '采集博主笔记', action: 'bloggerNotes', title: '采集当前博主主页笔记' },
            ],
        };
    }
    if (isXhsNoteDetailPath() || /^xhs-(note|image|video)$/i.test(String(pageInfo?.kind || ''))) {
        return {
            variant: 'note',
            title: 'RedBox 笔记采集',
            subtitle: '小红书笔记页',
            actions: [
                { label: '保存笔记', action: 'save', primary: true, title: '保存当前笔记到 RedBox' },
                { label: '下载素材', action: 'download', title: '下载当前笔记图片或视频' },
                { label: '采集评论', action: 'comments', title: '采集当前笔记评论' },
                { label: '导出 JSON', action: 'exportJson', title: '导出当前笔记原始 JSON' },
            ],
        };
    }
    if (isXhsHost()) {
        return {
            variant: 'xhs',
            title: 'RedBox 小红书采集',
            subtitle: '当前页面',
            actions: [
                { label: '保存网页', action: 'savePageLink', primary: true, title: '保存当前页面链接到 RedBox' },
            ],
        };
    }
    if (pageInfo?.kind === 'youtube') {
        return {
            variant: 'youtube',
            title: 'RedBox 视频采集',
            subtitle: 'YouTube',
            actions: [
                { label: '保存视频', action: 'saveYoutube', primary: true, title: '保存当前 YouTube 视频到 RedBox' },
            ],
        };
    }
    if (pageInfo?.kind === 'douyin-video') {
        return {
            variant: 'douyin',
            title: 'RedBox 视频采集',
            subtitle: '抖音',
            actions: [
                { label: '保存视频', action: 'saveDouyin', primary: true, title: '保存当前抖音视频到 RedBox' },
            ],
        };
    }
    const platformMap = {
        'bilibili': { variant: 'bilibili', subtitle: 'Bilibili', label: '保存内容', action: 'saveBilibili', title: '保存当前 Bilibili 内容到 RedBox' },
        'kuaishou': { variant: 'kuaishou', subtitle: '快手', label: '保存内容', action: 'saveKuaishou', title: '保存当前快手内容到 RedBox' },
        'tiktok': { variant: 'tiktok', subtitle: 'TikTok', label: '保存内容', action: 'saveTiktok', title: '保存当前 TikTok 内容到 RedBox' },
        'reddit': { variant: 'reddit', subtitle: 'Reddit', label: '保存内容', action: 'saveReddit', title: '保存当前 Reddit 内容到 RedBox' },
        'x': { variant: 'x', subtitle: 'X', label: '保存内容', action: 'saveX', title: '保存当前 X 内容到 RedBox' },
        'instagram': { variant: 'instagram', subtitle: 'Instagram', label: '保存内容', action: 'saveInstagram', title: '保存当前 Instagram 内容到 RedBox' },
    };
    const platformKey = String(pageInfo?.platform || pageInfo?.kind || '').split('-')[0];
    if (platformMap[platformKey]) {
        const platform = platformMap[platformKey];
        return {
            variant: platform.variant,
            title: 'RedBox 页面采集',
            subtitle: platform.subtitle,
            actions: [
                { label: platform.label, action: platform.action, primary: true, title: platform.title },
            ],
        };
    }
    if (pageInfo?.kind === 'wechat-article') {
        return {
            variant: 'wechat',
            title: 'RedBox 文章采集',
            subtitle: '微信公众号',
            actions: [
                { label: '保存文章', action: 'savePageLink', primary: true, title: '保存当前公众号文章到 RedBox' },
            ],
        };
    }
    return {
        variant: 'generic',
        title: 'RedBox 页面采集',
        subtitle: pageInfo?.detected ? '当前页面' : '网页链接',
        actions: [
            { label: '保存网页', action: pageInfo?.action === 'save-page-auto' ? 'savePageAuto' : 'savePageLink', primary: true, title: '保存当前网页到 RedBox' },
        ],
    };
}

function renderXhsOverlay(pageInfo) {
    if (!xhsOverlayHost?.shadowRoot) return;
    const config = getRedboxOverlayConfig(pageInfo);
    const shadow = xhsOverlayHost.shadowRoot;
    const dock = shadow.querySelector('.dock');
    if (!dock) return;
    if (dock.dataset.variant === config.variant) {
        const primaryButton = shadow.querySelector('[data-primary="true"]');
        if (primaryButton) primaryButton.disabled = pageInfo?.primaryEnabled === false;
        return;
    }
    dock.dataset.variant = config.variant;
    dock.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'panel-head';
    const mark = document.createElement('div');
    mark.className = 'panel-mark';
    mark.textContent = 'R';
    const copy = document.createElement('div');
    copy.className = 'panel-copy';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = config.title;
    const subtitle = document.createElement('div');
    subtitle.className = 'panel-subtitle';
    subtitle.textContent = config.subtitle;
    copy.append(title, subtitle);
    header.append(mark, copy);
    dock.append(header);

    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    for (const item of config.actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = item.action;
        button.className = item.primary ? 'primary' : '';
        button.title = item.title || item.label;
        button.textContent = item.label;
        if (item.primary) {
            button.dataset.primary = 'true';
            button.disabled = pageInfo?.primaryEnabled === false;
        }
        button.addEventListener('click', () => {
            void runXhsOverlayAction(button.dataset.action);
        });
        actions.appendChild(button);
    }
    dock.appendChild(actions);

    const status = document.createElement('div');
    status.className = 'status';
    status.dataset.state = 'idle';
    status.hidden = true;
    dock.appendChild(status);
    xhsOverlayStatusElement = status;
}

function ensureXhsOverlay(pageInfo) {
    if (xhsOverlayHost?.isConnected) {
        renderXhsOverlay(pageInfo);
        return;
    }

    const host = document.createElement('div');
    host.id = 'redbox-page-overlay-host';
    host.style.position = 'fixed';
    host.style.right = '16px';
    host.style.top = '112px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .dock {
          display: grid;
          gap: 10px;
          width: 148px;
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.98);
          box-shadow: 0 14px 34px rgba(15, 23, 42, 0.16);
          padding: 10px;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
          pointer-events: auto;
        }
        .panel-head {
          display: grid;
          grid-template-columns: 28px 1fr;
          gap: 8px;
          align-items: center;
          min-width: 0;
        }
        .panel-mark {
          display: grid;
          place-items: center;
          width: 28px;
          height: 28px;
          border-radius: 8px;
          background: #c2410c;
          color: #fff7ed;
          font: 800 14px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        }
        .panel-copy {
          min-width: 0;
        }
        .panel-title {
          color: #171717;
          font-size: 12px;
          font-weight: 800;
          line-height: 1.2;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .panel-subtitle {
          margin-top: 2px;
          color: #737373;
          font-size: 11px;
          line-height: 1.2;
        }
        .panel-actions {
          display: grid;
          gap: 7px;
        }
        button {
          width: 100%;
          min-height: 31px;
          border: 1px solid rgba(15, 23, 42, 0.14);
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.96);
          color: #171717;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
          line-height: 1.1;
        }
        button:hover:not(:disabled) {
          border-color: #c2410c;
          color: #9a3412;
        }
        button.primary {
          border-color: #c2410c;
          background: #c2410c;
          color: #fff7ed;
        }
        button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }
        .status {
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 8px;
          background: #f0fdf4;
          color: #166534;
          padding: 8px;
          font-size: 12px;
          line-height: 1.35;
          word-break: break-word;
        }
        .status[data-state="error"] {
          color: #b91c1c;
        }
        .status[data-state="pending"] {
          color: #9a3412;
        }
      </style>
      <div class="dock" role="toolbar" aria-label="RedBox 页面采集">
      </div>
    `;

    xhsOverlayHost = host;
    (document.body || document.documentElement).appendChild(host);
    renderXhsOverlay(pageInfo);
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
    removeXhsDomButtons();
    removeXhsOverlay();
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
    ensureXhsDomButtons(latestPageInfo);
    ensureXhsOverlay(latestPageInfo);
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
