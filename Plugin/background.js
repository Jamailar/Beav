const API_ROOT = 'http://127.0.0.1:23456/api';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'redbox-save-selection',
    title: '保存选中文字到 RedBox',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'redbox-save-page-link',
    title: '保存当前页面链接到 RedBox',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'redbox-save-selection') {
    void saveSelectedTextFromTab(tab.id);
    return;
  }
  if (info.menuItemId === 'redbox-save-page-link') {
    void saveCurrentPageLinkFromTab(tab.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      const result = await handleMessage(message, sender);
      sendResponse(result);
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return true;
});

async function handleMessage(message, sender) {
  const tabId = Number(message?.tabId || sender?.tab?.id || 0);

  switch (message?.type) {
    case 'healthcheck':
      return await checkDesktopServer();
    case 'inspect-page':
      return await inspectPage(tabId);
    case 'save-xhs':
      return await saveXhsNoteFromTab(tabId);
    case 'save-youtube':
      return await saveYouTubeFromTab(tabId);
    case 'save-selection':
      return await saveSelectedTextFromTab(tabId);
    case 'save-page-link':
      return await saveCurrentPageLinkFromTab(tabId);
    default:
      return { success: false, error: 'Unsupported action' };
  }
}

async function inspectPage(tabId) {
  const pageInfo = await runExtraction(tabId, detectCaptureTarget);
  return {
    success: true,
    pageInfo: pageInfo || {
      kind: 'generic',
      label: '保存当前页面链接',
      description: '当前页面可作为链接收藏保存到知识库。',
    },
  };
}

