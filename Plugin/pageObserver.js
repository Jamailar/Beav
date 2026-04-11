let latestPageInfo = null;
let latestUrl = location.href;
let updateTimer = null;
let fastPollTimer = null;
let fastPollUntil = 0;

const EMIT_DEBOUNCE_MS = 40;
const FAST_POLL_INTERVAL_MS = 120;
const FAST_POLL_DURATION_MS = 2500;
const URL_WATCH_INTERVAL_MS = 150;

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
        (titleEl && String(titleEl.textContent || '').trim()) ||
        (descEl && String(descEl.textContent || '').replace(/\s+/g, ' ').trim().length > 20) ||
        imageEls.length > 0 ||
        hasVideo
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

function emitPageState() {
    latestPageInfo = detectPageInfo();
    chrome.runtime.sendMessage({
        type: 'page-state:update',
        pageInfo: latestPageInfo,
        url: location.href,
    }).catch(() => {});
}

function scheduleEmit(delay = EMIT_DEBOUNCE_MS) {
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

const observer = new MutationObserver(() => {
    scheduleEmit();
});

observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: false,
});

setInterval(() => {
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
