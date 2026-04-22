const serverStatusEl = document.getElementById('server-status');
const pageMetaEl = document.getElementById('page-meta');
const resultEl = document.getElementById('result');
const actionHintEl = document.getElementById('action-hint');
const updatePanelEl = document.getElementById('update-panel');
const updateStatusEl = document.getElementById('update-status');
const updateMetaEl = document.getElementById('update-meta');

const buttons = {
  checkUpdate: document.getElementById('check-update'),
  openUpdateSource: document.getElementById('open-update-source'),
  primary: document.getElementById('save-primary'),
};

let activeTab = null;
const actionSupport = { primary: false };
let primaryActionType = 'save-page-link';
let captureTypeEl = null;
let refreshTimer = null;
let popupOpenedAt = Date.now();

init().catch((error) => {
  showResult(error instanceof Error ? error.message : String(error), 'error');
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;

  const url = String(activeTab?.url || '');
  const host = safeHost(url);
  const title = String(activeTab?.title || '').trim();

  pageMetaEl.textContent = host
    ? `${title || '未命名页面'}\n${host}`
    : '未检测到可操作页面';

  const health = await sendMessage({ type: 'healthcheck' });
  if (health?.success) {
    serverStatusEl.textContent = '本地知识库已链接 ✅';
    serverStatusEl.className = 'status ok';
  } else {
    serverStatusEl.textContent = `本地知识库未链接：${health?.error || '请先打开桌面应用'}`;
    serverStatusEl.className = 'status error';
  }

  ensureCaptureTypeElement();
  await refreshUpdateStatus(false);
  await refreshPageInfo();
  startRefreshLoop();

  buttons.primary.addEventListener('click', () => runAction(primaryActionType));
  buttons.checkUpdate.addEventListener('click', () => void runUpdateCheck());
  buttons.openUpdateSource.addEventListener('click', () => void openUpdateSource());
  window.addEventListener('unload', stopRefreshLoop, { once: true });
}

function inferPageInfoFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return null;
  }

  const hostname = String(parsed.hostname || '').toLowerCase();
  const pathname = String(parsed.pathname || '');

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
    if (isVideoPage) {
      return {
        kind: 'youtube',
        action: 'save-youtube',
        label: '保存YouTube视频到知识库',
        description: '当前页面已识别为 YouTube 视频页。',
        primaryEnabled: true,
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

  if (/(^|\.)douyin\.com$/i.test(hostname)) {
    return createLinkFallbackPageInfo({
      kind: 'douyin-pending',
      description: '当前页面还没有稳定识别到有效的抖音视频内容。',
    });
  }

  return createLinkFallbackPageInfo();
}

async function runAction(type) {
  if (!activeTab?.id) {
    showResult('没有可用的当前标签页', 'error');
    return;
  }
  setBusy(true);
  showResult('正在保存...', 'success');
  try {
    const result = await sendMessage({ type, tabId: activeTab.id });
    if (!result?.success) {
      throw new Error(result?.error || '保存失败');
    }
    const detail = result.duplicate
      ? '已存在于知识库，已跳过重复保存。'
      : `保存成功${result.noteId ? `：${result.noteId}` : ''}`;
    showResult(detail, 'success');
  } catch (error) {
    showResult(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function runUpdateCheck() {
  setUpdateButtonsBusy(true);
  updateStatusEl.textContent = '正在检查插件更新...';
  updateStatusEl.className = 'status';
  try {
    await refreshUpdateStatus(true);
  } finally {
    setUpdateButtonsBusy(false);
  }
}

async function openUpdateSource() {
  buttons.openUpdateSource.disabled = true;
  try {
    await sendMessage({ type: 'plugin-update:open-source' });
  } finally {
    buttons.openUpdateSource.disabled = false;
  }
}

function setUpdateButtonsBusy(busy) {
  buttons.checkUpdate.disabled = busy;
  buttons.openUpdateSource.disabled = busy;
}

function setBusy(busy) {
  applyButtonState(buttons.primary, !busy && actionSupport.primary);
}

function applyButtonState(button, enabled) {
  button.disabled = !enabled;
}

function ensureCaptureTypeElement() {
  if (captureTypeEl) return;
  captureTypeEl = document.createElement('div');
  captureTypeEl.className = 'capture-type';
  pageMetaEl.insertAdjacentElement('afterend', captureTypeEl);
}

async function refreshUpdateStatus(forceRefresh) {
  const response = await sendMessage({
    type: forceRefresh ? 'plugin-update:check' : 'plugin-update:get-status',
    refresh: forceRefresh,
  }).catch(() => null);

  const update = normalizeUpdateState(response?.update);
  if (!update.hasUpdate) {
    updatePanelEl?.classList.add('hidden');
    updateMetaEl.classList.add('hidden');
    updateMetaEl.textContent = '';
    return;
  }

  updatePanelEl?.classList.remove('hidden');
  updateStatusEl.textContent = `发现新版本 ${update.latestVersion}，当前版本 ${update.currentVersion}`;
  updateStatusEl.className = 'status error';

  const lines = [
    `当前版本：${update.currentVersion}`,
    `开源仓库版本：${update.latestVersion}`,
  ];
  if (update.lastCheckedAt) {
    lines.push(`最近检查：${formatDateTime(update.lastCheckedAt)}`);
  }
  lines.push('更新方式：打开开源仓库 Plugin 目录，重新加载扩展。');

  updateMetaEl.textContent = lines.join('\n');
  updateMetaEl.classList.remove('hidden');
}

async function refreshPageInfo() {
  const url = String(activeTab?.url || '');
  const inspect = await sendMessage({ type: 'inspect-page', tabId: activeTab?.id || 0 }).catch(() => null);
  const pageInfo = normalizePageInfo(inspect?.pageInfo || inferPageInfoFromUrl(url));

  primaryActionType = pageInfo.action || 'save-page-link';
  actionSupport.primary = Boolean(activeTab?.id) && pageInfo.primaryEnabled !== false;

  buttons.primary.textContent = pageInfo.label || '保存到知识库';
  buttons.primary.classList.toggle('btn-primary', Boolean(pageInfo.detected));
  buttons.primary.classList.toggle('btn-secondary', !pageInfo.detected);

  if (actionHintEl) {
    actionHintEl.textContent = pageInfo.detected ? '' : (pageInfo.statusText || '未检测到内容');
    actionHintEl.classList.toggle('hidden', Boolean(pageInfo.detected));
  }

  captureTypeEl.textContent = pageInfo.description || '';
  applyButtonState(buttons.primary, actionSupport.primary);
}

function startRefreshLoop() {
  stopRefreshLoop();
  popupOpenedAt = Date.now();

  const tick = async () => {
    await refreshPageInfo().catch(() => {});
    const elapsed = Date.now() - popupOpenedAt;
    const delay = elapsed < 2500 ? 120 : 450;
    refreshTimer = window.setTimeout(tick, delay);
  };

  refreshTimer = window.setTimeout(tick, 120);
}

function stopRefreshLoop() {
  if (!refreshTimer) return;
  window.clearTimeout(refreshTimer);
  refreshTimer = null;
}

function normalizePageInfo(pageInfo) {
  if (!pageInfo || typeof pageInfo !== 'object') {
    return createLinkFallbackPageInfo();
  }

  return {
    kind: pageInfo.kind || 'generic',
    action: pageInfo.action || 'save-page-link',
    label: pageInfo.label || '仅保存链接到知识库',
    description: pageInfo.description || '当前页面可作为链接收藏保存到知识库。',
    primaryEnabled: pageInfo.primaryEnabled !== false,
    detected: Boolean(pageInfo.detected),
    statusText: pageInfo.statusText || '未检测到内容',
  };
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

function normalizeUpdateState(value) {
  const currentVersion = normalizeText(chrome.runtime.getManifest()?.version) || '0.0.0';
  if (!value || typeof value !== 'object') {
    return {
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      lastCheckedAt: null,
      sourceUrl: '',
      lastError: '',
      checkStatus: 'idle',
    };
  }
  const latestVersion = normalizeText(value.latestVersion) || currentVersion;
  return {
    currentVersion: normalizeText(value.currentVersion) || currentVersion,
    latestVersion,
    hasUpdate: Boolean(value.hasUpdate),
    lastCheckedAt: normalizeText(value.lastCheckedAt) || null,
    sourceUrl: normalizeText(value.sourceUrl),
    lastError: normalizeText(value.lastError),
    checkStatus: normalizeText(value.checkStatus) || 'idle',
  };
}

function normalizeText(value) {
  return String(value || '').trim();
}

function formatDateTime(value) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) {
    return '未知';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function showResult(message, type) {
  resultEl.className = `panel result ${type}`;
  resultEl.textContent = message;
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}