async function checkDesktopServer() {
  try {
    const response = await fetch(`${API_ROOT}/status`, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postJson(endpoint, payload) {
  const response = await fetch(`${API_ROOT}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }

  return data || { success: true };
}

async function runExtraction(tabId, func) {
  if (!tabId) {
    throw new Error('No active tab');
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
  });
  if (!result) {
    throw new Error('Failed to execute page extraction');
  }
  return result.result;
}

async function saveSelectedTextFromTab(tabId) {
  const payload = await runExtraction(tabId, extractSelectedTextPayload);
  if (!payload?.text) {
    throw new Error('当前页面没有选中文字');
  }
  const response = await postJson('/save-text', payload);
  return {
    success: true,
    mode: 'selection',
    noteId: response.noteId || '',
  };
}

async function saveCurrentPageLinkFromTab(tabId) {
  const payload = await runExtraction(tabId, extractCurrentPageLinkPayload);
  const response = await postJson('/save-text', payload);
  return {
    success: true,
    mode: 'page-link',
    noteId: response.noteId || '',
  };
}

async function saveYouTubeFromTab(tabId) {
  const payload = await runExtraction(tabId, extractYouTubePayload);
  if (!payload?.videoId) {
    throw new Error('当前页面不是可识别的 YouTube 视频页');
  }
  const response = await postJson('/youtube-notes', payload);
  return {
    success: true,
    mode: 'youtube',
    noteId: response.noteId || '',
    duplicate: Boolean(response.duplicate),
  };
}

async function saveXhsNoteFromTab(tabId) {
  const payload = await runExtraction(tabId, extractXhsNotePayload);
  if (!payload?.title && !payload?.content && !payload?.images?.length && !payload?.videoUrl) {
    throw new Error('当前页面未识别到可保存的小红书笔记或文章');
  }
  const response = await postJson('/notes', payload);
  return {
    success: true,
    mode: 'xhs',
    noteId: response.noteId || '',
  };
}

function extractSelectedTextPayload() {
  const text = String(window.getSelection?.()?.toString?.() || '').trim();
  return {
    title: document.title || 'Text Clipping',
    url: location.href,
    text,
  };
}

function extractCurrentPageLinkPayload() {
  const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  const title = String(document.title || 'Untitled Page').trim();
  const text = [title, metaDescription, location.href].filter(Boolean).join('\n\n');
  return {
    title,
    url: location.href,
    text,
  };
}

function extractYouTubePayload() {
  const url = new URL(location.href);
  let videoId = '';
  if (url.hostname.includes('youtu.be')) {
    videoId = url.pathname.split('/').filter(Boolean)[0] || '';
  } else if (url.pathname.startsWith('/watch')) {
    videoId = url.searchParams.get('v') || '';
  } else if (url.pathname.startsWith('/shorts/')) {
    videoId = url.pathname.split('/').filter(Boolean)[1] || '';
  }

  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || document.title
    || '';
  const description = document.querySelector('meta[property="og:description"]')?.getAttribute('content')
    || document.querySelector('meta[name="description"]')?.getAttribute('content')
    || '';
  const thumbnailUrl = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';

  return {
    videoId: String(videoId || '').trim(),
    videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : location.href,
    title: String(title || '').trim(),
    description: String(description || '').trim(),
    thumbnailUrl: String(thumbnailUrl || '').trim(),
  };
}

function extractXhsNotePayload() {
  function parseCountText(value) {
    if (!value) return 0;
    const text = String(value).trim();
    const cleaned = text.replace(/[\s,]/g, '').replace(/[^0-9.\u4e00-\u9fa5]/g, '');
    if (!cleaned) return 0;
    if (cleaned.includes('亿')) {
      const num = parseFloat(cleaned.replace('亿', ''));
      return Number.isNaN(num) ? 0 : Math.round(num * 100000000);
    }
    if (cleaned.includes('万')) {
      const num = parseFloat(cleaned.replace('万', ''));
      return Number.isNaN(num) ? 0 : Math.round(num * 10000);
    }
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? 0 : Math.round(num);
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

  function getCurrentNoteRoot() {
    return (
      document.querySelector('#noteContainer.note-container[data-render-status]') ||
      document.querySelector('#noteContainer.note-container') ||
      document.querySelector('#noteContainer') ||
      document.querySelector('.note-container') ||
      document.querySelector('.note-content') ||
      document.body
    );
  }

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

  function pushUniqueUrl(list, value) {
    if (!value || typeof value !== 'string') return;
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (!list.includes(url)) {
      list.push(url);
    }
  }

  function getNoteTitle(root) {
    return (
      document.querySelector('#detail-title')?.innerText?.trim() ||
      root.querySelector('#detail-title')?.innerText?.trim() ||
      root.querySelector('.note-title')?.innerText?.trim() ||
      root.querySelector('.title')?.innerText?.trim() ||
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      document.title ||
      '笔记'
    );
  }

  function getTextContent(root) {
    const textEls = Array.from(root.querySelectorAll('#detail-desc .note-text, .desc .note-text, .note-content .note-text'));
    const joined = textEls
      .map((el) => el.innerText?.trim())
      .filter(Boolean)
      .join('\n\n');
    if (joined) return joined;
    const metaDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content')
      || document.querySelector('meta[name="description"]')?.getAttribute('content')
      || '';
    return String(metaDescription || '').trim();
  }

  function getAuthor(root) {
    return (
      root.querySelector('.author .username')?.innerText?.trim() ||
      root.querySelector('.author-wrapper .username')?.innerText?.trim() ||
      root.querySelector('.username')?.innerText?.trim() ||
      '未知'
    );
  }

  function getImageUrls(root, stateNote) {
    const urls = [];
    const imageList = Array.isArray(stateNote?.imageList)
      ? stateNote.imageList
      : Array.isArray(stateNote?.images)
        ? stateNote.images
        : [];

    imageList.forEach((item) => {
      if (typeof item === 'string') {
        pushUniqueUrl(urls, item);
        return;
      }
      pushUniqueUrl(urls, item?.urlDefault);
      pushUniqueUrl(urls, item?.urlPre);
      pushUniqueUrl(urls, item?.url);
      pushUniqueUrl(urls, item?.urlDefaultWebp);
    });

    if (urls.length > 0) return urls;

    const imgEls = Array.from(root.querySelectorAll('.img-container img, .note-content .img-container img, .swiper-slide img'));
    imgEls.forEach((img) => {
      pushUniqueUrl(urls, img.getAttribute('src') || img.getAttribute('data-src') || '');
    });
    return urls;
  }

  function getVideoUrl(root, stateNote) {
    const candidates = [];
    const h264 = stateNote?.video?.media?.stream?.h264 || [];
    const h265 = stateNote?.video?.media?.stream?.h265 || [];
    [...h264, ...h265].forEach((item) => {
      pushUniqueUrl(candidates, item?.masterUrl);
    });
    pushUniqueUrl(candidates, stateNote?.video?.media?.masterUrl);
    pushUniqueUrl(candidates, stateNote?.video?.media?.url);
    pushUniqueUrl(candidates, stateNote?.video?.url);
    if (candidates.length > 0) return candidates[0];

    const videoEl = root.querySelector('video');
    if (videoEl?.src) return videoEl.src;
    const sourceEl = videoEl?.querySelector('source[src]');
    return sourceEl?.src || null;
  }

  function getCoverUrl(root, images, videoUrl) {
    const poster = root.querySelector('video')?.getAttribute('poster');
    if (poster) return poster;
    if (images[0]) return images[0];
    if (videoUrl) {
      return document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;
    }
    return document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;
  }

  function getStats() {
    const likeEl = Array.from(document.querySelectorAll('.like-wrapper .count,[class*="like-wrapper"] .count,[class*="like"] .count'))
      .find((el) => !el.closest('.comments-el') && !el.closest('[class*="comments-el"]'));
    const collectEl = Array.from(document.querySelectorAll('.collect-wrapper .count,[class*="collect-wrapper"] .count,[class*="collect"] .count'))
      .find((el) => !el.closest('.comments-el') && !el.closest('[class*="comments-el"]'));

    return {
      likes: parseCountText(likeEl?.innerText || ''),
      collects: parseCountText(collectEl?.innerText || ''),
    };
  }

  const root = getCurrentNoteRoot();
  const stateNote = getCurrentStateNote();
  const title = String(getNoteTitle(root) || '').trim();
  const content = String(getTextContent(root) || '').trim();
  const images = getImageUrls(root, stateNote).slice(0, 9);
  const videoUrl = getVideoUrl(root, stateNote);
  const coverUrl = getCoverUrl(root, images, videoUrl);

  return {
    noteId: `xhs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    author: getAuthor(root),
    content,
    text: content,
    images,
    coverUrl,
    videoUrl,
    stats: getStats(),
    source: location.href,
  };
}

function detectCaptureTarget() {
  const hostname = String(location.hostname || '').toLowerCase();

  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') {
    const url = new URL(location.href);
    const isVideoPage = url.pathname.startsWith('/watch') || url.pathname.startsWith('/shorts/') || hostname === 'youtu.be';
    if (isVideoPage) {
      return {
        kind: 'youtube',
        action: 'save-youtube',
        label: '保存youtube视频到知识库',
        description: '当前页面已识别为 YouTube 视频页。',
      };
    }
  }

  if (/(^|\.)xiaohongshu\.com$/i.test(hostname)) {
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

    const noteRoot = document.querySelector('#noteContainer, .note-container, .note-content');
    const stateNote = getCurrentStateNote();
    const stateHasVideo = Boolean(
      stateNote?.video?.media ||
      stateNote?.video?.stream ||
      stateNote?.video?.url ||
      stateNote?.video?.media?.masterUrl ||
      stateNote?.type === 'video' ||
      stateNote?.noteType === 'video'
    );
    const domHasVideo = Boolean(document.querySelector('#noteContainer video, .note-container video, .note-content video'));
    const isVideoNote = stateHasVideo || domHasVideo;

    if (noteRoot || stateNote) {
      return {
        kind: isVideoNote ? 'xhs-video' : 'xhs-image',
        action: 'save-xhs',
        label: isVideoNote ? '保存小红书视频笔记到知识库' : '保存小红书图文到知识库',
        description: isVideoNote ? '当前页面已识别为小红书视频笔记。' : '当前页面已识别为小红书图文笔记。'
      };
    }

    const articleRoot = document.querySelector('[class*="article"], .article-container, .content-container');
    if (articleRoot) {
      return {
        kind: 'xhs-article',
        action: 'save-xhs',
        label: '保存小红书图文到知识库',
        description: '当前页面已识别为小红书图文内容页。',
      };
    }
  }

  return {
    kind: 'generic',
    action: 'save-page-link',
    label: '保存当前页面链接',
    description: '当前页面可作为链接收藏保存到知识库。',
  };
}
