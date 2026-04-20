const KNOWLEDGE_API_CANDIDATES = [
  {
    baseUrl: 'http://127.0.0.1:31937',
    endpointPath: '/api/knowledge',
  },
  {
    baseUrl: 'http://localhost:31937',
    endpointPath: '/api/knowledge',
  },
];
const pageStateCache = new Map();
const PAGE_STATE_NEGATIVE_TTL_MS = 350;
const KNOWLEDGE_API_CACHE_TTL_MS = 30_000;
const MENU_ROOT_ID = 'redbox-root';
const MENU_PAGE_ID = 'redbox-save-page-auto';
const MENU_SELECTION_ID = 'redbox-save-selection';
const MENU_LINK_ID = 'redbox-save-link';
const MENU_IMAGE_ID = 'redbox-save-image';
const MENU_VIDEO_ID = 'redbox-save-video';

let cachedKnowledgeApi = null;
let cachedKnowledgeApiAt = 0;

function describeError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function pluginLog(scope, details) {
  console.log(`[redbox-plugin][${scope}]`, details);
}

function pluginWarn(scope, details) {
  console.warn(`[redbox-plugin][${scope}]`, details);
}

function pluginError(scope, details) {
  console.error(`[redbox-plugin][${scope}]`, details);
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

function ensureContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ROOT_ID,
      title: '保存到 RedBox',
      contexts: ['page', 'selection', 'link', 'image', 'video'],
    });
    chrome.contextMenus.create({
      id: MENU_PAGE_ID,
      parentId: MENU_ROOT_ID,
      title: '保存当前页面内容到知识库',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION_ID,
      parentId: MENU_ROOT_ID,
      title: '保存选中文字到知识库',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_LINK_ID,
      parentId: MENU_ROOT_ID,
      title: '保存当前链接到知识库',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: MENU_IMAGE_ID,
      parentId: MENU_ROOT_ID,
      title: '保存当前图片到素材库',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_VIDEO_ID,
      parentId: MENU_ROOT_ID,
      title: '保存当前视频到知识库',
      contexts: ['video'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenus();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pageStateCache.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    pageStateCache.delete(tabId);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const run = async () => {
    if (info.menuItemId === MENU_PAGE_ID) {
      await saveCurrentPageFromTab(tab.id);
      return;
    }
    if (info.menuItemId === MENU_SELECTION_ID) {
      await saveSelectedTextFromTab(tab.id);
      return;
    }
    if (info.menuItemId === MENU_LINK_ID) {
      await saveLinkFromContext(tab, info);
      return;
    }
    if (info.menuItemId === MENU_IMAGE_ID) {
      await saveImageFromContext(tab, info);
      return;
    }
    if (info.menuItemId === MENU_VIDEO_ID) {
      await saveVideoFromContext(tab, info);
    }
  };
  void run().catch((error) => {
    pluginError('context-menu-action', {
      menuItemId: String(info?.menuItemId || ''),
      tabId: Number(tab?.id || 0) || null,
      error: describeError(error),
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      const result = await handleMessage(message, sender);
      sendResponse(result);
    } catch (error) {
      pluginError('runtime-message', {
        type: message?.type || 'unknown',
        tabId: Number(message?.tabId || sender?.tab?.id || 0) || null,
        error: describeError(error),
      });
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
  pluginLog('handle-message', {
    type: message?.type || 'unknown',
    tabId: tabId || null,
    senderTabUrl: String(sender?.tab?.url || ''),
  });

  switch (message?.type) {
    case 'page-state:update':
      if (sender?.tab?.id) {
        pageStateCache.set(sender.tab.id, {
          pageInfo: message.pageInfo || null,
          url: String(message.url || sender.tab.url || ''),
          updatedAt: Date.now(),
        });
      }
      return { success: true };
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
    case 'save-page-auto':
      return await saveCurrentPageFromTab(tabId);
    case 'save-page-link':
      return await saveCurrentPageLinkFromTab(tabId);
    case 'save-drag-image':
      return await saveDraggedImagePayload(message?.payload, sender?.tab);
    default:
      return { success: false, error: 'Unsupported action' };
  }
}

async function inspectPage(tabId) {
  let pageInfo = null;
  const cached = pageStateCache.get(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    const currentUrl = String(tab?.url || '');
    const shouldTrustCache = Boolean(
      cached &&
      cached.url === currentUrl &&
      cached.pageInfo &&
      (
        cached.pageInfo.detected ||
        (Date.now() - Number(cached.updatedAt || 0)) < PAGE_STATE_NEGATIVE_TTL_MS
      )
    );

    if (shouldTrustCache) {
      pageInfo = cached.pageInfo;
    } else {
      const contentResponse = await chrome.tabs.sendMessage(tabId, { type: 'page-state:get' }).catch(() => null);
      if (contentResponse?.success && contentResponse?.pageInfo) {
        pageInfo = contentResponse.pageInfo;
        pageStateCache.set(tabId, {
          pageInfo,
          url: currentUrl,
          updatedAt: Date.now(),
        });
      }
    }
    if (!pageInfo) {
      pageInfo = await runExtraction(tabId, detectCaptureTarget).catch(() => detectCaptureTargetFromUrl(currentUrl));
    }
  } catch {
    pageInfo = await runExtraction(tabId, detectCaptureTarget).catch(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        return detectCaptureTargetFromUrl(String(tab?.url || ''));
      } catch {
        return null;
      }
    });
  }
  return {
    success: true,
    pageInfo: pageInfo || createLinkFallbackPageInfo(),
  };
}

function detectCaptureTargetFromUrl(rawUrl) {
  let hostname = '';
  let pathname = '';
  try {
    const parsed = new URL(String(rawUrl || ''));
    hostname = String(parsed.hostname || '').toLowerCase();
    pathname = String(parsed.pathname || '');
  } catch {
    return null;
  }

  if (hostname === 'mp.weixin.qq.com') {
    return {
      kind: 'wechat-article',
      action: 'save-page-link',
      label: '保存公众号文章到知识库',
      description: '当前页面已识别为公众号文章，将完整保存正文、图片和排版。',
      detected: true,
    };
  }

  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') {
    const isVideoPage = pathname.startsWith('/watch') || pathname.startsWith('/shorts/') || hostname === 'youtu.be';
    if (isVideoPage) {
      return {
        kind: 'youtube',
        action: 'save-youtube',
        label: '保存YouTube视频到知识库',
        description: '当前页面已识别为 YouTube 视频页。',
        detected: true,
      };
    }

    return createLinkFallbackPageInfo({
      kind: 'youtube-generic',
      description: '当前页面还没有稳定识别到有效的视频内容。',
    });
  }

  if (/(^|\.)xiaohongshu\.com$/i.test(hostname)) {
    return createLinkFallbackPageInfo({
      kind: 'xhs-pending',
      description: '当前页面还没有稳定识别到有效的小红书笔记内容。',
    });
  }

  return createLinkFallbackPageInfo();
}

async function checkDesktopServer() {
  try {
    const endpoint = await resolveKnowledgeApiEndpoint();
    const response = await fetchKnowledgeJson(endpoint, '/health', {
      method: 'GET',
    });
    pluginLog('healthcheck-success', {
      endpoint: `${endpoint.baseUrl}${endpoint.endpointPath}`,
      counts: response?.counts || null,
    });
    return {
      success: true,
      endpoint: `${endpoint.baseUrl}${endpoint.endpointPath}`,
      health: response,
    };
  } catch (error) {
    pluginError('healthcheck-failed', {
      error: describeError(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveKnowledgeApiEndpoint(forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedKnowledgeApi &&
    (now - cachedKnowledgeApiAt) < KNOWLEDGE_API_CACHE_TTL_MS
  ) {
    return cachedKnowledgeApi;
  }

  let lastError = null;
  const attemptedUrls = [];
  for (const candidate of KNOWLEDGE_API_CANDIDATES) {
    const probeUrl = `${candidate.baseUrl}${candidate.endpointPath}/health`;
    attemptedUrls.push(probeUrl);
    try {
      pluginLog('endpoint-probe', {
        url: probeUrl,
      });
      const response = await fetchKnowledgeJson(candidate, '/health', {
        method: 'GET',
      });
      if (response?.success) {
        cachedKnowledgeApi = candidate;
        cachedKnowledgeApiAt = now;
        pluginLog('endpoint-selected', {
          url: `${candidate.baseUrl}${candidate.endpointPath}`,
        });
        return candidate;
      }
      lastError = new Error(response?.error || 'Knowledge API healthcheck failed');
      pluginWarn('endpoint-probe-non-success', {
        url: probeUrl,
        response,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      pluginWarn('endpoint-probe-failed', {
        url: probeUrl,
        error: describeError(lastError),
      });
    }
  }

  throw new Error(
    `未连接到 RedBox Knowledge API。已尝试: ${attemptedUrls.join(', ')}。` +
    `最后错误: ${lastError?.message || 'unknown error'}。` +
    ' 请确认桌面应用已启动，并且 assistant daemon 正在监听 127.0.0.1:31937。'
  );
}

async function fetchKnowledgeJson(endpoint, path, init = {}) {
  const url = `${endpoint.baseUrl}${endpoint.endpointPath}${path}`;
  const headers = new Headers(init.headers || {});
  const method = String(init.method || 'GET').toUpperCase();
  if (!headers.has('Content-Type') && init.method && init.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }

  pluginLog('http-request', {
    method,
    url,
  });

  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
    });
  } catch (error) {
    pluginError('http-network-failed', {
      method,
      url,
      error: describeError(error),
    });
    throw new Error(`请求失败: ${method} ${url} -> ${error instanceof Error ? error.message : String(error)}`);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || data?.success === false) {
    pluginError('http-response-failed', {
      method,
      url,
      status: response.status,
      body: data,
    });
    throw new Error(data?.error || `HTTP ${response.status}`);
  }

  pluginLog('http-response', {
    method,
    url,
    status: response.status,
    success: data?.success !== false,
  });

  return data || { success: true };
}

async function postKnowledgeEntry(payload) {
  const endpoint = await resolveKnowledgeApiEndpoint();
  pluginLog('entry-submit', {
    endpoint: `${endpoint.baseUrl}${endpoint.endpointPath}/entries`,
    kind: String(payload?.kind || ''),
    sourceDomain: String(payload?.source?.sourceDomain || ''),
    sourceLink: String(payload?.source?.sourceLink || ''),
    sourceUrl: String(payload?.source?.sourceUrl || ''),
    externalId: String(payload?.source?.externalId || ''),
  });
  const response = await fetchKnowledgeJson(endpoint, '/entries', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  pluginLog('entry-submit-success', {
    kind: String(payload?.kind || ''),
    entryId: response?.entryId || '',
    duplicate: Boolean(response?.duplicate),
    updated: Boolean(response?.updated),
  });
  return response;
}

async function postKnowledgeMediaAssets(payload) {
  const endpoint = await resolveKnowledgeApiEndpoint();
  pluginLog('media-submit', {
    endpoint: `${endpoint.baseUrl}${endpoint.endpointPath}/media-assets`,
    sourceDomain: String(payload?.source?.sourceDomain || ''),
    sourceLink: String(payload?.source?.sourceLink || ''),
    itemCount: Array.isArray(payload?.items) ? payload.items.length : 0,
  });
  const response = await fetchKnowledgeJson(endpoint, '/media-assets', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  pluginLog('media-submit-success', {
    imported: Number(response?.imported || 0),
  });
  return response;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function truncateText(value, maxLength) {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function hashString(value) {
  const input = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function replaceRichHtmlTokens(html, replacements) {
  let output = String(html || '');
  for (const item of Array.isArray(replacements) ? replacements : []) {
    const token = normalizeText(item?.token);
    const url = normalizeText(item?.url);
    if (!token || !url) continue;
    output = output.split(token).join(url);
  }
  return output;
}

function extractDomainFromUrl(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  try {
    return String(new URL(raw).hostname || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(normalizeText(value));
}

function isDirectResourceSource(value) {
  const raw = normalizeText(value);
  return isHttpUrl(raw) || raw.startsWith('data:');
}

function extractPathTitle(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const lastSegment = String(parsed.pathname || '')
      .split('/')
      .filter(Boolean)
      .pop() || '';
    const clean = decodeURIComponent(lastSegment).replace(/\.[a-z0-9]+$/i, '').trim();
    return clean;
  } catch {
    return '';
  }
}

function inferSiteNameFromUrl(value) {
  return extractDomainFromUrl(value).replace(/^www\./i, '');
}

function createKnowledgeSourceInput(fields = {}) {
  const sourceLink = normalizeText(fields.sourceLink || fields.sourceUrl);
  const sourceDomain = normalizeText(fields.sourceDomain) || extractDomainFromUrl(sourceLink);
  return {
    appId: 'redbox-capture',
    pluginId: 'redbox-browser-extension',
    sourceDomain: sourceDomain || undefined,
    sourceLink: sourceLink || undefined,
    sourceUrl: sourceLink || undefined,
    externalId: normalizeText(fields.externalId) || undefined,
    capturedAt: new Date().toISOString(),
  };
}

function buildLinkTargetEntry(payload = {}) {
  const sourceUrl = normalizeText(payload?.url);
  const sourceDomain = extractDomainFromUrl(sourceUrl);
  const title = normalizeText(payload?.title) || extractPathTitle(sourceUrl) || '网页链接';
  const description = normalizeText(payload?.description)
    || normalizeText(payload?.text)
    || normalizeText(payload?.excerpt)
    || sourceUrl;

  if (!sourceUrl) {
    throw new Error('缺少可保存的链接地址');
  }
  if (!isHttpUrl(sourceUrl)) {
    throw new Error('当前链接不是可保存的网页地址');
  }

  return {
    kind: 'webpage',
    source: createKnowledgeSourceInput({
      sourceLink: sourceUrl,
      sourceDomain,
      externalId: `link-${hashString(sourceUrl)}`,
    }),
    content: {
      title,
      text: description,
      excerpt: truncateText(description, 180),
      description: truncateText(description, 500),
      siteName: normalizeText(payload?.siteName) || inferSiteNameFromUrl(sourceUrl) || undefined,
      tags: Array.isArray(payload?.tags) ? payload.tags.filter(Boolean) : ['链接收藏'],
    },
    assets: {
      coverUrl: normalizeText(payload?.coverUrl) || undefined,
    },
    options: {
      allowUpdate: true,
      summarize: false,
      transcribe: false,
    },
  };
}

function buildVideoResourceEntry(payload = {}) {
  const pageUrl = normalizeText(payload?.pageUrl || payload?.sourceLink || payload?.url);
  const videoUrl = normalizeText(payload?.videoUrl || payload?.srcUrl);
  const sourceLink = pageUrl || videoUrl;
  const sourceDomain = extractDomainFromUrl(sourceLink);
  const title = normalizeText(payload?.title)
    || extractPathTitle(videoUrl)
    || extractPathTitle(sourceLink)
    || '视频内容';

  if (!sourceLink) {
    throw new Error('缺少可保存的视频来源');
  }

  return {
    kind: 'webpage',
    source: createKnowledgeSourceInput({
      sourceLink,
      sourceDomain,
      externalId: `video-${hashString(`${sourceLink}\n${videoUrl}`)}`,
    }),
    content: {
      title,
      text: normalizeText(payload?.description) || videoUrl || sourceLink,
      excerpt: truncateText(normalizeText(payload?.description) || title, 180),
      description: truncateText(normalizeText(payload?.description) || videoUrl || sourceLink, 500),
      siteName: inferSiteNameFromUrl(sourceLink) || undefined,
      tags: ['视频'],
    },
    assets: {
      videoUrl: videoUrl || undefined,
      coverUrl: normalizeText(payload?.coverUrl) || undefined,
    },
    options: {
      allowUpdate: true,
      summarize: false,
      transcribe: false,
    },
  };
}

function buildImageAssetPayload(payload = {}) {
  const pageUrl = normalizeText(payload?.pageUrl || payload?.sourceLink || payload?.url);
  const imageUrl = normalizeText(payload?.imageUrl || payload?.srcUrl);
  const sourceLink = pageUrl || imageUrl;
  const sourceDomain = extractDomainFromUrl(sourceLink);
  const title = normalizeText(payload?.title)
    || extractPathTitle(imageUrl)
    || extractPathTitle(sourceLink)
    || '网页图片';

  if (!imageUrl) {
    throw new Error('缺少可保存的图片地址');
  }
  if (!isDirectResourceSource(imageUrl)) {
    throw new Error('当前图片资源暂不支持直接保存');
  }

  return {
    source: createKnowledgeSourceInput({
      sourceLink,
      sourceDomain,
      externalId: `image-${hashString(`${sourceLink}\n${imageUrl}`)}`,
    }),
    items: [
      {
        title,
        source: imageUrl,
      },
    ],
  };
}

function buildSelectionEntry(payload) {
  const text = normalizeText(payload?.text);
  const sourceUrl = normalizeText(payload?.url);
  const sourceDomain = extractDomainFromUrl(sourceUrl);
  const title = normalizeText(payload?.title) || '网页摘录';

  if (!text) {
    throw new Error('当前页面没有选中文字');
  }

  return {
    kind: 'text-note',
    source: createKnowledgeSourceInput({
      sourceUrl,
      externalId: `selection-${hashString(`${sourceUrl}\n${text}`)}`,
    }),
    content: {
      title,
      text,
      excerpt: truncateText(text, 180),
      siteName: sourceDomain || sourceUrl,
      tags: ['网页摘录'],
    },
    assets: {},
    options: {
      dedupeKey: `selection:${hashString(`${sourceUrl}\n${text}`)}`,
      allowUpdate: false,
      summarize: false,
      transcribe: false,
    },
  };
}

function buildPageLinkEntry(payload) {
  const sourceUrl = normalizeText(payload?.url);
  const sourceDomain = extractDomainFromUrl(sourceUrl);
  const title = normalizeText(payload?.title) || '网页收藏';
  const richHtmlDocument = replaceRichHtmlTokens(
    payload?.richHtmlDocument,
    payload?.richHtmlImageMap,
  );
  const kind = normalizeText(payload?.captureKind)
    || (payload?.type === 'link-article' ? 'link-article' : 'webpage');
  const text = normalizeText(payload?.text)
    || normalizeText(payload?.excerpt)
    || sourceUrl;

  if (!sourceUrl) {
    throw new Error('当前页面缺少可保存的链接地址');
  }

  return {
    kind,
    source: createKnowledgeSourceInput({
      sourceUrl,
      externalId: `page-${hashString(sourceUrl)}`,
    }),
    content: {
      title,
      author: normalizeText(payload?.author),
      text,
      excerpt: truncateText(payload?.excerpt || text, 180),
      html: richHtmlDocument || undefined,
      description: truncateText(text, 500),
      siteName: normalizeText(payload?.siteName) || sourceDomain || undefined,
      tags: Array.isArray(payload?.tags) ? payload.tags.filter(Boolean) : [],
    },
    assets: {
      coverUrl: normalizeText(payload?.coverUrl) || undefined,
      imageUrls: Array.isArray(payload?.images) ? payload.images.filter(Boolean) : [],
    },
    options: {
      dedupeKey: undefined,
      allowUpdate: true,
      summarize: false,
      transcribe: false,
    },
  };
}

function buildYouTubeEntry(payload) {
  const videoId = normalizeText(payload?.videoId);
  const videoUrl = normalizeText(payload?.videoUrl);
  const sourceDomain = extractDomainFromUrl(videoUrl);
  const title = normalizeText(payload?.title);

  if (!videoId || !videoUrl || !title) {
    throw new Error('当前页面不是可识别的 YouTube 视频页');
  }

  return {
    kind: 'youtube-video',
    source: createKnowledgeSourceInput({
      sourceUrl: videoUrl,
      externalId: videoId,
    }),
    content: {
      title,
      description: normalizeText(payload?.description),
      text: normalizeText(payload?.description),
      siteName: sourceDomain || 'youtube.com',
      tags: ['YouTube'],
    },
    assets: {
      thumbnailUrl: normalizeText(payload?.thumbnailUrl) || undefined,
    },
    options: {
      dedupeKey: videoId,
      allowUpdate: true,
      summarize: false,
      transcribe: false,
    },
  };
}

function buildXhsEntry(payload) {
  function extractTagsFromText(value) {
    const tags = [];
    const seen = new Set();
    for (const token of String(value || '').split('#').slice(1)) {
      const candidate = String(token)
        .split(/\r?\n/, 1)[0]
        .split(/\s+/, 1)[0]
        .replace(/^[#]+|[，,。.！!？?]+$/g, '')
        .trim();
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      tags.push(candidate);
    }
    return tags;
  }

  const sourceUrl = normalizeText(payload?.source);
  const sourceDomain = extractDomainFromUrl(sourceUrl) || 'www.xiaohongshu.com';
  const stableNoteId = normalizeText(payload?.noteId)
    || `xhs-${hashString(sourceUrl)}`;
  const videoAssetUrl = normalizeText(payload?.videoDataUrl)
    || normalizeText(payload?.videoUrl);
  const imageUrls = Array.isArray(payload?.images) ? payload.images.filter(Boolean) : [];
  const kind = videoAssetUrl && imageUrls.length === 0 ? 'xhs-video' : 'xhs-note';
  const text = normalizeText(payload?.text) || normalizeText(payload?.content);
  const tags = Array.from(new Set(['小红书', ...extractTagsFromText(text)]));

  return {
    kind,
    source: createKnowledgeSourceInput({
      sourceLink: sourceUrl,
      externalId: stableNoteId,
      sourceDomain,
    }),
    content: {
      title: normalizeText(payload?.title) || '小红书内容',
      author: normalizeText(payload?.author),
      text,
      excerpt: truncateText(text, 180),
      description: truncateText(text, 500),
      siteName: sourceDomain,
      tags,
      stats: {
        likes: Number(payload?.stats?.likes || 0),
        collects: Number(payload?.stats?.collects || 0),
      },
    },
    assets: {
      coverUrl: normalizeText(payload?.coverUrl) || imageUrls[0] || undefined,
      imageUrls,
      videoUrl: videoAssetUrl || undefined,
    },
    options: {
      dedupeKey: stableNoteId,
      allowUpdate: true,
      summarize: false,
      transcribe: false,
    },
  };
}

async function runExtraction(tabId, func, options = {}) {
  if (!tabId) {
    throw new Error('No active tab');
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: Array.isArray(options.args) ? options.args : [],
    world: options.world || 'ISOLATED',
  });
  if (!result) {
    throw new Error('Failed to execute page extraction');
  }
  return result.result;
}

async function saveSelectedTextFromTab(tabId) {
  const payload = await runExtraction(tabId, extractSelectedTextPayload);
  const response = await postKnowledgeEntry(buildSelectionEntry(payload));
  return {
    success: true,
    mode: 'selection',
    noteId: response.entryId || '',
    duplicate: Boolean(response.duplicate),
  };
}

async function saveCurrentPageFromTab(tabId) {
  const inspection = await inspectPage(tabId);
  const action = normalizeText(inspection?.pageInfo?.action) || 'save-page-link';
  if (action === 'save-xhs') {
    return await saveXhsNoteFromTab(tabId);
  }
  if (action === 'save-youtube') {
    return await saveYouTubeFromTab(tabId);
  }
  return await saveCurrentPageLinkFromTab(tabId);
}

async function saveCurrentPageLinkFromTab(tabId) {
  const payload = await runExtraction(tabId, extractCurrentPageLinkPayload, { world: 'MAIN' });
  if (!payload || typeof payload !== 'object') {
    throw new Error('当前页面内容提取失败，请刷新页面后重试');
  }
  const response = await postKnowledgeEntry(buildPageLinkEntry(payload));
  return {
    success: true,
    mode: 'page-link',
    noteId: response.entryId || '',
    duplicate: Boolean(response.duplicate),
  };
}

async function saveYouTubeFromTab(tabId) {
  const payload = await runExtraction(tabId, extractYouTubePayload);
  const response = await postKnowledgeEntry(buildYouTubeEntry(payload));
  return {
    success: true,
    mode: 'youtube',
    noteId: response.entryId || '',
    duplicate: Boolean(response.duplicate),
  };
}

async function saveXhsNoteFromTab(tabId) {
  const payload = await runExtraction(tabId, extractXhsNotePayload, { world: 'MAIN' });
  console.log('[redbox-plugin][xhs] payload', {
    title: payload?.title || '',
    imageCount: Array.isArray(payload?.images) ? payload.images.length : 0,
    hasCoverUrl: Boolean(payload?.coverUrl),
    videoUrl: String(payload?.videoUrl || ''),
    hasVideoDataUrl: Boolean(payload?.videoDataUrl),
  });
  if (!payload?.title && !payload?.content && !payload?.images?.length && !payload?.videoUrl) {
    throw new Error('当前页面未识别到可保存的小红书笔记或文章');
  }
  const response = await postKnowledgeEntry(buildXhsEntry(payload));
  return {
    success: true,
    mode: 'xhs',
    noteId: response.entryId || '',
    duplicate: Boolean(response.duplicate),
  };
}

async function saveLinkFromContext(tab, info) {
  const linkUrl = normalizeText(info?.linkUrl);
  if (!linkUrl) {
    throw new Error('未检测到可保存的链接');
  }
  if (!isHttpUrl(linkUrl)) {
    throw new Error('当前链接不是可保存的网页地址');
  }
  const response = await postKnowledgeEntry(buildLinkTargetEntry({
    url: linkUrl,
    title: normalizeText(info?.linkText) || normalizeText(tab?.title),
    description: linkUrl,
    siteName: inferSiteNameFromUrl(linkUrl),
    tags: ['链接收藏'],
  }));
  return {
    success: true,
    mode: 'link',
    noteId: response.entryId || '',
    duplicate: Boolean(response.duplicate),
  };
}

async function saveImageFromContext(tab, info) {
  const imageUrl = normalizeText(info?.srcUrl);
  if (!imageUrl) {
    throw new Error('未检测到可保存的图片');
  }
  if (!isDirectResourceSource(imageUrl)) {
    throw new Error('当前图片资源暂不支持直接保存');
  }
  const response = await postKnowledgeMediaAssets(buildImageAssetPayload({
    imageUrl,
    pageUrl: normalizeText(info?.pageUrl) || normalizeText(tab?.url),
    title: normalizeText(tab?.title) || extractPathTitle(imageUrl) || '网页图片',
  }));
  return {
    success: true,
    mode: 'image',
    imported: Number(response?.imported || 0),
  };
}

async function saveDraggedImagePayload(payload, tab) {
  const imageUrl = normalizeText(payload?.imageUrl || payload?.srcUrl);
  if (!imageUrl) {
    throw new Error('未检测到可保存的拖拽图片');
  }
  if (!isDirectResourceSource(imageUrl)) {
    throw new Error('当前拖拽图片暂不支持直接保存');
  }

  const response = await postKnowledgeMediaAssets(buildImageAssetPayload({
    imageUrl,
    pageUrl: normalizeText(payload?.pageUrl) || normalizeText(tab?.url),
    title: normalizeText(payload?.title) || normalizeText(tab?.title) || extractPathTitle(imageUrl) || '网页图片',
  }));
  return {
    success: true,
    mode: 'image-drop',
    imported: Number(response?.imported || 0),
  };
}

async function saveVideoFromContext(tab, info) {
  const tabUrl = normalizeText(tab?.url);
  const resourceUrl = normalizeText(info?.srcUrl);
  if (
    /(^|\.)youtube\.com$/i.test(extractDomainFromUrl(tabUrl))
    || extractDomainFromUrl(tabUrl) === 'youtu.be'
    || /(^|\.)xiaohongshu\.com$/i.test(extractDomainFromUrl(tabUrl))
  ) {
    return await saveCurrentPageFromTab(tab.id);
  }
  if (resourceUrl && !isHttpUrl(resourceUrl)) {
    return await saveCurrentPageFromTab(tab.id);
  }

  const response = await postKnowledgeEntry(buildVideoResourceEntry({
    pageUrl: normalizeText(info?.pageUrl) || tabUrl,
    videoUrl: resourceUrl,
    title: normalizeText(tab?.title) || '视频内容',
  }));
  return {
    success: true,
    mode: 'video',
    noteId: response.entryId || '',
    duplicate: Boolean(response.duplicate),
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectLinkArticleData() {
  function cleanText(value) {
    return String(value || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }

  function pickContent(values) {
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }

  function getMeta(selector, attr = 'content') {
    return document.querySelector(selector)?.getAttribute(attr) || '';
  }

  function toAbsoluteUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return raw;
    }
  }

  function scoreRoot(root) {
    if (!root) return 0;
    const text = cleanText(root.innerText || '');
    const textLength = text.length;
    const paragraphCount = root.querySelectorAll('p').length;
    const headingCount = root.querySelectorAll('h1,h2,h3').length;
    const articleBoost = root.matches?.('article, main, [role="main"]') ? 2000 : 0;
    return textLength + (paragraphCount * 120) + (headingCount * 50) + articleBoost;
  }

  function pickBestRoot() {
    if (location.hostname === 'mp.weixin.qq.com') {
      return document.querySelector('#js_content') || document.body;
    }

    const selectors = [
      '#js_content',
      '.rich_media_content',
      'article',
      'main',
      '[role="main"]',
      '.article',
      '.article-container',
      '.post-content',
      '.entry-content',
      '.markdown-body',
      '.rich-text',
      '.content',
      '.post',
      '.note-content',
    ];

    const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    if (!candidates.length) return document.body;
    return candidates
      .map((node) => ({ node, score: scoreRoot(node) }))
      .sort((a, b) => b.score - a.score)[0]?.node || document.body;
  }

  function collectParagraphText(root) {
    const selectors = 'h1,h2,h3,p,li,blockquote,pre';
    const nodes = Array.from(root.querySelectorAll(selectors));
    const parts = [];
    const seen = new Set();

    for (const node of nodes) {
      if (node.closest('nav, header, footer, aside, form, dialog, noscript')) continue;
      const text = cleanText(node.innerText || '');
      if (!text || text.length < 18) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
      if (parts.join('\n\n').length > 24000) break;
    }

    if (parts.length > 0) return parts.join('\n\n');
    return cleanText(root.innerText || '').slice(0, 24000);
  }

  function collectImageUrls(root) {
    const urls = [];
    const push = (value) => {
      const url = toAbsoluteUrl(value);
      if (!/^https?:\/\//i.test(url)) return;
      if (!urls.includes(url)) urls.push(url);
    };

    push(getMeta('meta[property="og:image"]'));
    push(getMeta('meta[name="twitter:image"]'));

    const images = Array.from(root.querySelectorAll('img[src], img[data-src], img[data-original]'));
    for (const img of images) {
      push(img.getAttribute('src'));
      push(img.getAttribute('data-src'));
      push(img.getAttribute('data-original'));
      if (urls.length >= 4) break;
    }

    return urls.slice(0, 4);
  }

  function buildWechatRichHtmlDocument(root) {
    if (location.hostname !== 'mp.weixin.qq.com' || !root) {
      return { html: '', imageMap: [] };
    }

    const clone = root.cloneNode(true);
    const imageMap = [];
    let imageIndex = 0;

    clone.querySelectorAll('script, style, noscript, iframe, form, input, button, textarea, canvas, audio, video').forEach((node) => node.remove());

    const allNodes = [clone, ...clone.querySelectorAll('*')];
    for (const node of allNodes) {
      if (!(node instanceof Element)) continue;

      for (const attr of Array.from(node.attributes)) {
        const name = String(attr.name || '').toLowerCase();
        const value = String(attr.value || '');
        if (name.startsWith('on')) {
          node.removeAttribute(attr.name);
          continue;
        }
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
          node.removeAttribute(attr.name);
        }
      }

      if (node.tagName === 'IMG') {
        const resolvedSrc = toAbsoluteUrl(
          node.getAttribute('data-src')
          || node.getAttribute('data-original')
          || node.getAttribute('src')
          || ''
        );
        if (!/^https?:\/\//i.test(resolvedSrc)) {
          node.remove();
          continue;
        }
        const token = `__REDBOX_WECHAT_IMAGE_${imageIndex++}__`;
        imageMap.push({ token, url: resolvedSrc });
        node.setAttribute('src', token);
        node.removeAttribute('data-src');
        node.removeAttribute('data-original');
        node.removeAttribute('srcset');
        node.setAttribute('loading', 'lazy');
        continue;
      }

      if (node.tagName === 'A') {
        const href = toAbsoluteUrl(node.getAttribute('href') || '');
        if (href) {
          node.setAttribute('href', href);
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        } else {
          node.removeAttribute('href');
        }
      }
    }

    const title = cleanText(document.querySelector('#activity-name')?.textContent || document.title || '公众号文章');
    const author = cleanText(
      document.querySelector('#js_name')?.textContent
      || document.querySelector('#js_author_name')?.textContent
      || ''
    );
    const publishTime = cleanText(document.querySelector('#publish_time')?.textContent || '');
    const accountName = cleanText(
      document.querySelector('#js_profile_qrcode strong')?.textContent
      || document.querySelector('#js_profile_qrcode span')?.textContent
      || ''
    );

    const bodyHtml = clone.innerHTML.trim();
    if (!bodyHtml) {
      return { html: '', imageMap: [] };
    }

    const subtitleParts = [author, publishTime, accountName].filter(Boolean);
    const subtitle = subtitleParts.join(' · ');
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f5f5f3;
      color: #1f2937;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
      line-height: 1.85;
    }
    .rb-wechat-shell {
      max-width: 820px;
      margin: 0 auto;
      padding: 28px 20px 60px;
    }
    .rb-wechat-article {
      background: #ffffff;
      border-radius: 18px;
      padding: 32px 28px 40px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
      border: 1px solid rgba(15, 23, 42, 0.06);
    }
    .rb-wechat-title {
      margin: 0;
      font-size: 30px;
      line-height: 1.3;
      font-weight: 700;
      color: #111827;
    }
    .rb-wechat-meta {
      margin-top: 12px;
      font-size: 13px;
      color: #6b7280;
    }
    .rb-wechat-body {
      margin-top: 26px;
      font-size: 17px;
      color: #1f2937;
      word-break: break-word;
    }
    .rb-wechat-body img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 18px auto;
      border-radius: 14px;
    }
    .rb-wechat-body p,
    .rb-wechat-body section,
    .rb-wechat-body div,
    .rb-wechat-body blockquote,
    .rb-wechat-body ul,
    .rb-wechat-body ol,
    .rb-wechat-body pre {
      margin-top: 0;
      margin-bottom: 1em;
    }
    .rb-wechat-body h1,
    .rb-wechat-body h2,
    .rb-wechat-body h3,
    .rb-wechat-body h4 {
      margin: 1.5em 0 0.8em;
      line-height: 1.35;
      color: #111827;
    }
    .rb-wechat-body blockquote {
      border-left: 4px solid #22c55e;
      background: #f0fdf4;
      padding: 12px 16px;
      border-radius: 10px;
      color: #166534;
    }
    .rb-wechat-body a {
      color: #15803d;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .rb-wechat-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 18px 0;
      font-size: 15px;
    }
    .rb-wechat-body table td,
    .rb-wechat-body table th {
      border: 1px solid #d1d5db;
      padding: 10px 12px;
      vertical-align: top;
    }
    .rb-wechat-body pre {
      white-space: pre-wrap;
      background: #111827;
      color: #f9fafb;
      padding: 14px 16px;
      border-radius: 12px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <div class="rb-wechat-shell">
    <article class="rb-wechat-article">
      <h1 class="rb-wechat-title">${escapeHtml(title)}</h1>
      ${subtitle ? `<div class="rb-wechat-meta">${escapeHtml(subtitle)}</div>` : ''}
      <div class="rb-wechat-body">${bodyHtml}</div>
    </article>
  </div>
</body>
</html>`;

    return { html, imageMap };
  }

  const root = pickBestRoot();
  const title = pickContent([
    document.querySelector('#activity-name')?.textContent,
    getMeta('meta[property="og:title"]'),
    getMeta('meta[name="twitter:title"]'),
    document.querySelector('h1')?.innerText,
    document.title,
  ]) || 'Untitled Page';
  const content = collectParagraphText(root);
  const metaDescription = pickContent([
    getMeta('meta[property="og:description"]'),
    getMeta('meta[name="description"]'),
    getMeta('meta[name="twitter:description"]'),
  ]);
  const byline = pickContent([
    document.querySelector('#js_name')?.textContent,
    document.querySelector('#js_author_name')?.textContent,
    getMeta('meta[name="author"]'),
    document.querySelector('[rel="author"]')?.textContent,
    document.querySelector('.author, .byline, [class*="author"], [class*="byline"]')?.textContent,
  ]);
  const siteName = pickContent([
    document.querySelector('#js_profile_qrcode strong')?.textContent,
    getMeta('meta[property="og:site_name"]'),
    location.hostname.replace(/^www\./i, ''),
  ]);
  const richWechatSnapshot = buildWechatRichHtmlDocument(root);
  const images = richWechatSnapshot.imageMap.length > 0
    ? richWechatSnapshot.imageMap.map((item) => item.url).slice(0, 8)
    : collectImageUrls(root);
  const excerpt = metaDescription || content.slice(0, 180);
  const looksLikeArticle = content.length >= 280 || root.matches?.('article, main, [role="main"]');
  const isWechatArticle = location.hostname === 'mp.weixin.qq.com';

  return {
    looksLikeArticle: Boolean(looksLikeArticle),
    title,
    text: content || [title, metaDescription, location.href].filter(Boolean).join('\n\n'),
    excerpt,
    url: location.href,
    author: byline || '',
    siteName,
    coverUrl: images[0] || '',
    images,
    captureKind: isWechatArticle ? 'wechat-article' : 'link-article',
    tags: isWechatArticle ? ['公众号文章'] : [],
    richHtmlDocument: isWechatArticle ? richWechatSnapshot.html : '',
    richHtmlImageMap: isWechatArticle ? richWechatSnapshot.imageMap : [],
  };
}

async function extractCurrentPageLinkPayload() {
  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function collectLinkArticleDataLocal() {
    async function blobToDataUrl(blob) {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data url'));
        reader.readAsDataURL(blob);
      });
    }

    async function fetchBinaryAsDataUrl(url) {
      const target = toAbsoluteUrl(url);
      if (!/^https?:\/\//i.test(target)) return '';
      try {
        const response = await fetch(target, {
          credentials: 'omit',
          cache: 'force-cache',
        });
        if (!response.ok) return '';
        const blob = await response.blob();
        if (!blob || !blob.size) return '';
        return await blobToDataUrl(blob);
      } catch {
        return '';
      }
    }

    function cleanText(value) {
      return String(value || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    }

    function pickContent(values) {
      for (const value of values) {
        const text = cleanText(value);
        if (text) return text;
      }
      return '';
    }

    function getMeta(selector, attr = 'content') {
      return document.querySelector(selector)?.getAttribute(attr) || '';
    }

    function toAbsoluteUrl(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        return new URL(raw, location.href).toString();
      } catch {
        return raw;
      }
    }

    function scoreRoot(root) {
      if (!root) return 0;
      const text = cleanText(root.innerText || '');
      const textLength = text.length;
      const paragraphCount = root.querySelectorAll('p').length;
      const headingCount = root.querySelectorAll('h1,h2,h3').length;
      const articleBoost = root.matches?.('article, main, [role="main"]') ? 2000 : 0;
      return textLength + (paragraphCount * 120) + (headingCount * 50) + articleBoost;
    }

    function pickBestRoot() {
      if (location.hostname === 'mp.weixin.qq.com') {
        return document.querySelector('#js_content') || document.body;
      }

      const selectors = [
        '#js_content',
        '.rich_media_content',
        'article',
        'main',
        '[role="main"]',
        '.article',
        '.article-container',
        '.post-content',
        '.entry-content',
        '.markdown-body',
        '.rich-text',
        '.content',
        '.post',
        '.note-content',
      ];

      const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      if (!candidates.length) return document.body;
      return candidates
        .map((node) => ({ node, score: scoreRoot(node) }))
        .sort((a, b) => b.score - a.score)[0]?.node || document.body;
    }

    function collectParagraphText(root) {
      const selectors = 'h1,h2,h3,p,li,blockquote,pre';
      const nodes = Array.from(root.querySelectorAll(selectors));
      const parts = [];
      const seen = new Set();

      for (const node of nodes) {
        if (node.closest('nav, header, footer, aside, form, dialog, noscript')) continue;
        const text = cleanText(node.innerText || '');
        if (!text || text.length < 18) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        parts.push(text);
        if (parts.join('\n\n').length > 24000) break;
      }

      if (parts.length > 0) return parts.join('\n\n');
      return cleanText(root.innerText || '').slice(0, 24000);
    }

    function collectImageUrls(root) {
      const urls = [];
      const push = (value) => {
        const url = toAbsoluteUrl(value);
        if (!/^https?:\/\//i.test(url)) return;
        if (!urls.includes(url)) urls.push(url);
      };

      push(getMeta('meta[property="og:image"]'));
      push(getMeta('meta[name="twitter:image"]'));

      const images = Array.from(root.querySelectorAll('img[src], img[data-src], img[data-original]'));
      for (const img of images) {
        push(img.getAttribute('src'));
        push(img.getAttribute('data-src'));
        push(img.getAttribute('data-original'));
        if (urls.length >= 8) break;
      }

      return urls.slice(0, 8);
    }

    function buildWechatRichHtmlDocument(root) {
      if (location.hostname !== 'mp.weixin.qq.com' || !root) {
        return { html: '', imageMap: [] };
      }

      const clone = root.cloneNode(true);
      const imageMap = [];
      let imageIndex = 0;

      clone.querySelectorAll('script, style, noscript, iframe, form, input, button, textarea, canvas, audio, video').forEach((node) => node.remove());

      const allNodes = [clone, ...clone.querySelectorAll('*')];
      for (const node of allNodes) {
        if (!(node instanceof Element)) continue;

        for (const attr of Array.from(node.attributes)) {
          const name = String(attr.name || '').toLowerCase();
          const value = String(attr.value || '');
          if (name.startsWith('on')) {
            node.removeAttribute(attr.name);
            continue;
          }
          if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
            node.removeAttribute(attr.name);
          }
        }

        if (node.tagName === 'IMG') {
          const resolvedSrc = toAbsoluteUrl(
            node.getAttribute('data-src')
            || node.getAttribute('data-original')
            || node.getAttribute('src')
            || ''
          );
          if (!/^https?:\/\//i.test(resolvedSrc)) {
            node.remove();
            continue;
          }
          const token = `__REDBOX_WECHAT_IMAGE_${imageIndex++}__`;
          imageMap.push({ token, url: resolvedSrc });
          node.setAttribute('src', token);
          node.removeAttribute('data-src');
          node.removeAttribute('data-original');
          node.removeAttribute('srcset');
          node.setAttribute('loading', 'lazy');
          continue;
        }

        if (node.tagName === 'A') {
          const href = toAbsoluteUrl(node.getAttribute('href') || '');
          if (href) {
            node.setAttribute('href', href);
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          } else {
            node.removeAttribute('href');
          }
        }
      }

      const title = cleanText(document.querySelector('#activity-name')?.textContent || document.title || '公众号文章');
      const author = cleanText(
        document.querySelector('#js_name')?.textContent
        || document.querySelector('#js_author_name')?.textContent
        || ''
      );
      const publishTime = cleanText(document.querySelector('#publish_time')?.textContent || '');
      const accountName = cleanText(
        document.querySelector('#js_profile_qrcode strong')?.textContent
        || document.querySelector('#js_profile_qrcode span')?.textContent
        || ''
      );

      const bodyHtml = clone.innerHTML.trim();
      if (!bodyHtml) return { html: '', imageMap: [] };

      const subtitleParts = [author, publishTime, accountName].filter(Boolean);
      const subtitle = subtitleParts.join(' · ');
      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f3; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif; line-height: 1.85; }
    .rb-wechat-shell { max-width: 820px; margin: 0 auto; padding: 28px 20px 60px; }
    .rb-wechat-article { background: #ffffff; border-radius: 18px; padding: 32px 28px 40px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08); border: 1px solid rgba(15, 23, 42, 0.06); }
    .rb-wechat-title { margin: 0; font-size: 30px; line-height: 1.3; font-weight: 700; color: #111827; }
    .rb-wechat-meta { margin-top: 12px; font-size: 13px; color: #6b7280; }
    .rb-wechat-body { margin-top: 26px; font-size: 17px; color: #1f2937; word-break: break-word; }
    .rb-wechat-body img { display: block; max-width: 100%; height: auto; margin: 18px auto; border-radius: 14px; }
    .rb-wechat-body p, .rb-wechat-body section, .rb-wechat-body div, .rb-wechat-body blockquote, .rb-wechat-body ul, .rb-wechat-body ol, .rb-wechat-body pre { margin-top: 0; margin-bottom: 1em; }
    .rb-wechat-body h1, .rb-wechat-body h2, .rb-wechat-body h3, .rb-wechat-body h4 { margin: 1.5em 0 0.8em; line-height: 1.35; color: #111827; }
    .rb-wechat-body blockquote { border-left: 4px solid #22c55e; background: #f0fdf4; padding: 12px 16px; border-radius: 10px; color: #166534; }
    .rb-wechat-body a { color: #15803d; text-decoration: underline; text-underline-offset: 2px; }
    .rb-wechat-body table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 15px; }
    .rb-wechat-body table td, .rb-wechat-body table th { border: 1px solid #d1d5db; padding: 10px 12px; vertical-align: top; }
    .rb-wechat-body pre { white-space: pre-wrap; background: #111827; color: #f9fafb; padding: 14px 16px; border-radius: 12px; overflow: auto; }
  </style>
</head>
<body>
  <div class="rb-wechat-shell">
    <article class="rb-wechat-article">
      <h1 class="rb-wechat-title">${escapeHtml(title)}</h1>
      ${subtitle ? `<div class="rb-wechat-meta">${escapeHtml(subtitle)}</div>` : ''}
      <div class="rb-wechat-body">${bodyHtml}</div>
    </article>
  </div>
</body>
</html>`;

      return { html, imageMap };
    }

    const root = pickBestRoot();
    const title = pickContent([
      document.querySelector('#activity-name')?.textContent,
      getMeta('meta[property="og:title"]'),
      getMeta('meta[name="twitter:title"]'),
      document.querySelector('h1')?.innerText,
      document.title,
    ]) || 'Untitled Page';
    const content = collectParagraphText(root);
    const metaDescription = pickContent([
      getMeta('meta[property="og:description"]'),
      getMeta('meta[name="description"]'),
      getMeta('meta[name="twitter:description"]'),
    ]);
    const byline = pickContent([
      document.querySelector('#js_name')?.textContent,
      document.querySelector('#js_author_name')?.textContent,
      getMeta('meta[name="author"]'),
      document.querySelector('[rel="author"]')?.textContent,
      document.querySelector('.author, .byline, [class*="author"], [class*="byline"]')?.textContent,
    ]);
    const siteName = pickContent([
      document.querySelector('#js_profile_qrcode strong')?.textContent,
      getMeta('meta[property="og:site_name"]'),
      location.hostname.replace(/^www\./i, ''),
    ]);
    const richWechatSnapshot = buildWechatRichHtmlDocument(root);
    const localizedWechatImageMap = [];
    if (richWechatSnapshot.imageMap.length > 0) {
      for (const entry of richWechatSnapshot.imageMap.slice(0, 80)) {
        const dataUrl = await fetchBinaryAsDataUrl(entry.url);
        localizedWechatImageMap.push({
          token: entry.token,
          url: dataUrl || entry.url,
        });
      }
    }

    const images = localizedWechatImageMap.length > 0
      ? localizedWechatImageMap.map((item) => item.url).filter(Boolean).slice(0, 8)
      : collectImageUrls(root);
    const excerpt = metaDescription || content.slice(0, 180);
    const looksLikeArticle = content.length >= 280 || root.matches?.('article, main, [role="main"]');
    const isWechatArticle = location.hostname === 'mp.weixin.qq.com';

    return {
      looksLikeArticle: Boolean(looksLikeArticle),
      title,
      text: content || [title, metaDescription, location.href].filter(Boolean).join('\n\n'),
      excerpt,
      url: location.href,
      author: byline || '',
      siteName,
      coverUrl: images[0] || '',
      images,
      captureKind: isWechatArticle ? 'wechat-article' : 'link-article',
      tags: isWechatArticle ? ['公众号文章'] : [],
      richHtmlDocument: isWechatArticle ? richWechatSnapshot.html : '',
      richHtmlImageMap: isWechatArticle ? localizedWechatImageMap : [],
    };
  }

  const article = await collectLinkArticleDataLocal();
  return {
    type: article.looksLikeArticle ? 'link-article' : 'text',
    captureKind: article.captureKind || '',
    title: article.title,
    url: article.url,
    text: article.text,
    htmlSnapshot: article.looksLikeArticle ? document.documentElement.outerHTML : '',
    excerpt: article.excerpt,
    author: article.author,
    siteName: article.siteName,
    coverUrl: article.coverUrl,
    images: article.images,
    tags: article.tags,
    richHtmlDocument: article.richHtmlDocument || '',
    richHtmlImageMap: Array.isArray(article.richHtmlImageMap) ? article.richHtmlImageMap : [],
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

async function extractXhsNotePayload() {
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

  function getActiveNoteDetailMask() {
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
        const titleText = (titleEl?.textContent || '').trim();
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

  function getCurrentOpenedNoteId() {
    const mask = getActiveNoteDetailMask();
    if (!mask) return '';
    return String(mask.getAttribute('note-id') || '').trim();
  }

  function normalizeTitle(value) {
    return String(value || '').replace(/\s+/g, '').trim();
  }

  function isCommentRelatedNode(el) {
    if (!el || !el.closest) return false;
    return Boolean(
      el.closest('.comments-el') ||
      el.closest('.comment-list') ||
      el.closest('.comment-item') ||
      el.closest('.comment-container') ||
      el.closest('.comments-container') ||
      el.closest('[class*="comment"]') ||
      el.closest('[id*="comment"]')
    );
  }

  function getCurrentNoteRoot() {
    const directRoot =
      document.querySelector('#noteContainer.note-container[data-render-status]') ||
      document.querySelector('#noteContainer.note-container') ||
      document.querySelector('#noteContainer');
    if (directRoot) return directRoot;

    const mask = getActiveNoteDetailMask();
    if (mask) {
      const scoped =
        mask.querySelector('#noteContainer.note-container') ||
        mask.querySelector('#noteContainer') ||
        mask.querySelector('.note-container') ||
        null;
      if (scoped) return scoped;
    }

    const anchor =
      document.querySelector('#detail-desc') ||
      document.querySelector('#detail-title') ||
      document.querySelector('.note-content') ||
      null;
    if (!anchor) return document.body;
    return (
      anchor.closest('#noteContainer.note-container') ||
      anchor.closest('#noteContainer') ||
      anchor.closest('.note-container') ||
      anchor.closest('#detail-container') ||
      anchor.closest('.note-content') ||
      anchor.closest('[class*="note-container"]') ||
      anchor.closest('[class*="note-content"]') ||
      anchor.parentElement ||
      document.body
    );
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

  function isLivePhotoNote(root) {
    if (!root) return false;
    return Boolean(root.querySelector('img.live-img, .live-img.live-img-visible, [class*="live-img"]'));
  }

  function getCurrentStateNoteEntry() {
    try {
      const detailMap = getInitialState()?.note?.noteDetailMap || {};
      const keys = Object.keys(detailMap);
      if (keys.length === 0) return null;

      const candidates = [];
      const openedNoteId = getCurrentOpenedNoteId();
      if (openedNoteId) candidates.push(openedNoteId);
      const pathPart = location.pathname.split('/').filter(Boolean).pop() || '';
      if (pathPart) candidates.push(pathPart);
      try {
        const search = new URLSearchParams(location.search);
        ['noteId', 'note_id', 'id', 'itemId'].forEach((name) => {
          const value = search.get(name);
          if (value) candidates.push(value);
        });
      } catch {}

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

      const domTitle = normalizeTitle(getNoteTitle(getCurrentNoteRoot()));
      if (domTitle) {
        const titleMatchedKey = keys.find((key) => {
          const entry = detailMap[key];
          const note = entry?.note || entry;
          const entryTitle = normalizeTitle(note?.title || note?.noteTitle || '');
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

  function getCurrentStateNote() {
    const entry = getCurrentStateNoteEntry();
    return entry?.note || entry || null;
  }

  function isStateAlignedWithDomTitle(note) {
    if (!note) return false;
    const openedNoteId = getCurrentOpenedNoteId();
    const stateIds = [note?.noteId, note?.id, note?.note_id]
      .filter(Boolean)
      .map((id) => String(id).trim());
    if (openedNoteId && stateIds.length > 0) {
      return stateIds.some((id) => id === openedNoteId || id.includes(openedNoteId) || openedNoteId.includes(id));
    }
    const domTitle = normalizeTitle(getNoteTitle(getCurrentNoteRoot()));
    const stateTitle = normalizeTitle(note?.title || note?.noteTitle || '');
    if (domTitle && stateTitle) {
      return domTitle === stateTitle || domTitle.includes(stateTitle) || stateTitle.includes(domTitle);
    }
    if (domTitle && !stateTitle) return false;
    return true;
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

  function getCurrentNoteImgEls(root) {
    let els = root
      ? Array.from(root.querySelectorAll('.img-container img, .note-content .img-container img, .swiper-slide img'))
      : [];
    if (els.length === 0) {
      els = Array.from(document.querySelectorAll('.note-content .img-container img, .img-container img, .swiper-slide img'));
    }
    return els.filter((img) => {
      if (isCommentRelatedNode(img)) return false;
      if (img.closest('.avatar,[class*="avatar"]')) return false;
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      return /^https?:\/\//i.test(src);
    });
  }

  function getImageUrls(root, stateNote) {
    const urls = [];
    if (stateNote && isStateAlignedWithDomTitle(stateNote)) {
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
    }

    if (urls.length > 0) return urls;

    const imgEls = getCurrentNoteImgEls(root);
    imgEls.forEach((img) => {
      pushUniqueUrl(urls, img.getAttribute('src') || img.getAttribute('data-src') || '');
    });
    return urls;
  }

  function getCurrentMainVideoElement(root) {
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll('video, video[mediatype="video"], .xgplayer video'));
    const visible = candidates.find((el) => !isCommentRelatedNode(el) && isNodeVisible(el));
    if (visible) return visible;
    const tagged = candidates.find((el) => {
      if (isCommentRelatedNode(el)) return false;
      if (el.getAttribute('mediatype') === 'video') return true;
      const src = (el.getAttribute('src') || '').trim();
      if (src.startsWith('blob:')) return true;
      if (/^https?:\/\//i.test(src)) return true;
      return Boolean(el.querySelector('source[src^="blob:"], source[src^="http"]'));
    });
    return tagged || null;
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

  function scoreVideoCandidate(url) {
    const normalized = String(url || '').toLowerCase();
    let score = 0;
    if (/\.mp4(\?|$)/.test(normalized)) score += 120;
    if (/\.m3u8(\?|$)/.test(normalized)) score += 80;
    if (/master/.test(normalized)) score += 25;
    if (/stream|video|media/.test(normalized)) score += 15;
    if (/sns-video|xiaohongshu|xhscdn|alicdn|byteimg/.test(normalized)) score += 10;
    return score;
  }

  function getPerformanceMediaUrls() {
    try {
      return performance.getEntriesByType('resource')
        .map((entry) => String(entry?.name || '').trim())
        .filter((url) => /^https?:\/\//i.test(url))
        .filter((url) => /(\.mp4|\.m3u8|video|stream|master)/i.test(url))
        .slice(-20);
    } catch {
      return [];
    }
  }

  function getCurrentNoteVideoUrls(root, stateNote) {
    const candidates = [];
    const h264 = stateNote?.video?.media?.stream?.h264 || [];
    const h265 = stateNote?.video?.media?.stream?.h265 || [];
    [...h264, ...h265].forEach((item) => {
      pushUniqueUrl(candidates, item?.masterUrl);
    });
    pushUniqueUrl(candidates, stateNote?.video?.media?.masterUrl);
    pushUniqueUrl(candidates, stateNote?.video?.media?.url);
    pushUniqueUrl(candidates, stateNote?.video?.url);
    collectDeepHttpUrls(stateNote?.video || stateNote, 80).forEach((url) => pushUniqueUrl(candidates, url));
    if (getCurrentMainVideoElement(root)) {
      getPerformanceMediaUrls().forEach((url) => pushUniqueUrl(candidates, url));
    }

    const videoEls = Array.from(root.querySelectorAll('video'));
    videoEls.forEach((videoEl) => {
      if (isCommentRelatedNode(videoEl)) return;
      pushUniqueUrl(candidates, videoEl?.src || '');
      const sourceEls = Array.from(videoEl.querySelectorAll('source'));
      sourceEls.forEach((source) => pushUniqueUrl(candidates, source?.src || ''));
    });

    return candidates.sort((a, b) => scoreVideoCandidate(b) - scoreVideoCandidate(a));
  }

  function captureVideoCoverDataUrl(root) {
    try {
      const videoEl = root.querySelector('video');
      if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return '';
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.92);
    } catch {
      return '';
    }
  }

  function getCoverUrl(root, images, videoUrl) {
    const poster = root.querySelector('video')?.getAttribute('poster');
    if (poster) return poster;
    if (images[0]) return images[0];
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

  async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data url'));
      reader.readAsDataURL(blob);
    });
  }

  async function fetchBinaryAsDataUrl(url) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return '';
    try {
      const response = await fetch(target, {
        credentials: 'omit',
        cache: 'force-cache',
      });
      if (!response.ok) return '';
      const blob = await response.blob();
      if (!blob || !blob.size) return '';
      return await blobToDataUrl(blob);
    } catch {
      return '';
    }
  }

  const root = getCurrentNoteRoot();
  const stateNote = getCurrentStateNote();
  const title = String(getNoteTitle(root) || '').trim();
  const content = String(getTextContent(root) || '').trim();
  const images = getImageUrls(root, stateNote).slice(0, 9);
  const videoCandidates = getCurrentNoteVideoUrls(root, stateNote);
  const strictVideoNote = !isLivePhotoNote(root) && images.length === 0 && videoCandidates.length === 1;
  const videoUrl = strictVideoNote ? videoCandidates[0] : null;
  const coverUrl = getCoverUrl(root, images, videoUrl);
  const capturedVideoCover = (!coverUrl && videoUrl) ? captureVideoCoverDataUrl(root) : '';

  const localizedImages = [];
  for (const imageUrl of images) {
    const dataUrl = await fetchBinaryAsDataUrl(imageUrl);
    localizedImages.push(dataUrl || imageUrl);
  }

  const localizedCoverUrl = coverUrl
    ? (await fetchBinaryAsDataUrl(coverUrl)) || coverUrl
    : (capturedVideoCover || '');
  const localizedVideoDataUrl = videoUrl && String(videoUrl).startsWith('blob:')
    ? (await fetchBinaryAsDataUrl(videoUrl))
    : '';
  const stableStateNoteId = String(
    stateNote?.noteId
    || stateNote?.id
    || stateNote?.note_id
    || getCurrentOpenedNoteId()
    || '',
  ).trim();
  const stablePathNoteId = String(location.pathname || '')
    .split('/')
    .filter(Boolean)
    .pop()
    || '';
  const stableNoteId = stableStateNoteId || stablePathNoteId || `xhs-${Date.now()}`;

  return {
    noteId: stableNoteId,
    title,
    author: getAuthor(root),
    content,
    text: content,
    images: localizedImages,
    coverUrl: localizedCoverUrl || coverUrl,
    videoUrl,
    videoDataUrl: localizedVideoDataUrl || '',
    stats: getStats(),
    source: location.href,
  };
}

function detectCaptureTarget() {
  function createLocalLinkFallbackPageInfo(overrides = {}) {
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

  const hostname = String(location.hostname || '').toLowerCase();

  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') {
    const url = new URL(location.href);
    const isVideoPage = url.pathname.startsWith('/watch') || url.pathname.startsWith('/shorts/') || hostname === 'youtu.be';
    if (isVideoPage) {
      return {
        kind: 'youtube',
        action: 'save-youtube',
        label: '保存YouTube视频到知识库',
        description: '当前页面已识别为 YouTube 视频页。',
        detected: true,
      };
    }

    return createLocalLinkFallbackPageInfo({
      kind: 'youtube-generic',
      description: '当前页面还没有稳定识别到有效的视频内容。',
    });
  }

  if (/(^|\.)xiaohongshu\.com$/i.test(hostname)) {
    function isCommentRelatedNode(el) {
      if (!el || !el.closest) return false;
      return Boolean(
        el.closest('.comments-el') ||
        el.closest('.comment-list') ||
        el.closest('.comment-item') ||
        el.closest('.comment-container') ||
        el.closest('.comments-container') ||
        el.closest('[class*="comment"]') ||
        el.closest('[id*="comment"]')
      );
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

    function isLivePhotoNote(root) {
      if (!root) return false;
      return Boolean(root.querySelector('img.live-img, .live-img.live-img-visible, [class*="live-img"]'));
    }

    function getCurrentMainVideoElement(root) {
      if (!root) return null;
      const candidates = Array.from(root.querySelectorAll('video, video[mediatype="video"], .xgplayer video'));
      const visible = candidates.find((el) => !isCommentRelatedNode(el) && isNodeVisible(el));
      if (visible) return visible;
      return candidates.find((el) => {
        if (isCommentRelatedNode(el)) return false;
        const src = (el.getAttribute('src') || '').trim();
        return el.getAttribute('mediatype') === 'video' || src.startsWith('blob:') || /^https?:\/\//i.test(src) || Boolean(el.querySelector('source[src^="blob:"], source[src^="http"]'));
      }) || null;
    }

    function pushUniqueUrl(list, value) {
      if (!value || typeof value !== 'string') return;
      const url = value.trim();
      if (!url || !/^https?:\/\//i.test(url)) return;
      if (!list.includes(url)) list.push(url);
    }

    function getImageUrlsFromState(note) {
      const urls = [];
      const imageList = Array.isArray(note?.imageList)
        ? note.imageList
        : Array.isArray(note?.images)
          ? note.images
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
      return urls;
    }

    function getCurrentNoteImageUrls(root, note) {
      const urls = getImageUrlsFromState(note);
      if (urls.length > 0) return urls;
      const imgEls = Array.from(root?.querySelectorAll('.img-container img, .note-content .img-container img, .swiper-slide img') || []);
      imgEls.forEach((img) => {
        if (isCommentRelatedNode(img)) return;
        pushUniqueUrl(urls, img.getAttribute('src') || img.getAttribute('data-src') || '');
      });
      return urls;
    }

    function getCurrentNoteVideoUrls(root, note) {
      const urls = [];
      const h264 = note?.video?.media?.stream?.h264 || [];
      const h265 = note?.video?.media?.stream?.h265 || [];
      [...h264, ...h265].forEach((item) => {
        pushUniqueUrl(urls, item?.masterUrl);
        if (Array.isArray(item?.backupUrls)) {
          item.backupUrls.forEach((backup) => pushUniqueUrl(urls, backup));
        }
      });
      pushUniqueUrl(urls, note?.video?.media?.masterUrl);
      pushUniqueUrl(urls, note?.video?.media?.url);
      pushUniqueUrl(urls, note?.video?.url);
      if (getCurrentMainVideoElement(root)) {
        try {
          const entries = performance.getEntriesByType('resource') || [];
          entries.forEach((entry) => {
            const name = entry && typeof entry.name === 'string' ? entry.name : '';
            if (!name) return;
            if (/(\.mp4|\.m3u8|\/hls\/|\/video\/|sns-video|xhscdn)/i.test(name)) {
              pushUniqueUrl(urls, name);
            }
          });
        } catch {}
      }
      const videoEls = Array.from(root?.querySelectorAll('video') || []);
      videoEls.forEach((videoEl) => {
        if (isCommentRelatedNode(videoEl)) return;
        pushUniqueUrl(urls, videoEl?.src || '');
        const sourceEls = Array.from(videoEl.querySelectorAll('source'));
        sourceEls.forEach((source) => pushUniqueUrl(urls, source?.src || ''));
      });
      return urls;
    }

    const noteRoot = document.querySelector('#noteContainer, .note-container, .note-content');
    const stateNote = getCurrentStateNote();
    const imageUrls = getCurrentNoteImageUrls(noteRoot, stateNote);
    const videoUrls = getCurrentNoteVideoUrls(noteRoot, stateNote);
    const isVideoNote = Boolean(noteRoot || stateNote) && !isLivePhotoNote(noteRoot) && imageUrls.length === 0 && videoUrls.length === 1;

    if (noteRoot || stateNote) {
      return {
        kind: isVideoNote ? 'xhs-video' : 'xhs-image',
        action: 'save-xhs',
        label: isVideoNote ? '保存小红书视频笔记到知识库' : '保存小红书图文到知识库',
        description: isVideoNote ? '当前页面已识别为小红书视频笔记。' : '当前页面已识别为小红书图文笔记。',
        detected: true,
      };
    }

    const articleRoot = document.querySelector('[class*="article"], .article-container, .content-container');
    if (articleRoot) {
      return {
        kind: 'xhs-article',
        action: 'save-xhs',
        label: '保存小红书图文到知识库',
        description: '当前页面已识别为小红书图文内容页。',
        detected: true,
      };
    }

    return createLocalLinkFallbackPageInfo({
      kind: 'xhs-pending',
      description: '当前页面还没有稳定识别到有效的小红书笔记内容。',
    });
  }

  if (hostname === 'mp.weixin.qq.com') {
    return {
      kind: 'wechat-article',
      action: 'save-page-link',
      label: '保存公众号文章到知识库',
      description: '当前页面已识别为公众号文章，将完整保存正文、图片和排版。',
      detected: true,
    };
  }

  const articleRoot = document.querySelector('#js_content, .rich_media_content, article, main, [role="main"], .article, .article-container, .post-content, .entry-content, .markdown-body, .content, .post, .note-content');
  const articleText = String(articleRoot?.innerText || '').replace(/\s+/g, ' ').trim();
  if (articleRoot && articleText.length >= 280) {
    return {
      kind: 'link-article',
      action: 'save-page-link',
      label: '保存链接文章到知识库',
      description: '将提取正文、来源和封面保存到知识库。',
      detected: true,
    };
  }

  return createLocalLinkFallbackPageInfo();
}
