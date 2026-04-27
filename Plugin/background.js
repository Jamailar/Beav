const KNOWLEDGE_API_CANDIDATES = [
  {
    baseUrl: 'http://127.0.0.1:31937',
    endpointPath: '/api/knowledge',
  },
  {
    baseUrl: 'http://localhost:31937',
    endpointPath: '/api/knowledge',
  },
  {
    baseUrl: 'http://127.0.0.1:23456',
    endpointPath: '/api/knowledge',
  },
  {
    baseUrl: 'http://localhost:23456',
    endpointPath: '/api/knowledge',
  },
];
const pageStateCache = new Map();
const PAGE_STATE_NEGATIVE_TTL_MS = 350;
const KNOWLEDGE_API_CACHE_TTL_MS = 30_000;
const INLINE_ASSET_MAX_BYTES = 6 * 1024 * 1024;
const UPDATE_STATE_KEY = 'pluginUpdateState';
const UPDATE_ALARM_NAME = 'redbox-plugin-auto-update-check';
const UPDATE_CHECK_INTERVAL_MINUTES = 360;
const UPDATE_SOURCE_MANIFEST_URL = 'https://raw.githubusercontent.com/Jamailar/RedBox/main/Plugin/manifest.json';
const UPDATE_SOURCE_REPO_URL = 'https://github.com/Jamailar/RedBox/tree/main/Plugin';
const REDBOX_PLUGIN_SETTINGS_KEY = 'redboxPluginSettings';
const XHS_TASK_HISTORY_KEY = 'xhsCollectorTaskHistory';
const XHS_TASK_QUEUE_STATE_KEY = 'xhsCollectorTaskQueueState';
const XHS_TASK_LOG_KEY = 'xhsCollectorTaskLogs';
const XHS_TASK_HISTORY_LIMIT = 80;
const XHS_TASK_LOG_LIMIT = 80;
const XHS_COLLECT_INTERVAL_DEFAULT_MIN_MS = 1500;
const XHS_COLLECT_INTERVAL_DEFAULT_MAX_MS = 3500;
const XHS_COLLECT_INTERVAL_MIN_MS = 500;
const XHS_COLLECT_INTERVAL_MAX_MS = 60_000;
const MENU_ROOT_ID = 'redbox-root';
const MENU_PAGE_ID = 'redbox-save-page-auto';
const MENU_SELECTION_ID = 'redbox-save-selection';
const MENU_LINK_ID = 'redbox-save-link';
const MENU_IMAGE_ID = 'redbox-save-image';
const MENU_VIDEO_ID = 'redbox-save-video';
const DEFAULT_PLUGIN_SETTINGS = {
  knowledgeApiBaseUrl: 'http://127.0.0.1:31937',
  knowledgeApiEndpointPath: '/api/knowledge',
  xhsIntervalMinSeconds: 1.5,
  xhsIntervalMaxSeconds: 3.5,
  xhsBloggerNoteLimit: 50,
  xhsKeywordNoteLimit: 20,
  xhsLinkBatchLimit: 50,
  saveToRedboxByDefault: true,
  autoUpdateCheck: true,
};

let cachedKnowledgeApi = null;
let cachedKnowledgeApiAt = 0;
let xhsTaskSequence = 0;
let xhsActiveTask = null;
let xhsLastTask = null;
const xhsTaskQueue = [];
let xhsTaskLogs = [];

void hydrateXhsTaskLogs();

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    pluginWarn('side-panel-behavior-failed', {
      error: describeError(error),
    });
  });
}

function clearCachedKnowledgeApi() {
  cachedKnowledgeApi = null;
  cachedKnowledgeApiAt = 0;
}

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
  void initializeUpdateChecks(true);
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenus();
  void initializeUpdateChecks(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== UPDATE_ALARM_NAME) return;
  void (async () => {
    const settings = await readPluginSettings();
    if (!settings.autoUpdateCheck) return;
    await checkForPluginUpdates({ force: true, reason: 'alarm' });
  })();
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
  const tabContext = await resolveMessageTab(message, sender);
  const tabId = tabContext.tabId;
  pluginLog('handle-message', {
    type: message?.type || 'unknown',
    tabId: tabId || null,
    senderTabUrl: String(sender?.tab?.url || ''),
    resolvedTabUrl: String(tabContext.tab?.url || ''),
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
    case 'plugin-update:get-status':
      return await getPluginUpdateStatus(message?.refresh === true);
    case 'plugin-update:check':
      return await checkForPluginUpdates({ force: true, reason: 'manual' });
    case 'plugin-update:open-source':
      await chrome.tabs.create({ url: UPDATE_SOURCE_REPO_URL });
      return { success: true };
    case 'sidepanel:open':
      return await openSidePanelForSender(sender);
    case 'sidepanel:get-context':
      return await getSidePanelContext(message?.tabId || tabId);
    case 'settings:get':
      return { success: true, settings: await readPluginSettings() };
    case 'settings:update':
      return {
        success: true,
        settings: await writePluginSettings({
          ...(await readPluginSettings()),
          ...(message?.settings || {}),
        }),
      };
    case 'settings:reset':
      return { success: true, settings: await writePluginSettings(DEFAULT_PLUGIN_SETTINGS) };
    case 'settings:test-connection':
      clearCachedKnowledgeApi();
      return await checkDesktopServer(true);
    case 'inspect-page':
      return await inspectPage(tabId);
    case 'save-xhs':
      return await enqueueXhsTask({
        type: message.type,
        title: createXhsTaskTitle(message.type, message, tabId),
        tabId,
        execute: () => saveXhsNoteFromTab(tabId),
      });
    case 'xhs:download-current-note':
      return await enqueueXhsTask({
        type: message.type,
        title: createXhsTaskTitle(message.type, message, tabId),
        tabId,
        execute: () => downloadXhsMediaFromTab(tabId),
      });
    case 'xhs:collect-current-comments':
      return await enqueueXhsTask({
        type: message.type,
        title: createXhsTaskTitle(message.type, message, tabId),
        tabId,
        execute: () => collectXhsCommentsFromTab(tabId),
      });
    case 'xhs:collect-current-blogger':
      return await enqueueXhsTask({
        type: message.type,
        title: createXhsTaskTitle(message.type, message, tabId),
        tabId,
        execute: () => collectXhsBloggerFromTab(tabId),
      });
    case 'xhs:collect-blogger-notes':
      return await enqueueXhsTask({
        type: message.type,
        title: createXhsTaskTitle(message.type, message, tabId),
        tabId,
        execute: () => collectXhsBloggerNotesFromTab(tabId, message?.options),
      });
    case 'xhs:collect-note-links':
      return await enqueueXhsTask({
        type: message.type,
        title: createXhsTaskTitle(message.type, message, tabId),
        tabId,
        execute: () => collectXhsNoteLinks(message?.urls, message?.options),
      });
    case 'xhs:collect-visible-note-links':
      return await enqueueXhsTask({
        type: message.type,
        title: createXhsTaskTitle(message.type, message, tabId),
        tabId,
        execute: () => collectVisibleXhsNoteLinksFromTab(tabId, message?.options),
      });
    case 'xhs:collect-keyword':
      return await enqueueXhsTask({
        type: message.type,
        title: createXhsTaskTitle(message.type, message, tabId),
        tabId,
        execute: () => collectXhsKeyword(message?.keyword, message?.options),
      });
    case 'xhs:get-task-queue':
      return { success: true, queue: getXhsTaskQueueState() };
    case 'xhs:get-history':
      return await getXhsTaskHistory();
    case 'xhs:clear-history':
      return await clearXhsTaskHistory();
    case 'xhs:export-current-note-json':
      return await exportCurrentXhsNoteJson(tabId);
    case 'save-douyin':
      return await saveDouyinVideoFromTab(tabId);
    case 'save-youtube':
      return await saveYouTubeFromTab(tabId);
    case 'save-bilibili':
    case 'save-kuaishou':
    case 'save-tiktok':
    case 'save-reddit':
    case 'save-x':
    case 'save-instagram':
      return await enqueueXhsTask({
        type: message.type,
        title: createXhsTaskTitle(message.type, message, tabId),
        tabId,
        execute: () => saveSocialPlatformFromTab(tabId, message.type.replace(/^save-/, '')),
      });
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

  if (/(^|\.)xiaohongshu\.com$/i.test(hostname) || /(^|\.)rednote\.com$/i.test(hostname)) {
    if (pathname.startsWith('/user/profile/')) {
      return {
        kind: 'xhs-profile',
        action: 'xhs:collect-current-blogger',
        label: '保存小红书博主资料到知识库',
        description: '当前页面已识别为小红书博主页。',
        detected: true,
      };
    }
    if (pathname.startsWith('/explore/') || pathname.startsWith('/discovery/item/')) {
      return {
        kind: 'xhs-note',
        action: 'save-xhs',
        label: '保存小红书笔记到知识库',
        description: '当前页面已识别为小红书笔记页。',
        detected: true,
      };
    }
    return createLinkFallbackPageInfo({
      kind: 'xhs-pending',
      description: '当前页面还没有稳定识别到有效的小红书笔记内容。',
    });
  }

  if (/(^|\.)douyin\.com$/i.test(hostname)) {
    if (pathname.startsWith('/video/') || pathname.startsWith('/note/')) {
      return {
        kind: 'douyin-video',
        platform: 'douyin',
        action: 'save-douyin',
        label: '保存抖音视频到知识库',
        description: '当前页面已识别为抖音视频页。',
        detected: true,
      };
    }
    return createLinkFallbackPageInfo({
      kind: 'douyin-pending',
      platform: 'douyin',
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
      detected: true,
    };
  }

  return createLinkFallbackPageInfo();
}

function getCurrentPluginVersion() {
  const manifest = chrome.runtime.getManifest();
  return normalizeText(manifest?.version) || '0.0.0';
}

function compareVersions(left, right) {
  const leftParts = String(left || '')
    .split('.')
    .map((item) => Number.parseInt(item, 10))
    .map((item) => (Number.isFinite(item) ? item : 0));
  const rightParts = String(right || '')
    .split('.')
    .map((item) => Number.parseInt(item, 10))
    .map((item) => (Number.isFinite(item) ? item : 0));
  const maxLength = Math.max(leftParts.length, rightParts.length, 1);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function createDefaultUpdateState() {
  const currentVersion = getCurrentPluginVersion();
  return {
    currentVersion,
    latestVersion: currentVersion,
    hasUpdate: false,
    lastCheckedAt: null,
    sourceUrl: UPDATE_SOURCE_REPO_URL,
    lastError: '',
    checkStatus: 'idle',
  };
}

function sanitizeUpdateState(input) {
  const fallback = createDefaultUpdateState();
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const currentVersion = normalizeText(input.currentVersion) || fallback.currentVersion;
  const latestVersion = normalizeText(input.latestVersion) || currentVersion;
  return {
    currentVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    lastCheckedAt: normalizeText(input.lastCheckedAt) || null,
    sourceUrl: normalizeText(input.sourceUrl) || UPDATE_SOURCE_REPO_URL,
    lastError: normalizeText(input.lastError),
    checkStatus: normalizeText(input.checkStatus) || fallback.checkStatus,
  };
}

function getStorageLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function setStorageLocal(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

function normalizeSettingsBaseUrl(value) {
  const raw = normalizeText(value).replace(/\/+$/g, '');
  if (!raw) return DEFAULT_PLUGIN_SETTINGS.knowledgeApiBaseUrl;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) return DEFAULT_PLUGIN_SETTINGS.knowledgeApiBaseUrl;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return DEFAULT_PLUGIN_SETTINGS.knowledgeApiBaseUrl;
  }
}

function normalizeSettingsEndpointPath(value) {
  const raw = normalizeText(value) || DEFAULT_PLUGIN_SETTINGS.knowledgeApiEndpointPath;
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  return prefixed.replace(/\/+$/g, '') || DEFAULT_PLUGIN_SETTINGS.knowledgeApiEndpointPath;
}

function normalizePluginSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  let intervalMin = clampNumber(
    source.xhsIntervalMinSeconds,
    XHS_COLLECT_INTERVAL_MIN_MS / 1000,
    XHS_COLLECT_INTERVAL_MAX_MS / 1000,
    DEFAULT_PLUGIN_SETTINGS.xhsIntervalMinSeconds,
  );
  let intervalMax = clampNumber(
    source.xhsIntervalMaxSeconds,
    XHS_COLLECT_INTERVAL_MIN_MS / 1000,
    XHS_COLLECT_INTERVAL_MAX_MS / 1000,
    DEFAULT_PLUGIN_SETTINGS.xhsIntervalMaxSeconds,
  );
  if (intervalMax < intervalMin) {
    [intervalMin, intervalMax] = [intervalMax, intervalMin];
  }
  return {
    knowledgeApiBaseUrl: normalizeSettingsBaseUrl(source.knowledgeApiBaseUrl),
    knowledgeApiEndpointPath: normalizeSettingsEndpointPath(source.knowledgeApiEndpointPath),
    xhsIntervalMinSeconds: Math.round(intervalMin * 10) / 10,
    xhsIntervalMaxSeconds: Math.round(intervalMax * 10) / 10,
    xhsBloggerNoteLimit: Math.round(clampNumber(source.xhsBloggerNoteLimit, 1, 200, DEFAULT_PLUGIN_SETTINGS.xhsBloggerNoteLimit)),
    xhsKeywordNoteLimit: Math.round(clampNumber(source.xhsKeywordNoteLimit, 1, 50, DEFAULT_PLUGIN_SETTINGS.xhsKeywordNoteLimit)),
    xhsLinkBatchLimit: Math.round(clampNumber(source.xhsLinkBatchLimit, 1, 50, DEFAULT_PLUGIN_SETTINGS.xhsLinkBatchLimit)),
    saveToRedboxByDefault: source.saveToRedboxByDefault !== false,
    autoUpdateCheck: source.autoUpdateCheck !== false,
  };
}

async function readPluginSettings() {
  const result = await getStorageLocal([REDBOX_PLUGIN_SETTINGS_KEY]);
  return normalizePluginSettings({
    ...DEFAULT_PLUGIN_SETTINGS,
    ...(result?.[REDBOX_PLUGIN_SETTINGS_KEY] || {}),
  });
}

async function writePluginSettings(nextSettings) {
  const settings = normalizePluginSettings({
    ...DEFAULT_PLUGIN_SETTINGS,
    ...(nextSettings || {}),
  });
  await setStorageLocal({ [REDBOX_PLUGIN_SETTINGS_KEY]: settings });
  clearCachedKnowledgeApi();
  await configureUpdateAlarm(settings);
  return settings;
}

function knowledgeApiCandidatesFromSettings(settings) {
  const normalized = normalizePluginSettings(settings);
  const custom = {
    baseUrl: normalized.knowledgeApiBaseUrl,
    endpointPath: normalized.knowledgeApiEndpointPath,
  };
  const seen = new Set();
  return [custom, ...KNOWLEDGE_API_CANDIDATES].filter((candidate) => {
    const key = `${candidate.baseUrl}${candidate.endpointPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function configureUpdateAlarm(settingsInput) {
  const settings = settingsInput ? normalizePluginSettings(settingsInput) : await readPluginSettings();
  if (!settings.autoUpdateCheck) {
    await chrome.alarms.clear(UPDATE_ALARM_NAME).catch(() => {});
    return;
  }
  await chrome.alarms.create(UPDATE_ALARM_NAME, {
    periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES,
    delayInMinutes: 1,
  });
}

function intervalOptionsFromSettings(settings) {
  const normalized = normalizePluginSettings(settings);
  return {
    minSeconds: normalized.xhsIntervalMinSeconds,
    maxSeconds: normalized.xhsIntervalMaxSeconds,
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function resolveMessageTab(message, sender) {
  const requestedTabId = Number(message?.tabId || sender?.tab?.id || 0) || 0;
  const requestedUrl = normalizeText(message?.tabUrl || message?.url);
  const requestedWindowId = Number(message?.windowId || 0) || undefined;
  let tab = requestedTabId
    ? await chrome.tabs.get(requestedTabId).catch(() => null)
    : null;

  if (!tab && requestedUrl) {
    const queryOptions = requestedWindowId ? { windowId: requestedWindowId } : {};
    const candidateTabs = await chrome.tabs.query(queryOptions).catch(() => []);
    tab = candidateTabs.find((item) => normalizeText(item.url) === requestedUrl) || null;
  }

  if (!tab) {
    tab = await getActiveTab().catch(() => null);
  }

  return {
    tab,
    tabId: Number(tab?.id || requestedTabId || 0) || 0,
  };
}

async function openSidePanelForSender(sender) {
  const tab = sender?.tab || await getActiveTab();
  if (!tab?.id || !chrome.sidePanel?.open) {
    return { success: false, error: '当前浏览器不支持打开侧边栏' };
  }
  await chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId });
  return { success: true };
}

async function getSidePanelContext(tabIdInput) {
  const { tab } = await resolveMessageTab({ tabId: tabIdInput }, null);
  const health = await checkDesktopServer().catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  const inspection = tab?.id ? await inspectPage(tab.id).catch(() => null) : null;
  const pageIdentity = tab?.id
    ? await runExtraction(tab.id, extractSidePanelPageIdentity, { world: 'MAIN' }).catch(() => null)
    : null;
  return {
    success: true,
    tab: tab ? {
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || '',
      url: tab.url || '',
      hostname: extractDomainFromUrl(tab.url || ''),
    } : null,
    health,
    pageInfo: inspection?.pageInfo || createLinkFallbackPageInfo(),
    pageIdentity,
    logs: getXhsTaskLogsForState(),
    queue: getXhsTaskQueueState(),
  };
}

function extractSidePanelPageIdentity() {
  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cleanTitle(value) {
    return normalizeText(value)
      .replace(/\s*-\s*小红书.*$/i, '')
      .replace(/\s*-\s*YouTube\s*$/i, '')
      .replace(/\s*-\s*bilibili.*$/i, '')
      .replace(/\s*-\s*Bilibili.*$/i, '')
      .replace(/\s*_\s*哔哩哔哩.*$/i, '')
      .replace(/\s*_\s*公众号.*$/i, '')
      .replace(/\s*-\s*抖音.*$/i, '')
      .replace(/\s*-\s*快手.*$/i, '')
      .replace(/\s*-\s*TikTok.*$/i, '')
      .replace(/\s*\/\s*X\s*$/i, '')
      .replace(/\s*•\s*Instagram.*$/i, '')
      .replace(/\s*:\s*r\/.*$/i, '');
  }

  function text(selector) {
    const node = document.querySelector(selector);
    return normalizeText(node?.textContent || node?.getAttribute?.('content') || '');
  }

  function meta(name) {
    return normalizeText(
      document.querySelector(`meta[property="${name}"]`)?.content ||
      document.querySelector(`meta[name="${name}"]`)?.content ||
      ''
    );
  }

  function readInitialState() {
    const directState = window.__INITIAL_STATE__;
    if (directState && typeof directState === 'object') return directState;
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const raw = script.textContent || '';
      if (!raw.includes('window.__INITIAL_STATE__=')) continue;
      try {
        return JSON.parse(raw.replace('window.__INITIAL_STATE__=', '').replace(/undefined/g, 'null').replace(/;$/, ''));
      } catch {
        return null;
      }
    }
    return null;
  }

  function unwrapValue(value) {
    if (!value || typeof value !== 'object') return value;
    if (value._rawValue && typeof value._rawValue === 'object') return value._rawValue;
    if (value.value && typeof value.value === 'object') return value.value;
    return value;
  }

  function walkStrings(value, keys) {
    const queue = [unwrapValue(value)];
    const seen = new Set();
    while (queue.length > 0) {
      const item = unwrapValue(queue.shift());
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      for (const key of keys) {
        const candidate = normalizeText(item[key]);
        if (candidate) return candidate;
      }
      for (const child of Object.values(item)) {
        if (child && typeof child === 'object') queue.push(child);
      }
    }
    return '';
  }

  const hostname = location.hostname.replace(/^www\./, '');
  const href = location.href;
  const path = location.pathname;
  const baseTitle = cleanTitle(meta('og:title') || document.title);

  if (/xiaohongshu\.com|rednote\.com/i.test(hostname)) {
    const state = readInitialState();
    const stateTitle = walkStrings(state, ['title', 'displayTitle', 'desc']);
    const stateUser = walkStrings(state, ['nickname', 'nickName', 'userName', 'name']);
    if (/\/user\/profile\//i.test(path)) {
      const username = normalizeText(
        text('.user-name') ||
        text('[class*="user-name"]') ||
        text('[class*="nickname"]') ||
        text('[class*="name"]') ||
        stateUser ||
        baseTitle
      );
      return {
        platform: 'xiaohongshu',
        pageType: 'profile',
        title: username,
        username,
        url: href,
        hostname,
      };
    }
    if (/\/explore\/|\/discovery\/item\//i.test(path) || document.querySelector('#noteContainer, .note-detail-mask')) {
      const title = cleanTitle(
        text('#detail-title') ||
        text('.note-content #detail-title') ||
        text('.note-content .title') ||
        stateTitle ||
        baseTitle
      );
      const author = normalizeText(
        text('.author .username') ||
        text('.author-wrapper .username') ||
        text('[class*="author"] [class*="name"]') ||
        stateUser
      );
      return {
        platform: 'xiaohongshu',
        pageType: 'note',
        title,
        author,
        url: href,
        hostname,
      };
    }
    return {
      platform: 'xiaohongshu',
      pageType: 'page',
      title: baseTitle,
      url: href,
      hostname,
    };
  }

  if (/youtube\.com|youtu\.be/i.test(hostname)) {
    return {
      platform: 'youtube',
      pageType: /\/watch|\/shorts\//i.test(path) ? 'video' : 'page',
      title: cleanTitle(text('h1 yt-formatted-string') || baseTitle),
      url: href,
      hostname,
    };
  }

  if (/douyin\.com/i.test(hostname)) {
    return {
      platform: 'douyin',
      pageType: /\/video\//i.test(path) ? 'video' : 'page',
      title: cleanTitle(meta('og:title') || text('h1') || baseTitle),
      author: text('[class*="author"] [class*="name"]') || '',
      url: href,
      hostname,
    };
  }

  if (/kuaishou\.com|kwai\.com/i.test(hostname)) {
    return {
      platform: 'kuaishou',
      pageType: /\/short-video\/|\/fw\/photo\//i.test(path) ? 'video' : 'page',
      title: cleanTitle(meta('og:title') || text('h1') || baseTitle),
      author: text('[class*="author"] [class*="name"]') || text('[class*="user"] [class*="name"]'),
      url: href,
      hostname,
    };
  }

  if (/bilibili\.com|b23\.tv/i.test(hostname)) {
    return {
      platform: 'bilibili',
      pageType: /\/video\/|\/bangumi\/play\//i.test(path) ? 'video' : 'page',
      title: cleanTitle(text('h1.video-title') || text('[class*="video-title"]') || meta('og:title') || baseTitle),
      author: text('.up-name') || text('[class*="up-name"]') || text('[class*="username"]'),
      url: href,
      hostname,
    };
  }

  if (/tiktok\.com/i.test(hostname)) {
    return {
      platform: 'tiktok',
      pageType: /\/video\//i.test(path) ? 'video' : 'page',
      title: cleanTitle(meta('og:title') || text('h1') || baseTitle),
      author: text('[data-e2e="browse-username"]') || text('[data-e2e="user-title"]'),
      url: href,
      hostname,
    };
  }

  if (/reddit\.com/i.test(hostname)) {
    const isPost = /\/comments\//i.test(path);
    return {
      platform: 'reddit',
      pageType: isPost ? 'article' : 'page',
      title: cleanTitle(text('shreddit-post h1') || text('h1') || meta('og:title') || baseTitle),
      author: text('shreddit-post [slot="authorName"]') || text('[data-testid="post_author_link"]'),
      url: href,
      hostname,
    };
  }

  if (hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com' || hostname.endsWith('.twitter.com')) {
    const isPost = /\/status\//i.test(path);
    return {
      platform: 'x',
      pageType: isPost ? 'article' : 'page',
      title: cleanTitle(meta('og:title') || text('[data-testid="tweetText"]') || baseTitle),
      author: text('[data-testid="User-Name"]') || '',
      url: href,
      hostname,
    };
  }

  if (/instagram\.com/i.test(hostname)) {
    return {
      platform: 'instagram',
      pageType: /\/p\/|\/reel\//i.test(path) ? 'article' : 'page',
      title: cleanTitle(meta('og:title') || text('h1') || baseTitle),
      author: text('header a[href^="/"]') || '',
      url: href,
      hostname,
    };
  }

  if (/mp\.weixin\.qq\.com/i.test(hostname)) {
    return {
      platform: 'wechat',
      pageType: 'article',
      title: cleanTitle(text('#activity-name') || baseTitle),
      author: text('#js_name') || text('#js_author_name'),
      url: href,
      hostname,
    };
  }

  return {
    platform: 'web',
    pageType: 'page',
    title: baseTitle,
    url: href,
    hostname,
  };
}

function createXhsTaskId(type) {
  xhsTaskSequence += 1;
  return `xhs-task-${Date.now()}-${xhsTaskSequence}-${hashString(type || 'task').slice(0, 6)}`;
}

function countMessageUrls(value) {
  if (Array.isArray(value)) return value.filter(Boolean).length;
  return String(value || '').split(/\r?\n|,|\s+/).filter(Boolean).length;
}

function createXhsTaskTitle(type, message = {}, tabId = 0) {
  switch (type) {
    case 'save-xhs':
      return '保存当前小红书笔记';
    case 'xhs:download-current-note':
      return '下载当前笔记素材';
    case 'xhs:collect-current-comments':
      return '采集当前笔记评论';
    case 'xhs:collect-current-blogger':
      return '采集当前博主资料';
    case 'xhs:collect-blogger-notes':
      return `采集当前博主笔记${message?.options?.limit ? `（${Number(message.options.limit)} 条）` : ''}`;
    case 'xhs:collect-note-links':
      return `链接批量采集（${countMessageUrls(message?.urls)} 条）`;
    case 'xhs:collect-visible-note-links':
      return '采集当前页可见笔记';
    case 'xhs:collect-keyword':
      return `关键词采集：${normalizeText(message?.keyword) || '小红书'}`;
    case 'save-bilibili':
      return '保存 Bilibili 内容';
    case 'save-kuaishou':
      return '保存快手内容';
    case 'save-tiktok':
      return '保存 TikTok 内容';
    case 'save-reddit':
      return '保存 Reddit 内容';
    case 'save-x':
      return '保存 X 内容';
    case 'save-instagram':
      return '保存 Instagram 内容';
    default:
      return tabId ? `小红书任务 #${tabId}` : '小红书采集任务';
  }
}

function sanitizeXhsTaskForState(task) {
  if (!task) return null;
  return {
    id: normalizeText(task.id),
    type: normalizeText(task.type),
    title: normalizeText(task.title),
    status: normalizeText(task.status),
    tabId: Number(task.tabId || 0) || null,
    createdAt: normalizeText(task.createdAt),
    startedAt: normalizeText(task.startedAt),
    completedAt: normalizeText(task.completedAt),
    updatedAt: normalizeText(task.updatedAt),
    summary: normalizeText(task.summary),
    error: normalizeText(task.error),
  };
}

function sanitizeXhsTaskLogForState(entry) {
  if (!entry) return null;
  return {
    id: normalizeText(entry.id) || `task-log-${Date.now()}`,
    taskId: normalizeText(entry.taskId),
    type: normalizeText(entry.type),
    status: normalizeText(entry.status) || 'success',
    title: normalizeText(entry.title) || '采集任务',
    message: normalizeText(entry.message) || '任务执行完成',
    createdAt: normalizeText(entry.createdAt) || new Date().toISOString(),
  };
}

function getXhsTaskLogsForState(limit = 20) {
  return xhsTaskLogs
    .map(sanitizeXhsTaskLogForState)
    .filter(Boolean)
    .slice(0, limit);
}

function getXhsTaskQueueState() {
  return {
    active: sanitizeXhsTaskForState(xhsActiveTask),
    queued: xhsTaskQueue.map(sanitizeXhsTaskForState),
    last: sanitizeXhsTaskForState(xhsLastTask),
    logs: getXhsTaskLogsForState(),
    queuedCount: xhsTaskQueue.length,
    running: Boolean(xhsActiveTask),
    updatedAt: new Date().toISOString(),
  };
}

function summarizeXhsTaskResult(result) {
  if (result?.mode === 'xhs-link-batch' || result?.mode === 'xhs-blogger-notes') {
    return `成功 ${Number(result.count || 0)} 条，失败 ${Number(result.failed || 0)} 条`;
  }
  if (result?.mode === 'xhs-download') {
    return `下载 ${Number(result.count || 0)} 个素材`;
  }
  if (result?.mode === 'xhs-comments') {
    return `评论 ${Number(result.count || 0)} 条`;
  }
  if (result?.mode === 'xhs-blogger') {
    return '博主资料已写入知识库';
  }
  if (/^(bilibili|kuaishou|tiktok|reddit|x|instagram)-/.test(String(result?.mode || ''))) {
    return result.duplicate ? '重复内容已跳过' : '平台内容已写入知识库';
  }
  if (result?.noteId) {
    return result.duplicate ? '重复内容已跳过' : '已写入知识库';
  }
  return '任务已完成';
}

function getXhsTaskActionLabel(type) {
  switch (type) {
    case 'save-xhs':
      return '保存笔记';
    case 'xhs:download-current-note':
      return '下载素材';
    case 'xhs:collect-current-comments':
      return '采集评论';
    case 'xhs:collect-current-blogger':
      return '保存博主';
    case 'xhs:collect-blogger-notes':
      return '采集博主笔记';
    case 'xhs:collect-note-links':
      return '批量采集';
    case 'xhs:collect-visible-note-links':
      return '采集可见笔记';
    case 'xhs:collect-keyword':
      return '按关键词采集';
    case 'xhs:export-current-note-json':
      return '导出 JSON';
    case 'save-bilibili':
      return '保存 Bilibili';
    case 'save-kuaishou':
      return '保存快手';
    case 'save-tiktok':
      return '保存 TikTok';
    case 'save-reddit':
      return '保存 Reddit';
    case 'save-x':
      return '保存 X';
    case 'save-instagram':
      return '保存 Instagram';
    default:
      return '执行任务';
  }
}

function classifyXhsTaskResult(result) {
  if (result?.success === false || result?.completed === false) {
    return Number(result?.count || 0) > 0 ? 'partial' : 'failed';
  }
  return Number(result?.failed || 0) > 0 ? 'partial' : 'success';
}

function buildXhsTaskLogMessage(task, status, result, error) {
  const action = getXhsTaskActionLabel(task?.type);
  if (status === 'running') {
    return `开始执行：${task?.title || action}`;
  }
  if (status === 'failed') {
    const detail = error instanceof Error ? error.message : normalizeText(error);
    return `${action}失败${detail ? `：${detail}` : ''}`;
  }
  const summary = normalizeText(result?.task?.summary || result?.summary || summarizeXhsTaskResult(result));
  if (status === 'partial') {
    return `${action}部分完成：${summary}`;
  }
  return `${action}成功：${summary}`;
}

async function hydrateXhsTaskLogs() {
  const stored = await getStorageLocal([XHS_TASK_LOG_KEY]).catch(() => ({}));
  const logs = Array.isArray(stored?.[XHS_TASK_LOG_KEY]) ? stored[XHS_TASK_LOG_KEY] : [];
  xhsTaskLogs = logs.map(sanitizeXhsTaskLogForState).filter(Boolean).slice(0, XHS_TASK_LOG_LIMIT);
}

function appendXhsTaskLog(entry) {
  const normalized = sanitizeXhsTaskLogForState({
    ...entry,
    id: normalizeText(entry?.id) || `task-log-${Date.now()}-${hashString(`${entry?.taskId || ''}-${entry?.status || ''}`).slice(0, 6)}`,
    createdAt: normalizeText(entry?.createdAt) || new Date().toISOString(),
  });
  xhsTaskLogs = [normalized, ...xhsTaskLogs].slice(0, XHS_TASK_LOG_LIMIT);
  void setStorageLocal({ [XHS_TASK_LOG_KEY]: xhsTaskLogs }).catch((error) => {
    pluginWarn('xhs-task-log-store-failed', { error: describeError(error) });
  });
  publishXhsTaskQueueState();
  return normalized;
}

function publishXhsTaskQueueState() {
  const queue = getXhsTaskQueueState();
  void setStorageLocal({ [XHS_TASK_QUEUE_STATE_KEY]: queue }).catch((error) => {
    pluginWarn('xhs-task-queue-store-failed', { error: describeError(error) });
  });
  void chrome.runtime.sendMessage({ type: 'xhs:task-queue:update', queue }).catch(() => {});
  return queue;
}

function enqueueXhsTask({ type, title, tabId, execute }) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    const task = {
      id: createXhsTaskId(type),
      type,
      title,
      tabId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      execute,
      resolve,
      reject,
    };
    xhsTaskQueue.push(task);
    publishXhsTaskQueueState();
    void runNextXhsTask();
  });
}

async function runNextXhsTask() {
  if (xhsActiveTask || xhsTaskQueue.length === 0) return;
  const task = xhsTaskQueue.shift();
  xhsActiveTask = task;
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  task.updatedAt = task.startedAt;
  appendXhsTaskLog({
    taskId: task.id,
    type: task.type,
    status: 'running',
    title: task.title,
    message: buildXhsTaskLogMessage(task, 'running'),
    createdAt: task.startedAt,
  });
  publishXhsTaskQueueState();
  try {
    const result = await task.execute();
    const logStatus = classifyXhsTaskResult(result);
    task.status = logStatus === 'success' ? 'completed' : logStatus;
    task.summary = summarizeXhsTaskResult(result);
    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    xhsLastTask = task;
    appendXhsTaskLog({
      taskId: task.id,
      type: task.type,
      status: logStatus,
      title: task.title,
      message: buildXhsTaskLogMessage(task, logStatus, result),
      createdAt: task.completedAt,
    });
    task.resolve({
      ...result,
      taskQueue: getXhsTaskQueueState(),
    });
  } catch (error) {
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : String(error);
    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    xhsLastTask = task;
    appendXhsTaskLog({
      taskId: task.id,
      type: task.type,
      status: 'failed',
      title: task.title,
      message: buildXhsTaskLogMessage(task, 'failed', null, error),
      createdAt: task.completedAt,
    });
    task.reject(error);
  } finally {
    xhsActiveTask = null;
    publishXhsTaskQueueState();
    void runNextXhsTask();
  }
}

async function getXhsTaskHistory() {
  const stored = await getStorageLocal([XHS_TASK_HISTORY_KEY]).catch(() => ({}));
  const history = Array.isArray(stored?.[XHS_TASK_HISTORY_KEY])
    ? stored[XHS_TASK_HISTORY_KEY]
    : [];
  return { success: true, history };
}

async function writeXhsTaskHistory(history) {
  const nextHistory = Array.isArray(history)
    ? history.slice(0, XHS_TASK_HISTORY_LIMIT)
    : [];
  await setStorageLocal({ [XHS_TASK_HISTORY_KEY]: nextHistory });
  return nextHistory;
}

async function appendXhsTaskHistory(entry) {
  const current = (await getXhsTaskHistory()).history;
  const normalized = {
    id: normalizeText(entry?.id) || `xhs-task-${Date.now()}`,
    type: normalizeText(entry?.type) || 'note',
    title: normalizeText(entry?.title) || '小红书采集任务',
    status: normalizeText(entry?.status) || 'completed',
    count: Number(entry?.count || 0),
    failed: Number(entry?.failed || 0),
    createdAt: normalizeText(entry?.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    summary: normalizeText(entry?.summary),
    payload: entry?.payload || null,
  };
  const nextHistory = await writeXhsTaskHistory([normalized, ...current]);
  return normalized;
}

async function clearXhsTaskHistory() {
  await setStorageLocal({ [XHS_TASK_HISTORY_KEY]: [] });
  return { success: true, history: [] };
}

async function readPluginUpdateState() {
  const stored = await getStorageLocal([UPDATE_STATE_KEY]).catch(() => ({}));
  return sanitizeUpdateState(stored?.[UPDATE_STATE_KEY]);
}

async function writePluginUpdateState(nextState) {
  const state = sanitizeUpdateState(nextState);
  await setStorageLocal({ [UPDATE_STATE_KEY]: state });
  await applyUpdateBadge(state);
  return state;
}

async function applyUpdateBadge(stateInput) {
  const state = sanitizeUpdateState(stateInput);
  const badgeText = state.hasUpdate ? 'NEW' : '';
  await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' }).catch(() => {});
  if (typeof chrome.action.setBadgeTextColor === 'function') {
    await chrome.action.setBadgeTextColor({ color: '#fff7ed' }).catch(() => {});
  }
  await chrome.action.setBadgeText({ text: badgeText }).catch(() => {});
  const title = state.hasUpdate
    ? `RedBox Capture：发现新版本 ${state.latestVersion}`
    : `RedBox Capture ${state.currentVersion}`;
  await chrome.action.setTitle({ title }).catch(() => {});
}

async function initializeUpdateChecks(forceImmediateCheck) {
  await writePluginUpdateState(await readPluginUpdateState());
  const settings = await readPluginSettings();
  await configureUpdateAlarm(settings);
  if (!settings.autoUpdateCheck) {
    return;
  }
  if (forceImmediateCheck) {
    await checkForPluginUpdates({ force: true, reason: 'install' });
    return;
  }
  const currentState = await readPluginUpdateState();
  if (!currentState.lastCheckedAt) {
    await checkForPluginUpdates({ force: false, reason: 'startup-empty-cache' });
  }
}

async function fetchRemotePluginManifest() {
  const response = await fetch(UPDATE_SOURCE_MANIFEST_URL, {
    cache: 'no-store',
    headers: {
      'Accept': 'application/json, text/plain, */*',
    },
  });
  if (!response.ok) {
    throw new Error(`更新源请求失败：HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!data || typeof data !== 'object') {
    throw new Error('更新源返回了无效的 manifest');
  }
  return data;
}

async function getPluginUpdateStatus(refresh = false) {
  if (refresh) {
    return await checkForPluginUpdates({ force: true, reason: 'popup-refresh' });
  }
  const state = await readPluginUpdateState();
  return {
    success: true,
    update: state,
  };
}

async function checkForPluginUpdates(options = {}) {
  const force = options?.force === true;
  const reason = normalizeText(options?.reason) || 'unknown';
  const currentState = await readPluginUpdateState();
  if (!force && currentState.checkStatus === 'checking') {
    return {
      success: true,
      update: currentState,
    };
  }

  const checkingState = await writePluginUpdateState({
    ...currentState,
    checkStatus: 'checking',
    lastError: '',
  });

  try {
    pluginLog('plugin-update-check-start', {
      reason,
      source: UPDATE_SOURCE_MANIFEST_URL,
    });
    const remoteManifest = await fetchRemotePluginManifest();
    const currentVersion = getCurrentPluginVersion();
    const latestVersion = normalizeText(remoteManifest?.version) || currentVersion;
    const nextState = await writePluginUpdateState({
      ...checkingState,
      currentVersion,
      latestVersion,
      hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
      lastCheckedAt: new Date().toISOString(),
      sourceUrl: UPDATE_SOURCE_REPO_URL,
      lastError: '',
      checkStatus: 'idle',
    });
    pluginLog('plugin-update-check-success', {
      reason,
      currentVersion,
      latestVersion,
      hasUpdate: nextState.hasUpdate,
    });
    return {
      success: true,
      update: nextState,
    };
  } catch (error) {
    const nextState = await writePluginUpdateState({
      ...checkingState,
      currentVersion: getCurrentPluginVersion(),
      latestVersion: currentState.latestVersion,
      lastCheckedAt: new Date().toISOString(),
      sourceUrl: UPDATE_SOURCE_REPO_URL,
      lastError: error instanceof Error ? error.message : String(error),
      checkStatus: 'idle',
    });
    pluginWarn('plugin-update-check-failed', {
      reason,
      error: describeError(error),
    });
    return {
      success: false,
      error: nextState.lastError || '检查更新失败',
      update: nextState,
    };
  }
}

async function checkDesktopServer(forceRefresh = false) {
  try {
    const endpoint = await resolveKnowledgeApiEndpoint(forceRefresh);
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

  const settings = await readPluginSettings();
  let lastError = null;
  const attemptedUrls = [];
  for (const candidate of knowledgeApiCandidatesFromSettings(settings)) {
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
    ' 请确认 RedBox 桌面端已启动，并且插件设置页中的本地 API 地址正确。'
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

function isRecoverableKnowledgeNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /Failed to fetch|NetworkError|Load failed|ERR_|请求失败/i.test(message);
}

async function postKnowledgeJson(path, payload, logScope) {
  let endpoint = await resolveKnowledgeApiEndpoint();
  try {
    return await fetchKnowledgeJson(endpoint, path, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (!isRecoverableKnowledgeNetworkError(error)) {
      throw error;
    }
    clearCachedKnowledgeApi();
    pluginWarn(`${logScope || 'knowledge-post'}-retry`, {
      path,
      firstEndpoint: `${endpoint.baseUrl}${endpoint.endpointPath}`,
      error: describeError(error),
    });
    endpoint = await resolveKnowledgeApiEndpoint(true);
    return await fetchKnowledgeJson(endpoint, path, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
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
  const response = await postKnowledgeJson('/entries', payload, 'entry-submit');
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
  const response = await postKnowledgeJson('/media-assets', payload, 'media-submit');
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

function dataUrlByteSize(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('data:')) return 0;
  const encoded = raw.split(',', 2)[1] || '';
  return Math.floor(encoded.length * 3 / 4);
}

function keepInlineAssetWithinLimit(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('data:')) return raw;
  return dataUrlByteSize(raw) <= INLINE_ASSET_MAX_BYTES ? raw : '';
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
      authorProfileUrl: normalizeText(payload?.authorProfileUrl) || undefined,
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
  const noteType = normalizeText(payload?.noteType);
  const videoAssetUrl = keepInlineAssetWithinLimit(payload?.videoDataUrl)
    || normalizeText(payload?.videoUrl);
  const imageUrls = Array.isArray(payload?.images)
    ? payload.images.map(keepInlineAssetWithinLimit).filter(Boolean)
    : [];
  const kind = noteType === 'video'
    ? 'xhs-video'
    : noteType === 'image'
      ? 'xhs-note'
      : videoAssetUrl
        ? 'xhs-video'
        : 'xhs-note';
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
      authorProfileUrl: normalizeText(payload?.authorProfileUrl) || undefined,
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
      coverUrl: keepInlineAssetWithinLimit(payload?.coverUrl) || imageUrls[0] || undefined,
      imageUrls,
      videoUrl: videoAssetUrl || undefined,
    },
    options: {
      dedupeKey: stableNoteId,
      allowUpdate: true,
      summarize: false,
      transcribe: kind === 'xhs-video',
    },
  };
}

function buildXhsCommentsEntry(payload) {
  const sourceUrl = normalizeText(payload?.source);
  const sourceDomain = extractDomainFromUrl(sourceUrl) || 'www.xiaohongshu.com';
  const stableNoteId = normalizeText(payload?.noteId) || `xhs-${hashString(sourceUrl)}`;
  const title = normalizeText(payload?.title) || '小红书评论';
  const comments = Array.isArray(payload?.comments)
    ? payload.comments
        .map((item) => ({
          author: normalizeText(item?.author),
          text: normalizeText(item?.text),
          likes: Number(item?.likes || 0),
          createdAt: normalizeText(item?.createdAt),
          location: normalizeText(item?.location),
        }))
        .filter((item) => item.author || item.text)
    : [];
  const text = comments.length > 0
    ? comments.map((item, index) => {
        const meta = [item.author, item.location, item.createdAt, item.likes ? `赞${item.likes}` : '']
          .filter(Boolean)
          .join(' · ');
        return `${index + 1}. ${meta}\n${item.text}`;
      }).join('\n\n')
    : '当前页面未采集到评论。';

  return {
    kind: 'xhs-comments',
    source: createKnowledgeSourceInput({
      sourceLink: sourceUrl,
      sourceDomain,
      externalId: `comments-${stableNoteId}`,
    }),
    content: {
      title: `${title} - 评论快照`,
      text,
      excerpt: truncateText(text, 180),
      description: truncateText(text, 500),
      siteName: sourceDomain,
      tags: ['小红书', '评论'],
      commentsSnapshot: comments,
      stats: {
        comments: comments.length,
      },
    },
    assets: {
      coverUrl: normalizeText(payload?.coverUrl) || undefined,
    },
    options: {
      dedupeKey: `xhs-comments:${stableNoteId}`,
      allowUpdate: true,
      summarize: false,
      transcribe: false,
    },
  };
}

function buildXhsBloggerEntry(payload) {
  const sourceUrl = normalizeText(payload?.source);
  const sourceDomain = extractDomainFromUrl(sourceUrl) || 'www.xiaohongshu.com';
  const userId = normalizeText(payload?.userId) || `xhs-user-${hashString(sourceUrl)}`;
  const nickname = normalizeText(payload?.nickname) || normalizeText(payload?.name) || '小红书博主';
  const description = normalizeText(payload?.description) || normalizeText(payload?.desc);
  const stats = payload?.stats && typeof payload.stats === 'object' ? payload.stats : {};
  const text = [
    `昵称：${nickname}`,
    userId ? `用户ID：${userId}` : '',
    description ? `简介：${description}` : '',
    stats.follows ? `关注：${stats.follows}` : '',
    stats.fans ? `粉丝：${stats.fans}` : '',
    stats.liked ? `获赞与收藏：${stats.liked}` : '',
    sourceUrl,
  ].filter(Boolean).join('\n');

  return {
    kind: 'xhs-blogger',
    source: createKnowledgeSourceInput({
      sourceLink: sourceUrl,
      sourceDomain,
      externalId: `xhs-blogger-${userId}`,
    }),
    content: {
      title: `${nickname} - 小红书博主`,
      author: nickname,
      authorId: `xhs-author-${hashString(userId)}`,
      authorPlatformUserId: userId,
      authorProfileUrl: sourceUrl,
      authorAvatarUrl: normalizeText(payload?.avatar) || undefined,
      authorDescription: description || undefined,
      text,
      excerpt: truncateText(description || text, 180),
      description: truncateText(description || text, 500),
      siteName: sourceDomain,
      tags: ['小红书', '博主'],
      stats,
      profile: payload || {},
    },
    assets: {
      coverUrl: normalizeText(payload?.avatar) || undefined,
      imageUrls: [normalizeText(payload?.avatar)].filter(Boolean),
    },
    options: {
      dedupeKey: `xhs-blogger:${userId}`,
      allowUpdate: true,
      summarize: false,
      transcribe: false,
    },
  };
}

function buildDouyinEntry(payload) {
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

  const sourceUrl = normalizeText(payload?.source || payload?.url);
  const sourceDomain = extractDomainFromUrl(sourceUrl) || 'www.douyin.com';
  const stableNoteId = normalizeText(payload?.noteId)
    || `douyin-${hashString(sourceUrl || normalizeText(payload?.videoUrl) || normalizeText(payload?.title))}`;
  const videoAssetUrl = normalizeText(payload?.videoDataUrl)
    || normalizeText(payload?.videoUrl);
  const coverUrl = normalizeText(payload?.coverDataUrl)
    || normalizeText(payload?.coverUrl);
  const text = normalizeText(payload?.text)
    || normalizeText(payload?.content)
    || normalizeText(payload?.description)
    || normalizeText(payload?.title);
  const commentsSnapshot = Array.isArray(payload?.commentsSnapshot)
    ? payload.commentsSnapshot
        .map((item) => ({
          author: normalizeText(item?.author),
          text: normalizeText(item?.text),
          likes: Number(item?.likes || 0),
          replies: Number(item?.replies || 0),
          createdAt: normalizeText(item?.createdAt),
          location: normalizeText(item?.location),
        }))
        .filter((item) => item.author || item.text)
    : [];
  const publishedAt = normalizeText(payload?.publishedAt);
  const indexText = normalizeText(payload?.indexText)
    || [
      normalizeText(payload?.title),
      text,
      publishedAt ? `发布时间：${publishedAt}` : '',
      commentsSnapshot.length > 0
        ? `评论快照：\n${commentsSnapshot.map((item, index) => {
            const meta = [
              item.author,
              item.location,
              item.createdAt,
              item.likes ? `赞${item.likes}` : '',
              item.replies ? `回复${item.replies}` : '',
            ].filter(Boolean).join(' · ');
            return `${index + 1}. ${meta}\n${item.text}`;
          }).join('\n\n')}`
        : '',
    ].filter(Boolean).join('\n\n');
  const tags = Array.from(new Set(['抖音', ...extractTagsFromText(text)]));

  if (!sourceUrl || !videoAssetUrl) {
    throw new Error('当前页面未识别到可保存的抖音视频');
  }

  return {
    kind: 'douyin-video',
    source: createKnowledgeSourceInput({
      sourceLink: sourceUrl,
      externalId: stableNoteId,
      sourceDomain,
    }),
    content: {
      title: normalizeText(payload?.title) || '抖音视频',
      author: normalizeText(payload?.author),
      text,
      excerpt: truncateText(text, 180),
      description: truncateText(text, 500),
      siteName: sourceDomain,
      tags,
      publishedAt: publishedAt || undefined,
      authorProfileUrl: normalizeText(payload?.authorProfileUrl) || undefined,
      commentsSnapshot,
      indexText: indexText || undefined,
      stats: {
        likes: Number(payload?.stats?.likes || 0),
        collects: Number(payload?.stats?.collects || 0),
        comments: Number(payload?.stats?.comments || 0),
        shares: Number(payload?.stats?.shares || 0),
      },
    },
    assets: {
      coverUrl: coverUrl || undefined,
      videoUrl: videoAssetUrl || undefined,
    },
    options: {
      dedupeKey: stableNoteId,
      allowUpdate: true,
      summarize: false,
      transcribe: true,
    },
  };
}

function buildSocialPlatformEntry(payload = {}) {
  const platform = normalizeText(payload?.platform) || 'web';
  const platformName = normalizeText(payload?.platformName) || inferSiteNameFromUrl(payload?.source || payload?.url) || platform;
  const contentType = normalizeText(payload?.contentType) || 'page';
  const sourceUrl = normalizeText(payload?.source || payload?.url);
  const sourceDomain = extractDomainFromUrl(sourceUrl);
  const externalId = normalizeText(payload?.externalId)
    || `${platform}-${hashString(`${sourceUrl}\n${normalizeText(payload?.title)}\n${normalizeText(payload?.author)}`)}`;
  const text = normalizeText(payload?.text)
    || normalizeText(payload?.description)
    || normalizeText(payload?.title)
    || sourceUrl;
  const title = normalizeText(payload?.title)
    || truncateText(text, 80)
    || `${platformName} 内容`;
  const imageUrls = Array.isArray(payload?.images)
    ? payload.images.map(normalizeText).filter(Boolean).slice(0, 12)
    : [];
  const tags = Array.from(new Set([
    platformName,
    contentType === 'profile' ? '作者主页' : '',
    contentType === 'video' ? '视频' : '',
    contentType === 'post' ? '帖子' : '',
    ...(
      Array.isArray(payload?.tags)
        ? payload.tags.map(normalizeText).filter(Boolean)
        : []
    ),
  ].filter(Boolean)));

  if (!sourceUrl) {
    throw new Error('当前页面缺少可保存的来源地址');
  }

  return {
    kind: `${platform}-${contentType}`,
    source: createKnowledgeSourceInput({
      sourceLink: sourceUrl,
      sourceDomain,
      externalId,
    }),
    content: {
      title,
      author: normalizeText(payload?.author),
      authorProfileUrl: normalizeText(payload?.authorProfileUrl) || undefined,
      text,
      excerpt: truncateText(payload?.excerpt || text, 180),
      description: truncateText(payload?.description || text, 500),
      siteName: platformName,
      tags,
      publishedAt: normalizeText(payload?.publishedAt) || undefined,
      stats: payload?.stats && typeof payload.stats === 'object' ? payload.stats : undefined,
      indexText: normalizeText(payload?.indexText) || undefined,
    },
    assets: {
      coverUrl: normalizeText(payload?.coverUrl) || imageUrls[0] || undefined,
      imageUrls,
      videoUrl: normalizeText(payload?.videoUrl) || undefined,
      thumbnailUrl: normalizeText(payload?.thumbnailUrl) || normalizeText(payload?.coverUrl) || imageUrls[0] || undefined,
    },
    options: {
      dedupeKey: externalId,
      allowUpdate: true,
      summarize: false,
      transcribe: Boolean(payload?.videoUrl),
    },
  };
}

async function runExtraction(tabId, func, options = {}) {
  if (!tabId) {
    throw new Error('No active tab');
  }
  let targetTabId = Number(tabId || 0);
  const existingTab = await chrome.tabs.get(targetTabId).catch(() => null);
  if (!existingTab) {
    const activeTab = await getActiveTab().catch(() => null);
    targetTabId = Number(activeTab?.id || 0);
  }
  if (!targetTabId) {
    throw new Error('No active tab');
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func,
    args: Array.isArray(options.args) ? options.args : [],
    world: options.world || 'ISOLATED',
  });
  if (!result) {
    throw new Error('Failed to execute page extraction');
  }
  return result.result;
}

function extractSocialPlatformPayload(platformHint = '') {
  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cleanMultiline(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function meta(selector) {
    return clean(document.querySelector(selector)?.getAttribute('content') || '');
  }

  function text(selector, root = document) {
    return clean(root.querySelector(selector)?.textContent || '');
  }

  function attr(selector, name, root = document) {
    return clean(root.querySelector(selector)?.getAttribute(name) || '');
  }

  function absoluteUrl(value) {
    const raw = clean(value);
    if (!raw) return '';
    try {
      return new URL(raw, location.href).href;
    } catch {
      return '';
    }
  }

  function pushUnique(list, value) {
    const url = absoluteUrl(value);
    if (!url || !/^https?:\/\//i.test(url) || list.includes(url)) return;
    list.push(url);
  }

  function parseJsonScript(id) {
    const raw = document.getElementById(id)?.textContent || '';
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function readInitialState() {
    if (window.__INITIAL_STATE__ && typeof window.__INITIAL_STATE__ === 'object') {
      return window.__INITIAL_STATE__;
    }
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const raw = script.textContent || '';
      if (!raw.includes('window.__INITIAL_STATE__=')) continue;
      try {
        return JSON.parse(raw.replace('window.__INITIAL_STATE__=', '').replace(/undefined/g, 'null').replace(/;$/, ''));
      } catch {}
    }
    return null;
  }

  function unwrap(value) {
    if (!value || typeof value !== 'object') return value;
    if (value._rawValue && typeof value._rawValue === 'object') return value._rawValue;
    if (value.value && typeof value.value === 'object') return value.value;
    return value;
  }

  function findObject(root, predicate, limit = 800) {
    const queue = [unwrap(root)];
    const seen = new Set();
    let visited = 0;
    while (queue.length > 0 && visited < limit) {
      visited += 1;
      const item = unwrap(queue.shift());
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      try {
        if (predicate(item)) return item;
      } catch {}
      for (const child of Object.values(item)) {
        if (child && typeof child === 'object') queue.push(child);
      }
    }
    return null;
  }

  function collectImages(root = document, max = 10) {
    const urls = [];
    pushUnique(urls, meta('meta[property="og:image"]'));
    pushUnique(urls, meta('meta[name="twitter:image"]'));
    const images = Array.from(root.querySelectorAll('img[src], img[data-src], img[srcset]'));
    for (const img of images) {
      pushUnique(urls, img.getAttribute('src'));
      pushUnique(urls, img.getAttribute('data-src'));
      const srcset = img.getAttribute('srcset') || '';
      if (srcset) pushUnique(urls, srcset.split(',').pop()?.trim().split(/\s+/)[0]);
      if (urls.length >= max) break;
    }
    return urls.slice(0, max);
  }

  function largestVideoUrl(root = document) {
    const videos = Array.from(root.querySelectorAll('video, video source'))
      .map((node) => {
        const el = node.tagName === 'SOURCE' ? node.parentElement : node;
        const rect = el?.getBoundingClientRect?.() || { width: 0, height: 0 };
        return {
          url: absoluteUrl(node.currentSrc || node.src || node.getAttribute?.('src') || ''),
          area: rect.width * rect.height,
        };
      })
      .filter((item) => item.url);
    videos.sort((a, b) => b.area - a.area);
    return videos[0]?.url || '';
  }

  function numberText(value) {
    const raw = clean(value).replace(/,/g, '');
    const match = raw.match(/(\d+(?:\.\d+)?)(万|w|k|m)?/i);
    if (!match) return 0;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return 0;
    const unit = String(match[2] || '').toLowerCase();
    if (unit === '万' || unit === 'w') return Math.round(base * 10000);
    if (unit === 'k') return Math.round(base * 1000);
    if (unit === 'm') return Math.round(base * 1000000);
    return Math.round(base);
  }

  function detectPlatform() {
    const host = location.hostname.replace(/^www\./i, '').toLowerCase();
    const hint = clean(platformHint).toLowerCase();
    if (hint) return hint;
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv') return 'bilibili';
    if (host === 'kuaishou.com' || host.endsWith('.kuaishou.com') || host === 'kwai.com' || host.endsWith('.kwai.com')) return 'kuaishou';
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
    if (host === 'reddit.com' || host.endsWith('.reddit.com')) return 'reddit';
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
    return host.split('.').slice(-2, -1)[0] || 'web';
  }

  function basePayload(platform, platformName, contentType = 'page') {
    const images = collectImages();
    return {
      platform,
      platformName,
      contentType,
      source: location.href,
      title: clean(meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || document.title),
      description: clean(meta('meta[property="og:description"]') || meta('meta[name="description"]') || meta('meta[name="twitter:description"]')),
      text: '',
      author: clean(meta('meta[name="author"]')),
      authorProfileUrl: '',
      publishedAt: clean(meta('meta[property="article:published_time"]') || document.querySelector('time')?.getAttribute('datetime') || ''),
      coverUrl: images[0] || '',
      thumbnailUrl: images[0] || '',
      images,
      videoUrl: largestVideoUrl(),
      stats: {},
      externalId: `${platform}-${location.pathname}${location.search}`,
      mode: `${platform}-${contentType}`,
    };
  }

  function extractBilibili() {
    const state = readInitialState();
    const videoData = state?.videoData || state?.videoInfo || {};
    const up = videoData.owner || state?.upData || {};
    const isVideo = /^\/video\/|^\/bangumi\/play\//i.test(location.pathname);
    const payload = basePayload('bilibili', 'Bilibili', isVideo ? 'video' : location.hostname === 'space.bilibili.com' ? 'profile' : 'page');
    const bvid = clean(videoData.bvid || location.pathname.match(/\/video\/([^/?#]+)/)?.[1] || '');
    payload.externalId = bvid || payload.externalId;
    payload.title = clean(videoData.title || text('h1.video-title') || text('.video-title') || payload.title);
    payload.author = clean(up.name || text('.up-name') || text('[class*="up-name"]') || text('.username') || payload.author);
    payload.authorProfileUrl = up.mid ? `https://space.bilibili.com/${up.mid}` : absoluteUrl(attr('.up-name, [class*="up-name"], .username', 'href'));
    payload.text = cleanMultiline(videoData.desc || text('.desc-info-text') || text('.video-desc') || payload.description || payload.title);
    payload.coverUrl = absoluteUrl(videoData.pic) || payload.coverUrl;
    payload.thumbnailUrl = payload.coverUrl;
    payload.stats = {
      likes: Number(videoData.stat?.like || 0),
      collects: Number(videoData.stat?.favorite || 0),
      comments: Number(videoData.stat?.reply || 0),
      shares: Number(videoData.stat?.share || 0),
      views: Number(videoData.stat?.view || 0),
    };
    const playInfo = window.__playinfo || state?.playInfo;
    const dashVideo = playInfo?.data?.dash?.video || playInfo?.dash?.video || [];
    const durl = playInfo?.data?.durl || playInfo?.durl || [];
    payload.videoUrl = absoluteUrl(dashVideo[0]?.baseUrl || dashVideo[0]?.base_url || durl[0]?.url) || payload.videoUrl;
    return payload;
  }

  function extractKuaishou() {
    const apollo = window.__APOLLO_STATE__?.defaultClient || {};
    const detail = Object.entries(apollo).find(([key]) => key.includes('visionVideoDetail'))?.[1] || {};
    const photoRef = detail?.photo?.id;
    const authorRef = detail?.author?.id;
    const photo = unwrap(photoRef ? apollo[photoRef] : detail?.photo) || {};
    const author = unwrap(authorRef ? apollo[authorRef] : detail?.author) || {};
    const isVideo = /^\/short-video\/|^\/fw\/photo\//i.test(location.pathname);
    const payload = basePayload('kuaishou', '快手', isVideo ? 'video' : location.pathname.startsWith('/profile/') ? 'profile' : 'page');
    payload.externalId = clean(photo.id || location.pathname.split('/').filter(Boolean).pop() || payload.externalId);
    payload.title = clean(photo.caption || photo.workName || payload.title);
    payload.author = clean(author.name || author.userName || author.user_name || text('[class*="user-name"]') || payload.author);
    payload.authorProfileUrl = clean(author.id || author.user_id) ? `https://www.kuaishou.com/profile/${clean(author.id || author.user_id)}` : '';
    payload.text = cleanMultiline(photo.caption || payload.description || payload.title);
    payload.coverUrl = absoluteUrl(photo.coverUrl || photo.coverUrls?.[0]?.url || photo.poster || payload.coverUrl) || payload.coverUrl;
    payload.thumbnailUrl = payload.coverUrl;
    payload.videoUrl = absoluteUrl(photo.photoUrl || photo.mainMvUrls?.[0]?.url || photo.videoResource?.hevc?.adaptationSet?.[0]?.representation?.[0]?.url) || payload.videoUrl;
    payload.stats = {
      likes: Number(photo.likeCount || photo.likedCount || 0),
      comments: Number(photo.commentCount || 0),
      shares: Number(photo.shareCount || 0),
      views: Number(photo.viewCount || 0),
    };
    return payload;
  }

  function extractTikTok() {
    const scope = window.__$UNIVERSAL_DATA$__?.__DEFAULT_SCOPE__ || {};
    const detail = scope['webapp.video-detail'] || {};
    const item = detail?.itemInfo?.itemStruct || findObject(scope, (value) => value?.id && value?.desc && value?.author) || {};
    const isVideo = /\/@[^/]+\/(video|photo)\//i.test(location.pathname);
    const payload = basePayload('tiktok', 'TikTok', isVideo ? 'video' : /^\/@[^/]+\/?$/i.test(location.pathname) ? 'profile' : 'page');
    payload.externalId = clean(item.id || location.pathname.split('/').filter(Boolean).pop() || payload.externalId);
    payload.title = clean(item.desc || payload.title);
    payload.author = clean(item.author?.nickname || item.author?.uniqueId || payload.author);
    payload.authorProfileUrl = item.author?.uniqueId ? `https://www.tiktok.com/@${item.author.uniqueId}` : '';
    payload.text = cleanMultiline(item.desc || payload.description || payload.title);
    payload.coverUrl = absoluteUrl(item.video?.cover || item.video?.originCover || item.imagePost?.cover?.imageURL?.urlList?.[0] || payload.coverUrl) || payload.coverUrl;
    payload.thumbnailUrl = payload.coverUrl;
    payload.videoUrl = absoluteUrl(item.video?.playAddr || item.video?.downloadAddr || item.video?.playApi || payload.videoUrl) || payload.videoUrl;
    payload.images = Array.isArray(item.imagePost?.images)
      ? item.imagePost.images.flatMap((image) => image?.imageURL?.urlList || []).map(absoluteUrl).filter(Boolean)
      : payload.images;
    payload.stats = {
      likes: Number(item.stats?.diggCount || 0),
      collects: Number(item.stats?.collectCount || 0),
      comments: Number(item.stats?.commentCount || 0),
      shares: Number(item.stats?.shareCount || 0),
      views: Number(item.stats?.playCount || 0),
    };
    return payload;
  }

  function extractReddit() {
    const root = document.querySelector('shreddit-post') || document.querySelector('[data-testid="post-container"]') || document.querySelector('article') || document;
    const payload = basePayload('reddit', 'Reddit', location.pathname.includes('/comments/') ? 'post' : 'page');
    payload.externalId = clean(root.getAttribute?.('id') || root.getAttribute?.('post-id') || location.pathname);
    payload.title = clean(root.getAttribute?.('post-title') || text('h1', root) || payload.title);
    payload.author = clean(root.getAttribute?.('author') || text('[slot="authorName"]', root) || text('[data-testid="post_author_link"]', root) || payload.author);
    payload.authorProfileUrl = payload.author ? `https://www.reddit.com/user/${payload.author.replace(/^u\//, '')}` : '';
    payload.text = cleanMultiline(text('[slot="text-body"]', root) || text('[data-testid="post-content"]', root) || root.innerText || payload.description || payload.title);
    payload.stats = {
      likes: numberText(root.getAttribute?.('score') || text('[id*="vote-arrows"]', root)),
      comments: numberText(root.getAttribute?.('comment-count') || text('a[href*="/comments/"]', root)),
    };
    return payload;
  }

  function extractXPost() {
    const article = document.querySelector('article[data-testid="tweet"]') || document.querySelector('article') || document;
    const payload = basePayload('x', 'X', location.pathname.includes('/status/') ? 'post' : 'page');
    payload.externalId = clean(location.pathname.match(/\/status\/(\d+)/)?.[1] || location.pathname);
    const tweetText = cleanMultiline(Array.from(article.querySelectorAll('[data-testid="tweetText"]')).map((node) => node.innerText || node.textContent || '').join('\n'));
    payload.text = tweetText || payload.description || payload.title;
    payload.title = tweetText ? tweetText.slice(0, 80) : payload.title;
    payload.author = clean(article.querySelector('[data-testid="User-Name"]')?.textContent || payload.author);
    payload.authorProfileUrl = absoluteUrl(article.querySelector('a[href^="/"][role="link"]')?.getAttribute('href') || '');
    payload.publishedAt = clean(article.querySelector('time')?.getAttribute('datetime') || payload.publishedAt);
    payload.images = collectImages(article, 8);
    payload.coverUrl = payload.images[0] || payload.coverUrl;
    payload.videoUrl = largestVideoUrl(article) || payload.videoUrl;
    return payload;
  }

  function extractInstagram() {
    const nextData = parseJsonScript('__NEXT_DATA__');
    const media = findObject(nextData, (value) => value?.shortcode || value?.edge_media_to_caption || value?.display_url);
    const isPost = /^\/(p|reel)\//i.test(location.pathname);
    const payload = basePayload('instagram', 'Instagram', isPost ? 'post' : /^\/[^/]+\/?$/i.test(location.pathname) ? 'profile' : 'page');
    payload.externalId = clean(media?.shortcode || location.pathname);
    const caption = cleanMultiline(media?.edge_media_to_caption?.edges?.[0]?.node?.text || payload.description);
    payload.title = clean(caption.slice(0, 80) || payload.title);
    payload.text = caption || payload.description || payload.title;
    payload.author = clean(media?.owner?.username || location.pathname.split('/').filter(Boolean)[0] || payload.author);
    payload.authorProfileUrl = payload.author ? `https://www.instagram.com/${payload.author}/` : '';
    payload.coverUrl = absoluteUrl(media?.display_url || payload.coverUrl) || payload.coverUrl;
    payload.videoUrl = absoluteUrl(media?.video_url || payload.videoUrl) || payload.videoUrl;
    payload.images = collectImages(document, 10);
    payload.stats = {
      likes: Number(media?.edge_media_preview_like?.count || 0),
      comments: Number(media?.edge_media_to_parent_comment?.count || 0),
      views: Number(media?.video_view_count || 0),
    };
    return payload;
  }

  const platform = detectPlatform();
  const extractors = {
    bilibili: extractBilibili,
    kuaishou: extractKuaishou,
    tiktok: extractTikTok,
    reddit: extractReddit,
    x: extractXPost,
    instagram: extractInstagram,
  };
  const payload = (extractors[platform] || (() => basePayload(platform, platform, 'page')))();
  payload.indexText = [
    payload.title,
    payload.author ? `作者：${payload.author}` : '',
    payload.publishedAt ? `发布时间：${payload.publishedAt}` : '',
    payload.text,
    payload.description && payload.description !== payload.text ? payload.description : '',
    payload.videoUrl ? `视频：${payload.videoUrl}` : '',
    payload.images?.length ? `图片：\n${payload.images.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return payload;
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
  if (action === 'save-douyin') {
    return await saveDouyinVideoFromTab(tabId);
  }
  if (action === 'save-youtube') {
    return await saveYouTubeFromTab(tabId);
  }
  if (/^save-(bilibili|kuaishou|tiktok|reddit|x|instagram)$/.test(action)) {
    return await saveSocialPlatformFromTab(tabId, action.replace(/^save-/, ''));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function normalizeXhsCollectInterval(intervalInput) {
  const input = intervalInput && typeof intervalInput === 'object' ? intervalInput : {};
  const rawMin = input.minMs ?? (Number(input.minSeconds) * 1000);
  const rawMax = input.maxMs ?? (Number(input.maxSeconds) * 1000);
  let minMs = clampNumber(
    rawMin,
    XHS_COLLECT_INTERVAL_MIN_MS,
    XHS_COLLECT_INTERVAL_MAX_MS,
    XHS_COLLECT_INTERVAL_DEFAULT_MIN_MS,
  );
  let maxMs = clampNumber(
    rawMax,
    XHS_COLLECT_INTERVAL_MIN_MS,
    XHS_COLLECT_INTERVAL_MAX_MS,
    XHS_COLLECT_INTERVAL_DEFAULT_MAX_MS,
  );
  if (maxMs < minMs) {
    [minMs, maxMs] = [maxMs, minMs];
  }
  return {
    minMs: Math.round(minMs),
    maxMs: Math.round(maxMs),
  };
}

function randomIntBetween(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return low + Math.floor(Math.random() * (high - low + 1));
}

async function sleepXhsCollectInterval(interval) {
  const waitMs = randomIntBetween(interval.minMs, interval.maxMs);
  await sleep(waitMs);
  return waitMs;
}

function formatXhsCollectInterval(interval) {
  const minSeconds = (interval.minMs / 1000).toFixed(interval.minMs % 1000 === 0 ? 0 : 1);
  const maxSeconds = (interval.maxMs / 1000).toFixed(interval.maxMs % 1000 === 0 ? 0 : 1);
  return minSeconds === maxSeconds ? `${minSeconds} 秒` : `${minSeconds}-${maxSeconds} 秒`;
}

function sanitizeFilenamePart(value, fallback = 'redbox') {
  const text = normalizeText(value)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return text || fallback;
}

function inferDownloadExtension(url, mediaType) {
  const raw = normalizeText(url);
  if (raw.startsWith('data:')) {
    const mime = raw.slice(5, raw.indexOf(';') > 0 ? raw.indexOf(';') : raw.indexOf(','));
    const map = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
    };
    return map[mime] || (mediaType === 'video' ? 'mp4' : 'jpg');
  }

  try {
    const parsed = new URL(raw);
    const match = parsed.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  } catch {
    // fall through
  }
  return mediaType === 'video' ? 'mp4' : 'jpg';
}

function buildXhsDownloadItems(payload) {
  const title = sanitizeFilenamePart(payload?.title || payload?.noteId || 'xhs-note', 'xhs-note');
  const noteId = sanitizeFilenamePart(payload?.noteId || hashString(payload?.source || title), 'note');
  const items = [];
  const seen = new Set();

  function pushItem(type, source, index) {
    const url = normalizeText(source);
    if (!url || seen.has(url)) return;
    if (!isDirectResourceSource(url)) return;
    seen.add(url);
    const ext = inferDownloadExtension(url, type);
    items.push({
      type,
      url,
      filename: `RedBox/xhs/${noteId}-${title}-${String(index).padStart(2, '0')}.${ext}`,
    });
  }

  const videoUrl = normalizeText(payload?.videoDataUrl) || normalizeText(payload?.videoUrl);
  if (videoUrl) {
    pushItem('video', videoUrl, 1);
  }
  const images = Array.isArray(payload?.images) ? payload.images : [];
  images.forEach((imageUrl, index) => pushItem('image', imageUrl, index + 1));
  if (!videoUrl && payload?.coverUrl && images.length === 0) {
    pushItem('image', payload.coverUrl, 1);
  }
  return items;
}

function downloadBrowserFile(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || '下载失败'));
        return;
      }
      resolve(downloadId);
    });
  });
}

async function downloadXhsMediaFromTab(tabId) {
  const payload = await runExtraction(tabId, extractXhsNotePayload, { world: 'MAIN' });
  const items = buildXhsDownloadItems(payload);
  if (items.length === 0) {
    throw new Error('当前小红书页面未识别到可下载的图片或视频素材');
  }

  const downloads = [];
  const failures = [];
  for (const item of items) {
    try {
      const downloadId = await downloadBrowserFile(item.url, item.filename);
      downloads.push({ ...item, downloadId });
    } catch (error) {
      failures.push({
        filename: item.filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await appendXhsTaskHistory({
    id: `xhs-download-${hashString(`${payload?.source || ''}-${Date.now()}`)}`,
    type: 'download',
    title: `下载素材：${normalizeText(payload?.title) || '小红书笔记'}`,
    status: failures.length > 0 ? 'partial' : 'completed',
    count: downloads.length,
    failed: failures.length,
    summary: `已创建 ${downloads.length} 个下载任务${failures.length ? `，失败 ${failures.length} 个` : ''}`,
    payload: {
      source: payload?.source || '',
      noteId: payload?.noteId || '',
      downloads,
      failures,
    },
  });

  return {
    success: failures.length === 0,
    mode: 'xhs-download',
    downloads,
    failures,
    count: downloads.length,
    error: failures.length > 0 ? `部分素材下载失败：${failures.length} 个` : undefined,
  };
}

async function collectXhsCommentsFromTab(tabId) {
  const payload = await runExtraction(tabId, extractXhsCommentsPayload, { world: 'MAIN' });
  const comments = Array.isArray(payload?.comments) ? payload.comments : [];
  if (comments.length === 0) {
    throw new Error('当前页面未采集到评论，请先打开笔记详情并滚动到评论区');
  }
  const response = await postKnowledgeEntry(buildXhsCommentsEntry(payload));
  const historyItem = await appendXhsTaskHistory({
    id: `xhs-comments-${hashString(`${payload?.source || ''}-${Date.now()}`)}`,
    type: 'comments',
    title: `评论采集：${normalizeText(payload?.title) || '小红书笔记'}`,
    status: 'completed',
    count: comments.length,
    summary: `已采集 ${comments.length} 条评论并写入知识库`,
    payload: {
      source: payload?.source || '',
      noteId: payload?.noteId || '',
      entryId: response.entryId || '',
    },
  });
  return {
    success: true,
    mode: 'xhs-comments',
    count: comments.length,
    noteId: response.entryId || '',
    duplicate: Boolean(response.duplicate),
    task: historyItem,
  };
}

async function collectXhsBloggerFromTab(tabId) {
  const payload = await runExtraction(tabId, extractXhsBloggerPayload, { world: 'MAIN' });
  if (!payload?.userId && !payload?.nickname) {
    throw new Error('当前页面未识别到小红书博主信息');
  }
  const response = await postKnowledgeEntry(buildXhsBloggerEntry(payload));
  const historyItem = await appendXhsTaskHistory({
    id: `xhs-blogger-${hashString(`${payload?.source || ''}-${Date.now()}`)}`,
    type: 'blogger',
    title: `博主采集：${normalizeText(payload?.nickname) || payload?.userId || '小红书博主'}`,
    status: 'completed',
    count: 1,
    summary: `已采集博主资料${response?.entryId ? `：${response.entryId}` : ''}`,
    payload: {
      source: payload?.source || '',
      userId: payload?.userId || '',
      entryId: response.entryId || '',
    },
  });
  return {
    success: true,
    mode: 'xhs-blogger',
    noteId: response.entryId || '',
    duplicate: Boolean(response.duplicate),
    task: historyItem,
  };
}

async function collectXhsBloggerNotesFromTab(tabId, options = {}) {
  const settings = await readPluginSettings();
  const limit = Math.max(1, Math.min(Number(options?.limit || settings.xhsBloggerNoteLimit), 200));
  const payload = await runExtraction(tabId, extractXhsBloggerNotesPayload, {
    world: 'MAIN',
    args: [limit, normalizeText(options?.mode) || 'auto'],
  });
  const urls = Array.from(new Set(Array.isArray(payload?.urls)
    ? payload.urls.map((url) => normalizeText(url)).filter(Boolean)
    : []));
  if (urls.length === 0) {
    const reason = normalizeText(payload?.apiError);
    throw new Error(reason || '当前博主页未识别到可采集的笔记，请确认已登录并滚动加载主页笔记');
  }
  const titleName = normalizeText(payload?.nickname) || normalizeText(payload?.userId) || '小红书博主';
  const response = await collectXhsNoteLinks(urls, {
    ...options,
    limit: urls.length,
    taskType: 'blogger-notes',
    taskTitle: `博主笔记采集：${titleName}`,
  });
  return {
    ...response,
    mode: 'xhs-blogger-notes',
    blogger: {
      userId: normalizeText(payload?.userId),
      nickname: titleName,
      source: normalizeText(payload?.source),
      noteCount: Number(payload?.noteCount || 0),
      collectedUrlCount: urls.length,
      apiError: normalizeText(payload?.apiError),
      collectionMode: normalizeText(payload?.collectionMode),
    },
  };
}

function normalizeXhsCollectUrls(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '').split(/\r?\n|,|\s+/);
  return Array.from(new Set(values
    .map((item) => normalizeText(item))
    .filter((item) => isHttpUrl(item) && /xiaohongshu\.com|rednote\.com/i.test(item))));
}

async function waitForTabComplete(tabId, timeoutMs = 18000) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (current?.status === 'complete') return true;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(value);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function collectXhsNoteLinks(urlsInput, options = {}) {
  const settings = await readPluginSettings();
  const urls = normalizeXhsCollectUrls(urlsInput);
  if (urls.length === 0) {
    throw new Error('请先输入可访问的小红书笔记链接');
  }

  const limit = Math.max(1, Math.min(Number(options?.limit || settings.xhsLinkBatchLimit || urls.length), 50));
  const shouldSave = options?.saveToRedBox !== false;
  const interval = normalizeXhsCollectInterval(options?.interval || intervalOptionsFromSettings(settings));
  const results = [];
  const failures = [];

  const targetUrls = urls.slice(0, limit);
  for (let index = 0; index < targetUrls.length; index += 1) {
    const url = targetUrls[index];
    let tab = null;
    let intervalMs = 0;
    try {
      if (index > 0) {
        intervalMs = await sleepXhsCollectInterval(interval);
      }
      tab = await chrome.tabs.create({ url, active: false });
      await waitForTabComplete(tab.id);
      if (index === 0) {
        intervalMs = await sleepXhsCollectInterval(interval);
      } else {
        await sleep(Math.min(1200, Math.max(600, Math.floor(interval.minMs / 2))));
      }
      const payload = await runExtraction(tab.id, extractXhsNotePayload, { world: 'MAIN' });
      if (!payload?.title && !payload?.content && !payload?.images?.length && !payload?.videoUrl) {
        throw new Error('未识别到笔记内容');
      }
      const response = shouldSave ? await postKnowledgeEntry(buildXhsEntry(payload)) : null;
      results.push({
        url,
        title: normalizeText(payload?.title) || url,
        noteId: payload?.noteId || '',
        entryId: response?.entryId || '',
        duplicate: Boolean(response?.duplicate),
        intervalMs,
      });
    } catch (error) {
      failures.push({
        url,
        error: error instanceof Error ? error.message : String(error),
        intervalMs,
      });
    } finally {
      if (tab?.id) {
        await chrome.tabs.remove(tab.id).catch(() => {});
      }
    }
  }

  const historyItem = await appendXhsTaskHistory({
    id: `xhs-link-batch-${hashString(`${urls.join('\n')}-${Date.now()}`)}`,
    type: normalizeText(options?.taskType) || 'batch-links',
    title: normalizeText(options?.taskTitle) || '链接批量采集',
    status: failures.length > 0 ? (results.length > 0 ? 'partial' : 'failed') : 'completed',
    count: results.length,
    failed: failures.length,
    summary: `成功 ${results.length} 条，失败 ${failures.length} 条；采集间隔 ${formatXhsCollectInterval(interval)}`,
    payload: { results, failures, interval },
  });

  return {
    success: true,
    mode: 'xhs-link-batch',
    completed: failures.length === 0,
    count: results.length,
    failed: failures.length,
    results,
    failures,
    interval,
    task: historyItem,
    error: failures.length > 0 ? `批量采集完成，但有 ${failures.length} 条失败` : undefined,
  };
}

async function collectVisibleXhsNoteLinksFromTab(tabId, options = {}) {
  const payload = await runExtraction(tabId, extractXhsVisibleNoteLinksPayload, { world: 'MAIN' });
  const urls = Array.isArray(payload?.urls) ? payload.urls : [];
  if (urls.length === 0) {
    throw new Error('当前小红书页面未识别到可批量采集的笔记链接');
  }
  return await collectXhsNoteLinks(urls, {
    ...options,
    taskType: normalizeText(options?.taskType) || 'visible-links',
    taskTitle: normalizeText(options?.taskTitle) || `当前页批量采集：${normalizeText(payload?.title) || '小红书页面'}`,
  });
}

async function scrollXhsSearchTab(tabId, limit) {
  await runExtraction(tabId, async (maxRounds) => {
    const rounds = Math.max(2, Math.min(Number(maxRounds || 4), 12));
    for (let index = 0; index < rounds; index += 1) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }, { world: 'MAIN', args: [Math.ceil(Math.max(1, limit) / 8)] }).catch(() => {});
}

async function collectXhsKeyword(keywordInput, options = {}) {
  const settings = await readPluginSettings();
  const keyword = normalizeText(keywordInput);
  if (!keyword) {
    throw new Error('请先输入小红书搜索关键词');
  }
  const limit = Math.max(1, Math.min(Number(options?.limit || settings.xhsKeywordNoteLimit), 50));
  const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`;
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: searchUrl, active: false });
    await waitForTabComplete(tab.id);
    await sleep(1600);
    await scrollXhsSearchTab(tab.id, limit);
    const payload = await runExtraction(tab.id, extractXhsVisibleNoteLinksPayload, { world: 'MAIN' });
    const urls = Array.isArray(payload?.urls) ? payload.urls.slice(0, limit) : [];
    if (urls.length === 0) {
      throw new Error('当前关键词搜索结果中未识别到笔记链接');
    }
    return await collectXhsNoteLinks(urls, {
      ...options,
      limit,
      taskType: 'keyword',
      taskTitle: `关键词采集：${keyword}`,
    });
  } finally {
    if (tab?.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

async function exportCurrentXhsNoteJson(tabId) {
  const payload = await runExtraction(tabId, extractXhsNotePayload, { world: 'MAIN' });
  const title = sanitizeFilenamePart(payload?.title || payload?.noteId || 'xhs-note', 'xhs-note');
  const noteId = sanitizeFilenamePart(payload?.noteId || hashString(payload?.source || title), 'note');
  const json = JSON.stringify(payload, null, 2);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  const filename = `RedBox/xhs/${noteId}-${title}.json`;
  const downloadId = await downloadBrowserFile(dataUrl, filename);
  await appendXhsTaskHistory({
    id: `xhs-export-${hashString(`${payload?.source || ''}-${Date.now()}`)}`,
    type: 'export',
    title: `导出 JSON：${normalizeText(payload?.title) || '小红书笔记'}`,
    status: 'completed',
    count: 1,
    summary: filename,
    payload: { source: payload?.source || '', downloadId, filename },
  });
  return { success: true, mode: 'xhs-export-json', downloadId, filename };
}

async function saveDouyinVideoFromTab(tabId) {
  const payload = await runExtraction(tabId, extractDouyinVideoPayload, { world: 'MAIN' });
  console.log('[redbox-plugin][douyin] payload', {
    title: payload?.title || '',
    hasCoverUrl: Boolean(payload?.coverUrl || payload?.coverDataUrl),
    videoUrl: String(payload?.videoUrl || ''),
    hasVideoDataUrl: Boolean(payload?.videoDataUrl),
  });
  const response = await postKnowledgeEntry(buildDouyinEntry(payload));
  return {
    success: true,
    mode: 'douyin',
    noteId: response.entryId || '',
    duplicate: Boolean(response.duplicate),
  };
}

async function saveSocialPlatformFromTab(tabId, platformHint = '') {
  const payload = await runExtraction(tabId, extractSocialPlatformPayload, {
    world: 'MAIN',
    args: [platformHint],
  });
  if (!payload || typeof payload !== 'object') {
    throw new Error('当前页面内容提取失败，请刷新页面后重试');
  }
  if (!payload.title && !payload.text && !payload.coverUrl && !payload.videoUrl) {
    throw new Error('当前页面未识别到可保存的平台内容');
  }
  const response = await postKnowledgeEntry(buildSocialPlatformEntry(payload));
  return {
    success: true,
    mode: payload.mode || `${payload.platform || platformHint || 'social'}-${payload.contentType || 'page'}`,
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
    || /(^|\.)douyin\.com$/i.test(extractDomainFromUrl(tabUrl))
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
  const inlineAssetMaxBytes = 6 * 1024 * 1024;

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

  function toAbsoluteUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return raw;
    }
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
    const url = toAbsoluteUrl(value);
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

  function getAuthorProfileUrl(root) {
    const candidates = [
      root.querySelector('.author a[href*="/user/"]'),
      root.querySelector('.author-wrapper a[href*="/user/"]'),
      root.querySelector('a[href*="/user/"]'),
      document.querySelector('.author a[href*="/user/"]'),
      document.querySelector('a[href*="/user/"]'),
    ];
    for (const candidate of candidates) {
      const href = toAbsoluteUrl(candidate?.getAttribute?.('href') || '');
      if (href) return href;
    }
    return '';
  }

  function getCurrentNoteImgEls(root) {
    const swiperSlides = getCurrentNoteSwiperSlides(root)
      .filter((slide) => !isDuplicateSwiperSlide(slide))
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
    const swiperImgs = swiperSlides
      .map(({ slide }) => slide.querySelector('img'))
      .filter((img) => isValidNoteImageElement(img));
    if (swiperImgs.length > 0) {
      return swiperImgs;
    }

    const els = root
      ? Array.from(root.querySelectorAll('.img-container img, .note-content .img-container img, .swiper-slide img'))
      : Array.from(document.querySelectorAll('.note-content .img-container img, .img-container img, .swiper-slide img'));
    return els.filter((img) => isValidNoteImageElement(img));
  }

  function isDuplicateSwiperSlide(node) {
    return Boolean(node?.classList?.contains('swiper-slide-duplicate'));
  }

  function getCurrentNoteSwiperSlides(root) {
    const slides = root
      ? Array.from(root.querySelectorAll('.note-slider .swiper-slide, .swiper .swiper-slide'))
      : Array.from(document.querySelectorAll('#noteContainer .note-slider .swiper-slide, #noteContainer .swiper .swiper-slide, .note-container .note-slider .swiper-slide, .note-container .swiper .swiper-slide'));
    return slides.filter((slide) => !isCommentRelatedNode(slide));
  }

  function getNoteImageSrc(img) {
    return String(img?.getAttribute('src') || img?.getAttribute('data-src') || img?.currentSrc || '').trim();
  }

  function isValidNoteImageElement(img) {
    if (!img) return false;
    if (isCommentRelatedNode(img)) return false;
    if (img.closest('.avatar,[class*="avatar"]')) return false;
    if (img.closest('.swiper-slide-duplicate')) return false;
    return /^https?:\/\//i.test(getNoteImageSrc(img));
  }

  function getCurrentOriginalCoverImageUrl(root) {
    const swiperSlides = getCurrentNoteSwiperSlides(root).filter((slide) => !isDuplicateSwiperSlide(slide));
    const originalSlide = swiperSlides.find((slide) => String(slide.getAttribute('data-swiper-slide-index') || '').trim() === '0');
    const activeSlide = swiperSlides.find((slide) => slide.classList.contains('swiper-slide-active'));
    const fallbackSlide = swiperSlides[0] || null;
    const coverImg = originalSlide?.querySelector('img')
      || activeSlide?.querySelector('img')
      || fallbackSlide?.querySelector('img')
      || null;
    return isValidNoteImageElement(coverImg) ? getNoteImageSrc(coverImg) : null;
  }

  function parseCssBackgroundImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === 'none') return '';
    const match = raw.match(/url\((['"]?)(.*?)\1\)/i);
    return toAbsoluteUrl(match?.[2] || '');
  }

  function getElementBackgroundImageUrl(el) {
    if (!el) return '';
    const inlineUrl = parseCssBackgroundImageUrl(el.style?.backgroundImage || '');
    if (inlineUrl) return inlineUrl;
    try {
      return parseCssBackgroundImageUrl(window.getComputedStyle(el).backgroundImage);
    } catch {
      return '';
    }
  }

  function collectStateCoverUrls(stateNote) {
    const urls = [];
    const cover = stateNote?.cover || stateNote?.noteCard?.cover || null;
    const imageList = Array.isArray(stateNote?.imageList)
      ? stateNote.imageList
      : Array.isArray(stateNote?.images)
        ? stateNote.images
        : [];
    const coverInfoList = Array.isArray(cover?.infoList) ? cover.infoList : [];

    const pushCoverCandidate = (item) => {
      if (!item) return;
      if (typeof item === 'string') {
        pushUniqueUrl(urls, item);
        return;
      }
      pushUniqueUrl(urls, item?.urlDefault);
      pushUniqueUrl(urls, item?.urlPre);
      pushUniqueUrl(urls, item?.url);
      pushUniqueUrl(urls, item?.urlDefaultWebp);
      pushUniqueUrl(urls, item?.masterUrl);
      pushUniqueUrl(urls, item?.src);
    };

    pushCoverCandidate(cover?.urlDefault);
    pushCoverCandidate(cover?.urlPre);
    pushCoverCandidate(cover?.url);
    pushCoverCandidate(cover?.urlDefaultWebp);
    coverInfoList.forEach(pushCoverCandidate);
    imageList.forEach(pushCoverCandidate);

    return urls;
  }

  function getCurrentFeedCardCoverUrl(noteId) {
    const stableNoteId = String(noteId || '').trim();
    if (!stableNoteId) return '';

    const selectors = [
      `#exploreFeeds .note-item a.cover[href*="/explore/${stableNoteId}"] img`,
      `#exploreFeeds .note-item a.cover[href*="${stableNoteId}"] img`,
      `.feeds-container .note-item a.cover[href*="/explore/${stableNoteId}"] img`,
      `.feeds-container .note-item a.cover[href*="${stableNoteId}"] img`,
    ];

    for (const selector of selectors) {
      const img = document.querySelector(selector);
      const src = getNoteImageSrc(img);
      if (/^https?:\/\//i.test(src)) {
        return src;
      }
    }

    return '';
  }

  function getCurrentVideoPosterUrl(root, stateNote) {
    const mainVideo = getCurrentMainVideoElement(root);
    const directPoster = toAbsoluteUrl(
      mainVideo?.getAttribute('poster')
      || root?.querySelector?.('video')?.getAttribute?.('poster')
      || '',
    );
    if (/^https?:\/\//i.test(directPoster)) return directPoster;

    const posterEls = Array.from(root?.querySelectorAll?.('xg-poster.xgplayer-poster, .xgplayer xg-poster, .xgplayer-poster') || [])
      .filter((el) => !isCommentRelatedNode(el));
    const activePoster = posterEls.find((el) => el.classList?.contains?.('active') || isNodeVisible(el)) || posterEls[0] || null;
    const playerPoster = getElementBackgroundImageUrl(activePoster);
    if (/^https?:\/\//i.test(playerPoster)) return playerPoster;

    const feedCardPoster = getCurrentFeedCardCoverUrl(
      stateNote?.noteId
      || stateNote?.id
      || stateNote?.note_id
      || getCurrentOpenedNoteId(),
    );
    if (feedCardPoster) return feedCardPoster;

    const stateCoverUrl = collectStateCoverUrls(stateNote)[0] || '';
    if (stateCoverUrl) return stateCoverUrl;

    return '';
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
      pushUniqueUrl(urls, getNoteImageSrc(img));
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

  function getCurrentNoteVideoElements(root) {
    if (!root) return [];
    const candidates = Array.from(root.querySelectorAll('video, video[mediatype="video"], .xgplayer video'));
    const seen = new Set();
    const unique = [];
    candidates.forEach((el, index) => {
      if (isCommentRelatedNode(el)) return;
      const src = String(el.currentSrc || el.getAttribute('src') || '').trim();
      const poster = String(el.getAttribute('poster') || '').trim();
      const key = src || poster || `video-index-${index}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(el);
    });
    return unique;
  }

  function parseDurationTextToSeconds(value) {
    const raw = String(value || '').trim();
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
    parts.forEach((part) => {
      seconds = (seconds * 60) + part;
    });
    return seconds > 0 ? seconds : null;
  }

  function getStateVideoDurationSeconds(stateNote) {
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

  function getNoteVideoDurationSeconds(videoEl, root, stateNote) {
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

    return getStateVideoDurationSeconds(stateNote);
  }

  function resolveXhsNoteType(root, stateNote) {
    if (isLivePhotoNote(root)) {
      return 'image';
    }

    const videoElements = getCurrentNoteVideoElements(root);
    const hasStateVideo = Boolean(stateNote?.video);
    const videoCount = Math.max(videoElements.length, hasStateVideo ? 1 : 0);
    if (videoCount !== 1) {
      return 'image';
    }

    const mainVideo = getCurrentMainVideoElement(root) || videoElements[0] || null;
    const durationSeconds = getNoteVideoDurationSeconds(mainVideo, root, stateNote);
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
      const videoEl = getCurrentMainVideoElement(root);
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

  function getCoverUrl(root, images, noteType, stateNote) {
    if (noteType === 'video') {
      const poster = getCurrentVideoPosterUrl(root, stateNote);
      if (poster) return poster;
    }
    const originalCover = getCurrentOriginalCoverImageUrl(root);
    if (originalCover) return originalCover;
    const stateCoverUrl = collectStateCoverUrls(stateNote)[0] || '';
    if (stateCoverUrl) return stateCoverUrl;
    if (images[0]) return images[0];
    return toAbsoluteUrl(document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '') || null;
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

  async function fetchBinaryAsDataUrl(url, options = {}) {
    const target = String(url || '').trim();
    if (!target) return '';
    if (/^data:/i.test(target)) return target;
    if (!/^https?:\/\//i.test(target) && !/^blob:/i.test(target)) return '';
    if (/^https?:\/\//i.test(target) && options.http !== true) return '';
    try {
      const response = await fetch(target, {
        credentials: /^https?:\/\//i.test(target) ? 'omit' : 'same-origin',
        cache: 'force-cache',
      });
      if (!response.ok) return '';
      const blob = await response.blob();
      if (!blob || !blob.size) return '';
      if (blob.size > (options.maxBytes || inlineAssetMaxBytes)) return '';
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
  const noteType = resolveXhsNoteType(root, stateNote);
  const videoCandidates = noteType === 'video' ? getCurrentNoteVideoUrls(root, stateNote) : [];
  const videoUrl = noteType === 'video' ? (videoCandidates[0] || null) : null;
  const coverUrl = getCoverUrl(root, images, noteType, stateNote);
  const capturedVideoCover = (!coverUrl && videoUrl) ? captureVideoCoverDataUrl(root) : '';

  const localizedImages = images.map((imageUrl) => String(imageUrl || '').trim()).filter(Boolean);

  const localizedCoverUrl = coverUrl
    ? (await fetchBinaryAsDataUrl(coverUrl)) || coverUrl
    : (capturedVideoCover || '');
  const localizedVideoDataUrl = videoUrl && String(videoUrl).startsWith('blob:')
    ? (await fetchBinaryAsDataUrl(videoUrl, { maxBytes: inlineAssetMaxBytes }))
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
    noteType,
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
    authorProfileUrl: getAuthorProfileUrl(root),
  };
}

async function extractXhsCommentsPayload() {
  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeBlockText(value) {
    return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function parseCountText(value) {
    const text = normalizeText(value).replace(/[\s,]/g, '').replace(/[^0-9.\u4e00-\u9fa5.]/g, '');
    if (!text) return 0;
    if (text.includes('万')) {
      const number = parseFloat(text.replace('万', ''));
      return Number.isNaN(number) ? 0 : Math.round(number * 10000);
    }
    if (text.includes('亿')) {
      const number = parseFloat(text.replace('亿', ''));
      return Number.isNaN(number) ? 0 : Math.round(number * 100000000);
    }
    const number = parseFloat(text);
    return Number.isNaN(number) ? 0 : Math.round(number);
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

  function getCurrentNoteId() {
    const mask = document.querySelector('.note-detail-mask[note-id]');
    if (mask?.getAttribute('note-id')) return normalizeText(mask.getAttribute('note-id'));
    const state = getInitialState();
    const detailMap = state?.note?.noteDetailMap || {};
    const keys = Object.keys(detailMap);
    if (keys.length === 1) {
      const note = detailMap[keys[0]]?.note || detailMap[keys[0]];
      return normalizeText(note?.noteId || note?.id || keys[0]);
    }
    const pathPart = location.pathname.split('/').filter(Boolean).pop() || '';
    return normalizeText(new URLSearchParams(location.search).get('noteId') || pathPart);
  }

  function getTitle() {
    return normalizeText(
      document.querySelector('#detail-title')?.textContent ||
      document.querySelector('.note-content .title')?.textContent ||
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      document.title ||
      '小红书笔记',
    );
  }

  function getCoverUrl() {
    return normalizeText(
      document.querySelector('.note-slider .swiper-slide:not(.swiper-slide-duplicate) img')?.getAttribute('src') ||
      document.querySelector('.note-content img')?.getAttribute('src') ||
      document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      '',
    );
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 20 && rect.height > 10;
  }

  async function expandVisibleComments() {
    const buttons = Array.from(document.querySelectorAll('button, .show-more, .more, [role="button"], span, div'))
      .filter((el) => isVisible(el))
      .filter((el) => /展开|更多|全部回复|条回复|查看更多/i.test(normalizeText(el.textContent)))
      .slice(0, 18);
    for (const button of buttons) {
      try {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await new Promise((resolve) => setTimeout(resolve, 90));
      } catch {
        // ignore protected synthetic click failures
      }
    }
  }

  function pickCommentText(node) {
    const selectors = [
      '.content',
      '.comment-content',
      '.note-text',
      '[class*="content"]',
    ];
    for (const selector of selectors) {
      const candidate = normalizeBlockText(node.querySelector(selector)?.innerText || node.querySelector(selector)?.textContent || '');
      if (candidate && candidate.length > 2) return candidate;
    }
    return normalizeBlockText(node.innerText || node.textContent || '');
  }

  function pickAuthor(node) {
    const selectors = [
      '.author .name',
      '.user-name',
      '.username',
      '.name',
      'a[href*="/user/profile"]',
      '[class*="author"]',
      '[class*="name"]',
    ];
    for (const selector of selectors) {
      const text = normalizeText(node.querySelector(selector)?.textContent || '');
      if (text && text.length <= 32 && !/赞|回复|展开|更多/.test(text)) return text;
    }
    return '';
  }

  function pickMeta(node) {
    const text = normalizeText(node.innerText || node.textContent || '');
    const createdAt = (text.match(/\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2}|昨天|今天|刚刚|\d+\s*(分钟|小时|天)前/) || [])[0] || '';
    const location = (text.match(/IP属地[:：]?\s*[\u4e00-\u9fa5A-Za-z]+/) || [])[0] || '';
    const likeText = normalizeText(
      node.querySelector('.like-wrapper .count')?.textContent ||
      node.querySelector('[class*="like"] [class*="count"]')?.textContent ||
      '',
    );
    return { createdAt, location, likes: parseCountText(likeText) };
  }

  await expandVisibleComments();

  const candidateNodes = Array.from(document.querySelectorAll(
    '.comment-item, .comment-container, .parent-comment, .comments-el .list-item, [class*="comment-item"], [class*="commentItem"]',
  )).filter((node) => node instanceof Element && isVisible(node));
  const seen = new Set();
  const comments = [];
  for (const node of candidateNodes) {
    const author = pickAuthor(node);
    const rawText = pickCommentText(node);
    const text = rawText
      .split('\n')
      .map((line) => normalizeText(line))
      .filter(Boolean)
      .filter((line) => !/^(赞|回复|展开|更多|举报)$/.test(line))
      .join('\n');
    if (!text || text.length < 2) continue;
    const key = `${author}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    comments.push({
      author,
      text,
      ...pickMeta(node),
    });
    if (comments.length >= 200) break;
  }

  return {
    noteId: getCurrentNoteId(),
    title: getTitle(),
    coverUrl: getCoverUrl(),
    source: location.href,
    comments,
  };
}

function extractXhsBloggerPayload() {
  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function parseCountText(value) {
    const text = normalizeText(value).replace(/[\s,]/g, '').replace(/[^0-9.\u4e00-\u9fa5.]/g, '');
    if (!text) return 0;
    if (text.includes('万')) {
      const number = parseFloat(text.replace('万', ''));
      return Number.isNaN(number) ? 0 : Math.round(number * 10000);
    }
    if (text.includes('亿')) {
      const number = parseFloat(text.replace('亿', ''));
      return Number.isNaN(number) ? 0 : Math.round(number * 100000000);
    }
    const number = parseFloat(text);
    return Number.isNaN(number) ? 0 : Math.round(number);
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

  function unwrapValue(value) {
    if (!value || typeof value !== 'object') return value;
    if (value._rawValue && typeof value._rawValue === 'object') return value._rawValue;
    if (value.value && typeof value.value === 'object') return value.value;
    return value;
  }

  function pickImageUrl(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const url = pickImageUrl(item);
        if (url) return url;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    return normalizeText(
      value.urlDefault ||
      value.urlPre ||
      value.url ||
      value.urlDefaultWebp ||
      value.src ||
      value.link ||
      '',
    );
  }

  const userId = normalizeText(location.pathname.split('/').filter(Boolean).pop() || '');
  const initialState = getInitialState();
  const stateUser = unwrapValue(initialState?.user?.userPageData)
    || unwrapValue(initialState?.user?.profile)
    || unwrapValue(initialState?.user?.userInfo)
    || {};
  const profileRoot =
    document.querySelector('.user-page')
    || document.querySelector('.user-info')
    || document.querySelector('[class*="user-info"]')
    || document.querySelector('[class*="profile"]')
    || document.body;
  const nickname = normalizeText(
    stateUser.nickname ||
    stateUser.nickName ||
    stateUser.name ||
    document.querySelector('.user-name')?.textContent ||
    document.querySelector('[class*="user-name"]')?.textContent ||
    document.querySelector('[class*="nickname"]')?.textContent ||
    profileRoot.querySelector('h1, h2')?.textContent ||
    document.title.replace(/小红书.*/i, ''),
  );
  const description = normalizeText(
    stateUser.desc ||
    stateUser.description ||
    stateUser.userDesc ||
    document.querySelector('.user-desc')?.textContent ||
    document.querySelector('[class*="user-desc"]')?.textContent ||
    document.querySelector('[class*="desc"]')?.textContent ||
    '',
  );
  const avatar = normalizeText(
    pickImageUrl(stateUser.image) ||
    pickImageUrl(stateUser.avatar) ||
    pickImageUrl(stateUser.images) ||
    pickImageUrl(stateUser.imageb) ||
    document.querySelector('.avatar img')?.getAttribute('src') ||
    document.querySelector('[class*="avatar"] img')?.getAttribute('src') ||
    '',
  );
  const text = normalizeText(profileRoot.innerText || profileRoot.textContent || '');
  const fansText = (text.match(/粉丝\s*([0-9.万亿]+)/) || [])[1] || stateUser.fans || stateUser.fansCount || '';
  const followsText = (text.match(/关注\s*([0-9.万亿]+)/) || [])[1] || stateUser.follows || stateUser.followingCount || '';
  const likedText = (text.match(/获赞与收藏\s*([0-9.万亿]+)/) || text.match(/获赞\s*([0-9.万亿]+)/) || [])[1] || stateUser.liked || stateUser.likedCount || '';

  return {
    userId: normalizeText(stateUser.userId || stateUser.user_id || stateUser.redId || stateUser.red_id || userId),
    nickname,
    description,
    avatar,
    stats: {
      fans: parseCountText(fansText),
      follows: parseCountText(followsText),
      liked: parseCountText(likedText),
    },
    source: location.href,
  };
}

async function extractXhsBloggerNotesPayload(limitInput = 50, modeInput = 'auto') {
  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function unwrapValue(value) {
    if (!value || typeof value !== 'object') return value;
    if (value._rawValue && typeof value._rawValue === 'object') return value._rawValue;
    if (value.value && typeof value.value === 'object') return value.value;
    return value;
  }

  function pickImageUrl(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const url = pickImageUrl(item);
        if (url) return url;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    return normalizeText(
      value.urlDefault ||
      value.urlPre ||
      value.url ||
      value.url_default ||
      value.url_pre ||
      value.src ||
      '',
    );
  }

  function readInitialState() {
    const direct = window.__INITIAL_STATE__;
    if (direct && typeof direct === 'object') return direct;
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

  function getProfile(initialState) {
    const raw = unwrapValue(initialState?.user?.userPageData)
      || unwrapValue(initialState?.user?.profile)
      || unwrapValue(initialState?.user?.userInfo)
      || {};
    const pathUserId = normalizeText(location.pathname.split('/').filter(Boolean).pop() || '');
    const basic = raw.basic_info || raw.basicInfo || raw;
    const interactions = Array.isArray(raw.interactions) ? raw.interactions : [];
    const noteCountItem = interactions.find((item) => /note|笔记/i.test(String(item?.type || item?.name || item?.label || '')));
    return {
      userId: normalizeText(raw.userId || raw.user_id || raw.id || basic.userId || basic.user_id || pathUserId),
      nickname: normalizeText(raw.nickname || raw.nickName || raw.nick_name || basic.nickname || basic.nickName || document.title.replace(/小红书.*/i, '')),
      redId: normalizeText(raw.redId || raw.red_id || basic.redId || basic.red_id),
      avatar: pickImageUrl(raw.image || raw.avatar || basic.image || basic.avatar),
      noteCount: Number(raw.noteCount || raw.note_count || basic.noteCount || basic.note_count || noteCountItem?.count || 0) || 0,
    };
  }

  function getStateNotes(initialState) {
    const rawNotes = unwrapValue(initialState?.user?.notes);
    const groups = Array.isArray(rawNotes) ? rawNotes : [];
    const flattened = [];
    for (const group of groups) {
      const value = unwrapValue(group);
      if (Array.isArray(value)) {
        flattened.push(...value);
      } else if (value) {
        flattened.push(value);
      }
    }
    return flattened;
  }

  function buildNoteUrl(note, userId) {
    const noteId = normalizeText(note?.note_id || note?.noteId || note?.id);
    if (!noteId) return '';
    const token = normalizeText(note?.xsec_token || note?.xsecToken || note?.xsecTokenDetail);
    const source = normalizeText(note?.xsec_source || note?.xsecSource) || 'pc_user';
    const url = new URL(`/explore/${noteId}`, location.origin);
    if (token) url.searchParams.set('xsec_token', token);
    if (source) url.searchParams.set('xsec_source', source);
    if (userId && !url.searchParams.get('xsec_source')) url.searchParams.set('xsec_source', 'pc_user');
    return url.toString();
  }

  function normalizeNote(raw, userId) {
    const note = unwrapValue(raw?.noteCard) || unwrapValue(raw?.note_card) || unwrapValue(raw);
    const noteId = normalizeText(note?.note_id || note?.noteId || note?.id);
    const url = buildNoteUrl(note, userId);
    if (!noteId || !url) return null;
    return {
      noteId,
      title: normalizeText(note?.display_title || note?.displayTitle || note?.title),
      type: normalizeText(note?.type),
      coverUrl: pickImageUrl(note?.cover || note?.image || note?.images),
      url,
    };
  }

  function pushNotes(target, rawNotes, userId) {
    const seen = new Set(target.map((item) => item.noteId));
    for (const raw of Array.isArray(rawNotes) ? rawNotes : []) {
      const note = normalizeNote(raw, userId);
      if (!note || seen.has(note.noteId)) continue;
      seen.add(note.noteId);
      target.push(note);
      if (target.length >= limit) break;
    }
  }

  function collectVisibleNoteUrls(notes, userId) {
    const seen = new Set(notes.map((item) => item.url));
    const anchors = Array.from(document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]'));
    for (const anchor of anchors) {
      const raw = anchor.getAttribute('href') || anchor.href || '';
      let parsed;
      try {
        parsed = new URL(raw, location.href);
      } catch {
        continue;
      }
      if (!/xiaohongshu\.com|rednote\.com/i.test(parsed.hostname)) continue;
      const match = parsed.pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
      if (!match?.[1]) continue;
      const note = {
        noteId: match[1],
        title: normalizeText(anchor.querySelector('[class*="title"], .title')?.textContent || anchor.textContent || ''),
        url: (() => {
          const url = new URL(`/explore/${match[1]}`, location.origin);
          const token = parsed.searchParams.get('xsec_token');
          if (token) url.searchParams.set('xsec_token', token);
          url.searchParams.set('xsec_source', parsed.searchParams.get('xsec_source') || 'pc_user');
          return url.toString();
        })(),
      };
      if (seen.has(note.url)) continue;
      seen.add(note.url);
      notes.push(note);
      if (notes.length >= limit) break;
    }
    return notes;
  }

  function collectCapturedPostedNotes(notes, userId) {
    const store = Array.isArray(window.__REDBOX_XHS_RESPONSES__) ? window.__REDBOX_XHS_RESPONSES__ : [];
    for (const record of store.slice().reverse()) {
      let parsed;
      try {
        parsed = new URL(record?.url || '', location.href);
      } catch {
        continue;
      }
      if (parsed.pathname !== '/api/sns/web/v1/user_posted') continue;
      if (parsed.searchParams.get('user_id') && parsed.searchParams.get('user_id') !== userId) continue;
      const data = record?.result?.data || record?.result?.result?.data || record?.result;
      if (Array.isArray(data?.notes)) {
        pushNotes(notes, data.notes, userId);
      }
      if (notes.length >= limit) break;
    }
  }

  async function fetchPostedNotes(userId, pageCursor) {
    const url = new URL('/api/sns/web/v1/user_posted', location.origin);
    url.searchParams.set('user_id', userId);
    url.searchParams.set('cursor', pageCursor || '');
    url.searchParams.set('num', '30');
    url.searchParams.set('image_formats', 'jpg,webp,avif');
    const currentUrl = new URL(location.href);
    const token = currentUrl.searchParams.get('xsec_token');
    const source = currentUrl.searchParams.get('xsec_source');
    if (token) url.searchParams.set('xsec_token', token);
    if (source) url.searchParams.set('xsec_source', source);
    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
      },
    });
    if (!response.ok) {
      throw new Error(`user_posted HTTP ${response.status}`);
    }
    const json = await response.json();
    return json?.data || json?.result?.data || json;
  }

  async function scrollProfile(notes, userId) {
    const rounds = Math.max(2, Math.min(Math.ceil((limit - notes.length) / 8) + 2, 18));
    for (let index = 0; index < rounds && notes.length < limit; index += 1) {
      const sections = Array.from(document.querySelectorAll('#userPostedFeeds>section, [id="userPostedFeeds"] section, .feeds-container section'));
      const target = sections[sections.length - 1] || document.scrollingElement || document.documentElement;
      try {
        target.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
      } catch {
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(850);
      collectVisibleNoteUrls(notes, userId);
      pushNotes(notes, getStateNotes(readInitialState()), userId);
    }
  }

  const limit = Math.max(1, Math.min(Number(limitInput || 50), 200));
  const mode = normalizeText(modeInput) || 'auto';
  const initialState = readInitialState();
  const profile = getProfile(initialState);
  const notes = [];
  let cursor = '';
  let hasMore = true;
  let apiError = '';
  let apiPageCount = 0;

  if (!/^\/user\/profile\//i.test(location.pathname)) {
    throw new Error('当前页面不是小红书博主页');
  }
  if (!profile.userId) {
    throw new Error('未识别到小红书博主 ID');
  }

  pushNotes(notes, getStateNotes(initialState), profile.userId);
  collectCapturedPostedNotes(notes, profile.userId);

  if (mode !== 'rpa') {
    try {
      while (notes.length < limit && hasMore) {
        const data = await fetchPostedNotes(profile.userId, cursor);
        const pageNotes = Array.isArray(data?.notes) ? data.notes : [];
        if (pageNotes.some((item) => !normalizeText(item?.note_id || item?.noteId || item?.id))) {
          throw new Error('数据获取失败，请登录小红书账号后重试');
        }
        pushNotes(notes, pageNotes, profile.userId);
        apiPageCount += 1;
        cursor = normalizeText(data?.cursor);
        hasMore = data?.has_more !== false && data?.hasMore !== false && pageNotes.length > 0;
        if (!cursor && pageNotes.length === 0) break;
        await sleep(280);
      }
    } catch (error) {
      apiError = error instanceof Error ? error.message : String(error);
    }
  }

  if ((mode === 'rpa' || notes.length < Math.min(limit, 12) || apiError) && mode !== 'api') {
    await scrollProfile(notes, profile.userId);
    collectCapturedPostedNotes(notes, profile.userId);
  }

  const urls = notes.slice(0, limit).map((item) => item.url).filter(Boolean);
  return {
    userId: profile.userId,
    nickname: profile.nickname,
    redId: profile.redId,
    avatar: profile.avatar,
    noteCount: profile.noteCount,
    source: location.href,
    collectionMode: apiPageCount > 0 ? 'api' : 'rpa',
    apiError,
    cursor,
    hasMore,
    notes: notes.slice(0, limit),
    urls,
  };
}

function extractXhsVisibleNoteLinksPayload() {
  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
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

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 24 && rect.height > 24;
  }

  function normalizeNoteUrl(value) {
    const url = toAbsoluteUrl(value);
    if (!/^https?:\/\//i.test(url)) return '';
    try {
      const parsed = new URL(url);
      if (!/xiaohongshu\.com|rednote\.com/i.test(parsed.hostname)) return '';
      const noteMatch = parsed.pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
      if (!noteMatch?.[1]) return '';
      return `https://www.xiaohongshu.com/explore/${noteMatch[1]}`;
    } catch {
      return '';
    }
  }

  const seen = new Set();
  const links = [];
  Array.from(document.querySelectorAll('a[href]')).forEach((anchor) => {
    if (!isVisible(anchor)) return;
    const url = normalizeNoteUrl(anchor.getAttribute('href') || anchor.href || '');
    if (!url || seen.has(url)) return;
    seen.add(url);
    const title = normalizeText(
      anchor.querySelector('.title')?.textContent ||
      anchor.querySelector('[class*="title"]')?.textContent ||
      anchor.querySelector('img')?.getAttribute('alt') ||
      anchor.textContent ||
      url,
    );
    links.push({ url, title });
  });

  return {
    title: normalizeText(document.title),
    source: location.href,
    urls: links.map((item) => item.url),
    links,
  };
}

async function extractDouyinVideoPayload() {
  function normalizeText(value) {
    return String(value || '').trim();
  }

  function normalizeTitle(value) {
    return normalizeText(value).replace(/\s*[-|_|]\s*抖音.*$/i, '').trim();
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

  function pushUniqueUrl(list, value) {
    const url = toAbsoluteUrl(value);
    if (!url || list.includes(url)) return;
    list.push(url);
  }

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

  function isNodeVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 40 && rect.height > 40;
  }

  function getMainVideoElement() {
    const candidates = Array.from(document.querySelectorAll('video'));
    if (candidates.length === 0) return null;
    const scored = candidates
      .map((videoEl, index) => {
        const rect = typeof videoEl.getBoundingClientRect === 'function'
          ? videoEl.getBoundingClientRect()
          : { width: 0, height: 0 };
        let score = Math.max(0, rect.width * rect.height);
        if (isNodeVisible(videoEl)) score += 1_000_000;
        if (String(videoEl.currentSrc || videoEl.src || '').trim()) score += 10_000;
        if (String(videoEl.getAttribute('poster') || '').trim()) score += 5_000;
        score -= index;
        return { videoEl, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored[0]?.videoEl || null;
  }

  function collectDeepUrls(input, maxCount = 60) {
    const urls = [];
    const seenObjects = new WeakSet();
    const seenUrls = new Set();

    function walk(value) {
      if (!value || urls.length >= maxCount) return;
      if (typeof value === 'string') {
        const trimmed = toAbsoluteUrl(value);
        if (trimmed && !seenUrls.has(trimmed) && (/^https?:\/\//i.test(trimmed) || /^blob:/i.test(trimmed))) {
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
    if (/^https?:\/\//.test(normalized)) score += 300;
    if (/^blob:/.test(normalized)) score += 80;
    if (/\.mp4(\?|$)/.test(normalized)) score += 220;
    if (/\.m3u8(\?|$)/.test(normalized)) score += 160;
    if (/playwm|play\/|aweme|video|stream|media/.test(normalized)) score += 60;
    if (/douyin|douyinvod|bytecdn|bytetos|tos-cn/.test(normalized)) score += 30;
    return score;
  }

  function getRenderData() {
    const scripts = [
      document.getElementById('RENDER_DATA'),
      ...Array.from(document.querySelectorAll('script[type="application/json"]')),
    ].filter(Boolean);
    for (const script of scripts) {
      const text = normalizeText(script.textContent || '');
      if (!text) continue;
      const candidates = [text];
      try {
        candidates.push(decodeURIComponent(text));
      } catch {
        // ignore decode failures
      }
      for (const candidate of candidates) {
        try {
          return JSON.parse(candidate);
        } catch {
          // ignore parse failures
        }
      }
    }
    return null;
  }

  function getScriptVideoUrls() {
    const urls = [];
    const pattern = /https?:\/\/[^"'\\\s<>]+/g;
    for (const script of Array.from(document.scripts)) {
      const text = String(script.textContent || '');
      if (!text || !/douyin|aweme|douyinvod|bytetos|bytecdn|playwm|video/i.test(text)) continue;
      const matches = text.match(pattern) || [];
      for (const match of matches) {
        if (/(\.mp4|\.m3u8|playwm|play\/|aweme|video)/i.test(match)) {
          pushUniqueUrl(urls, match);
        }
      }
      if (urls.length >= 20) break;
    }
    return urls;
  }

  function getPerformanceMediaUrls() {
    try {
      return performance.getEntriesByType('resource')
        .map((entry) => String(entry?.name || '').trim())
        .filter((url) => /^https?:\/\//i.test(url))
        .filter((url) => /(\.mp4|\.m3u8|playwm|video|aweme|stream)/i.test(url))
        .slice(-30);
    } catch {
      return [];
    }
  }

  function getTitle() {
    const candidates = [
      document.querySelector('[data-e2e="detail-video-info"] h1')?.textContent,
      document.querySelector('[data-e2e="video-desc"]')?.textContent,
      document.querySelector('[data-e2e="feed-active-video-desc"]')?.textContent,
      document.querySelector('[data-e2e="note-desc"]')?.textContent,
      document.querySelector('h1')?.textContent,
      document.querySelector('[class*="title"]')?.textContent,
      document.querySelector('[class*="desc"]')?.textContent,
      document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      document.querySelector('meta[name="description"]')?.getAttribute('content'),
      document.title,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeTitle(candidate);
      if (normalized) return normalized;
    }
    return '';
  }

  function getAuthor() {
    const candidates = [
      document.querySelector('[data-e2e="user-info"] [data-click-from="title"]')?.textContent,
      document.querySelector('[data-e2e="user-info-name"]')?.textContent,
      document.querySelector('[data-e2e="video-author-name"]')?.textContent,
      document.querySelector('[data-e2e="video-author-nickname"]')?.textContent,
      document.querySelector('[data-e2e="feed-author-name"]')?.textContent,
      document.querySelector('a[href*="/user/"] span')?.textContent,
      document.querySelector('meta[name="author"]')?.getAttribute('content'),
    ];
    for (const candidate of candidates) {
      const normalized = normalizeText(candidate).replace(/^@+/, '');
      if (normalized) return normalized;
    }
    return '';
  }

  function getAuthorProfileUrl() {
    const candidates = [
      document.querySelector('[data-e2e="user-info"] a[href*="/user/"]'),
      document.querySelector('a[href*="/user/"]'),
    ];
    for (const candidate of candidates) {
      const href = toAbsoluteUrl(candidate?.getAttribute?.('href') || '');
      if (href) return href;
    }
    return '';
  }

  function extractCountFromContainer(container) {
    if (!container) return 0;
    const candidates = [
      ...Array.from(container.querySelectorAll('span, div, p'))
        .map((node) => normalizeText(node.textContent || ''))
        .filter(Boolean),
      normalizeText(container.textContent || ''),
    ];
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (!/[0-9一二三四五六七八九十百千万亿]/.test(candidate)) continue;
      const parsed = parseCountText(candidate);
      if (parsed > 0) return parsed;
    }
    return 0;
  }

  function getPublishedAt() {
    const candidates = [
      document.querySelector('[data-e2e="detail-video-publish-time"]')?.textContent,
      document.querySelector('[class*="publish-time"]')?.textContent,
      document.querySelector('meta[property="article:published_time"]')?.getAttribute('content'),
    ];
    for (const candidate of candidates) {
      const normalized = normalizeText(candidate).replace(/^发布时间[:：]\s*/, '');
      if (normalized) return normalized;
    }
    return '';
  }

  function getStats() {
    const likeEl = document.querySelector('[data-e2e="video-player-digg"], [data-e2e="like-count"], [data-e2e*="like"]');
    const commentEl = document.querySelector('[data-e2e="feed-comment-icon"], [data-e2e*="comment"]');
    const collectEl = document.querySelector('[data-e2e="video-player-collect"], [data-e2e="collect-count"], [data-e2e*="collect"], [data-e2e*="favorite"]');
    const shareEl = document.querySelector('[data-e2e="video-player-share"], [data-e2e*="share"]');
    return {
      likes: extractCountFromContainer(likeEl),
      comments: extractCountFromContainer(commentEl),
      collects: extractCountFromContainer(collectEl),
      shares: extractCountFromContainer(shareEl),
    };
  }

  function getCommentsSnapshot(limit = 12) {
    const items = Array.from(document.querySelectorAll('[data-e2e="comment-item"]')).slice(0, limit);
    return items.map((item) => {
      const author = normalizeText(
        item.querySelector('.BT7MlqJC a, [data-click-from="title"]')?.textContent || '',
      );
      const text = normalizeText(
        item.querySelector('.C7LroK_h, .WFJiGxr7')?.textContent || '',
      );
      const meta = normalizeText(
        item.querySelector('.fJhvAqos')?.textContent || '',
      );
      const likes = parseCountText(
        item.querySelector('.xZhLomAs span:last-child')?.textContent || '',
      );
      const replies = parseCountText(
        item.querySelector('.comment-reply-expand-btn span')?.textContent || '',
      );
      const [createdAt = '', location = ''] = meta.split('·').map((value) => normalizeText(value));
      return {
        author,
        text,
        likes,
        replies,
        createdAt,
        location,
      };
    }).filter((item) => item.author || item.text);
  }

  function captureVideoCoverDataUrl(videoEl) {
    try {
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
    if (!target) return '';
    if (/^data:/i.test(target)) return target;
    if (!/^https?:\/\//i.test(target) && !/^blob:/i.test(target)) return '';
    try {
      const response = await fetch(target, {
        credentials: /^https?:\/\//i.test(target) ? 'omit' : 'same-origin',
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

  const sourceUrl = location.href;
  const videoEl = getMainVideoElement();
  const renderData = getRenderData();
  const videoCandidates = [];
  pushUniqueUrl(videoCandidates, videoEl?.currentSrc || videoEl?.src || '');
  Array.from(videoEl?.querySelectorAll?.('source') || []).forEach((source) => {
    pushUniqueUrl(videoCandidates, source?.src || '');
  });
  collectDeepUrls(renderData, 80).forEach((url) => {
    if (/(\.mp4|\.m3u8|playwm|play\/|aweme|video)/i.test(url)) {
      pushUniqueUrl(videoCandidates, url);
    }
  });
  getPerformanceMediaUrls().forEach((url) => pushUniqueUrl(videoCandidates, url));
  getScriptVideoUrls().forEach((url) => pushUniqueUrl(videoCandidates, url));
  videoCandidates.sort((a, b) => scoreVideoCandidate(b) - scoreVideoCandidate(a));

  const remoteVideoUrl = videoCandidates.find((url) => /^https?:\/\//i.test(url)) || '';
  const blobVideoUrl = videoCandidates.find((url) => /^blob:/i.test(url)) || '';
  const videoUrl = remoteVideoUrl || blobVideoUrl || '';

  const rawCoverUrl = toAbsoluteUrl(
    videoEl?.getAttribute('poster')
    || document.querySelector('meta[property="og:image"]')?.getAttribute('content')
    || '',
  );
  const coverDataUrl = rawCoverUrl
    ? (await fetchBinaryAsDataUrl(rawCoverUrl)) || ''
    : captureVideoCoverDataUrl(videoEl);
  const videoDataUrl = !remoteVideoUrl && blobVideoUrl
    ? (await fetchBinaryAsDataUrl(blobVideoUrl))
    : '';

  const pathnameSegments = String(location.pathname || '').split('/').filter(Boolean);
  const pathId = pathnameSegments[pathnameSegments.length - 1] || '';
  const detailId = normalizeText(
    document.querySelector('[data-e2e="detail-video-info"]')?.getAttribute('data-e2e-aweme-id') || '',
  );
  const videoId = detailId || normalizeText(pathId) || `douyin-${Date.now()}`;
  const title = getTitle();
  const description = normalizeText(
    document.querySelector('meta[name="description"]')?.getAttribute('content')
    || title,
  );
  const author = getAuthor();
  const publishedAt = getPublishedAt();
  const commentsSnapshot = getCommentsSnapshot();
  const indexText = [
    title,
    description,
    author ? `作者：${author}` : '',
    publishedAt ? `发布时间：${publishedAt}` : '',
    commentsSnapshot.length > 0
      ? `评论快照：\n${commentsSnapshot.map((item, index) => {
          const meta = [
            item.author,
            item.location,
            item.createdAt,
            item.likes ? `赞${item.likes}` : '',
            item.replies ? `回复${item.replies}` : '',
          ].filter(Boolean).join(' · ');
          return `${index + 1}. ${meta}\n${item.text}`;
        }).join('\n\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  return {
    noteId: videoId,
    title,
    author,
    authorProfileUrl: getAuthorProfileUrl(),
    content: description,
    text: description,
    description,
    publishedAt,
    coverUrl: rawCoverUrl || '',
    coverDataUrl,
    videoUrl,
    videoDataUrl: videoDataUrl || '',
    stats: getStats(),
    commentsSnapshot,
    indexText,
    source: sourceUrl,
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

    function getCurrentNoteVideoElements(root) {
      if (!root) return [];
      const candidates = Array.from(root.querySelectorAll('video, video[mediatype="video"], .xgplayer video'));
      const seen = new Set();
      const unique = [];
      candidates.forEach((el, index) => {
        if (isCommentRelatedNode(el)) return;
        const src = (el.currentSrc || el.getAttribute('src') || '').trim();
        const poster = (el.getAttribute('poster') || '').trim();
        const key = src || poster || `video-index-${index}`;
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(el);
      });
      return unique;
    }

    function parseDurationTextToSeconds(value) {
      const raw = String(value || '').trim();
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
      parts.forEach((part) => {
        seconds = (seconds * 60) + part;
      });
      return seconds > 0 ? seconds : null;
    }

    function getStateVideoDurationSeconds(note) {
      const candidates = [
        note?.video?.duration,
        note?.video?.durationSeconds,
        note?.video?.media?.duration,
        note?.video?.media?.durationSeconds,
        note?.video?.durationMs,
        note?.video?.duration_ms,
        note?.video?.media?.durationMs,
        note?.video?.media?.duration_ms,
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

    function getNoteVideoDurationSeconds(videoEl, root, note) {
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

      return getStateVideoDurationSeconds(note);
    }

    function resolveXhsNoteType(root, note) {
      if (isLivePhotoNote(root)) {
        return 'image';
      }

      const videoElements = getCurrentNoteVideoElements(root);
      const hasStateVideo = Boolean(note?.video);
      const videoCount = Math.max(videoElements.length, hasStateVideo ? 1 : 0);
      if (videoCount !== 1) {
        return 'image';
      }

      const mainVideo = getCurrentMainVideoElement(root) || videoElements[0] || null;
      const durationSeconds = getNoteVideoDurationSeconds(mainVideo, root, note);
      if (durationSeconds == null) {
        return 'video';
      }

      return durationSeconds > 2 ? 'video' : 'image';
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

    function isDuplicateSwiperSlide(node) {
      return Boolean(node?.classList?.contains('swiper-slide-duplicate'));
    }

    function getCurrentNoteSwiperSlides(root) {
      return Array.from(root?.querySelectorAll('.note-slider .swiper-slide, .swiper .swiper-slide') || [])
        .filter((slide) => !isCommentRelatedNode(slide));
    }

    function getNoteImageSrc(img) {
      return String(img?.getAttribute('src') || img?.getAttribute('data-src') || img?.currentSrc || '').trim();
    }

    function isValidNoteImageElement(img) {
      if (!img) return false;
      if (isCommentRelatedNode(img)) return false;
      if (img.closest('.avatar,[class*="avatar"]')) return false;
      if (img.closest('.swiper-slide-duplicate')) return false;
      return /^https?:\/\//i.test(getNoteImageSrc(img));
    }

    function getCurrentNoteImageUrls(root, note) {
      const urls = getImageUrlsFromState(note);
      if (urls.length > 0) return urls;
      const swiperSlides = getCurrentNoteSwiperSlides(root)
        .filter((slide) => !isDuplicateSwiperSlide(slide))
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
        ? swiperSlides.map(({ slide }) => slide.querySelector('img')).filter((img) => isValidNoteImageElement(img))
        : Array.from(root?.querySelectorAll('.img-container img, .note-content .img-container img, .swiper-slide img') || [])
          .filter((img) => isValidNoteImageElement(img));
      imgEls.forEach((img) => {
        pushUniqueUrl(urls, getNoteImageSrc(img));
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
    const isVideoNote = Boolean(noteRoot || stateNote) && resolveXhsNoteType(noteRoot, stateNote) === 'video';

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

  if (/(^|\.)douyin\.com$/i.test(hostname)) {
    function isNodeVisible(el) {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 40 && rect.height > 40;
    }

    const pathname = String(location.pathname || '');
    const title = String(
      document.querySelector('[data-e2e="video-desc"]')?.textContent
      || document.querySelector('h1')?.textContent
      || document.querySelector('meta[property="og:title"]')?.getAttribute('content')
      || '',
    ).trim();
    const videoEl = Array.from(document.querySelectorAll('video'))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })
      .find((item) => isNodeVisible(item) || String(item.currentSrc || item.src || '').trim());
    if (pathname.startsWith('/video/') || pathname.startsWith('/note/') || videoEl || title) {
      return {
        kind: 'douyin-video',
        platform: 'douyin',
        action: 'save-douyin',
        label: '保存抖音视频到知识库',
        description: '当前页面已识别为抖音视频页。',
        detected: true,
      };
    }

    return createLocalLinkFallbackPageInfo({
      kind: 'douyin-pending',
      platform: 'douyin',
      description: '当前页面还没有稳定识别到有效的抖音视频内容。',
    });
  }

  if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com') || hostname === 'b23.tv') {
    const pathname = String(location.pathname || '');
    const isVideoPage = pathname.startsWith('/video/') || pathname.startsWith('/bangumi/play/');
    const isSpacePage = hostname === 'space.bilibili.com' || pathname.startsWith('/space/');
    const isSearchPage = hostname === 'search.bilibili.com';
    return {
      kind: isVideoPage ? 'bilibili-video' : isSpacePage ? 'bilibili-profile' : isSearchPage ? 'bilibili-search' : 'bilibili-page',
      platform: 'bilibili',
      action: 'save-bilibili',
      label: isVideoPage ? '保存 Bilibili 视频页到知识库' : '保存 Bilibili 页面到知识库',
      description: isVideoPage ? '当前页面已识别为 Bilibili 视频页。' : '当前页面已识别为 Bilibili 页面。',
      detected: true,
    };
  }

  if (hostname === 'kuaishou.com' || hostname.endsWith('.kuaishou.com') || hostname === 'kwai.com' || hostname.endsWith('.kwai.com')) {
    const pathname = String(location.pathname || '');
    const isVideoPage = pathname.startsWith('/short-video/') || pathname.startsWith('/fw/photo/');
    return {
      kind: isVideoPage ? 'kuaishou-video' : 'kuaishou-page',
      platform: 'kuaishou',
      action: 'save-kuaishou',
      label: isVideoPage ? '保存快手视频页到知识库' : '保存快手页面到知识库',
      description: isVideoPage ? '当前页面已识别为快手视频页。' : '当前页面已识别为快手页面。',
      detected: true,
    };
  }

  if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) {
    const pathname = String(location.pathname || '');
    const isVideoPage = pathname.includes('/video/');
    return {
      kind: isVideoPage ? 'tiktok-video' : 'tiktok-page',
      platform: 'tiktok',
      action: 'save-tiktok',
      label: isVideoPage ? '保存 TikTok 视频页到知识库' : '保存 TikTok 页面到知识库',
      description: isVideoPage ? '当前页面已识别为 TikTok 视频页。' : '当前页面已识别为 TikTok 页面。',
      detected: true,
    };
  }

  if (hostname === 'reddit.com' || hostname.endsWith('.reddit.com')) {
    const pathname = String(location.pathname || '');
    const isPostPage = pathname.includes('/comments/');
    return {
      kind: isPostPage ? 'reddit-post' : 'reddit-page',
      platform: 'reddit',
      action: 'save-reddit',
      label: isPostPage ? '保存 Reddit 帖子到知识库' : '保存 Reddit 页面到知识库',
      description: isPostPage ? '当前页面已识别为 Reddit 帖子。' : '当前页面已识别为 Reddit 页面。',
      detected: true,
    };
  }

  if (hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com' || hostname.endsWith('.twitter.com')) {
    const pathname = String(location.pathname || '');
    const isPostPage = pathname.includes('/status/');
    return {
      kind: isPostPage ? 'x-post' : 'x-page',
      platform: 'x',
      action: 'save-x',
      label: isPostPage ? '保存 X 推文到知识库' : '保存 X 页面到知识库',
      description: isPostPage ? '当前页面已识别为 X 推文。' : '当前页面已识别为 X 页面。',
      detected: true,
    };
  }

  if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) {
    const pathname = String(location.pathname || '');
    const isPostPage = pathname.startsWith('/p/') || pathname.startsWith('/reel/');
    return {
      kind: isPostPage ? 'instagram-post' : 'instagram-page',
      platform: 'instagram',
      action: 'save-instagram',
      label: isPostPage ? '保存 Instagram 内容到知识库' : '保存 Instagram 页面到知识库',
      description: isPostPage ? '当前页面已识别为 Instagram 内容页。' : '当前页面已识别为 Instagram 页面。',
      detected: true,
    };
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
