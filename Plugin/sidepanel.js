const elements = {
  serverStatus: document.getElementById('server-status'),
  refresh: document.getElementById('refresh'),
  openSettings: document.getElementById('open-settings'),
  updateBadge: document.getElementById('update-badge'),
  updateSummary: document.getElementById('update-summary'),
  updateMeta: document.getElementById('update-meta'),
  checkUpdate: document.getElementById('check-update'),
  openUpdateSource: document.getElementById('open-update-source'),
  platformLogo: document.getElementById('platform-logo'),
  platformIcon: document.getElementById('platform-icon'),
  platformFallback: document.getElementById('platform-fallback'),
  platformName: document.getElementById('platform-name'),
  pageTitle: document.getElementById('page-title'),
  pageDetail: document.getElementById('page-detail'),
  captureActionPanel: document.getElementById('capture-action-panel'),
  captureMark: document.getElementById('capture-mark'),
  captureTitle: document.getElementById('capture-title'),
  captureSubtitle: document.getElementById('capture-subtitle'),
  captureActions: document.getElementById('capture-actions'),
  captureStatus: document.getElementById('capture-status'),
  taskQueueBadge: document.getElementById('task-queue-badge'),
  taskCurrent: document.getElementById('task-current'),
  taskQueueMeta: document.getElementById('task-queue-meta'),
  taskLogBadge: document.getElementById('task-log-badge'),
  taskLogList: document.getElementById('task-log-list'),
};

let context = null;
let refreshing = false;
let capturePendingAction = '';
let captureFeedback = null;
let captureSignature = '';
let updateChecking = false;

init().catch((error) => {
  renderConnection(false, error instanceof Error ? error.message : String(error));
  renderPageIdentity({
    platform: 'redbox',
    name: '识别失败',
    logo: 'R',
    title: '侧栏初始化失败',
    detail: '请刷新侧栏后重试',
  });
});

async function init() {
  bindEvents();
  await refreshUpdateStatus(false);
  await refreshContext();
  window.setInterval(() => void refreshTaskQueue(false), 1500);
}

function bindEvents() {
  elements.refresh.addEventListener('click', () => void refreshContext());
  elements.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  elements.checkUpdate.addEventListener('click', () => void refreshUpdateStatus(true));
  elements.openUpdateSource.addEventListener('click', () => void openUpdateSource());
  elements.captureActions.addEventListener('click', (event) => {
    const button = event.target?.closest?.('button[data-action]');
    if (!button) return;
    void runCaptureAction(button.dataset.action || '');
  });
  elements.platformIcon.addEventListener('error', () => {
    elements.platformIcon.classList.add('hidden');
    elements.platformFallback.classList.remove('hidden');
  });
  chrome.tabs?.onActivated?.addListener(() => void refreshContext());
  chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === 'complete') {
      void refreshContext();
    }
  });
  chrome.runtime?.onMessage?.addListener((message) => {
    if (message?.type === 'xhs:task-queue:update') {
      renderTaskQueue(message.queue || {});
      renderTaskLogs(message.queue?.logs || []);
    }
  });
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.success) {
    throw new Error(response?.error || '操作失败');
  }
  return response;
}

async function sendRawMessage(message) {
  return await chrome.runtime.sendMessage(message);
}

async function refreshUpdateStatus(forceCheck) {
  if (updateChecking) return;
  updateChecking = true;
  elements.checkUpdate.disabled = true;
  elements.updateBadge.textContent = forceCheck ? '检查中' : '读取中';
  elements.updateBadge.className = 'update-badge';
  try {
    const response = await sendRawMessage({
      type: forceCheck ? 'plugin-update:check' : 'plugin-update:get-status',
      refresh: false,
    });
    renderUpdateStatus(response?.update, response?.success === false ? response.error : '');
  } catch (error) {
    renderUpdateStatus(null, error instanceof Error ? error.message : String(error));
  } finally {
    updateChecking = false;
    elements.checkUpdate.disabled = false;
  }
}

async function openUpdateSource() {
  elements.openUpdateSource.disabled = true;
  try {
    const response = await sendRawMessage({ type: 'plugin-update:open-source' });
    if (!response?.success) {
      renderUpdateStatus(null, response?.error || '无法打开更新页');
    }
  } catch (error) {
    renderUpdateStatus(null, error instanceof Error ? error.message : String(error));
  } finally {
    elements.openUpdateSource.disabled = false;
  }
}

function renderUpdateStatus(update, errorText = '') {
  const currentVersion = update?.currentVersion || chrome.runtime.getManifest?.()?.version || '0.0.0';
  const latestVersion = update?.latestVersion || currentVersion;
  const lastCheckedAt = update?.lastCheckedAt ? formatTime(update.lastCheckedAt) : '';
  const lastError = errorText || update?.lastError || '';

  if (lastError) {
    elements.updateBadge.textContent = '检查失败';
    elements.updateBadge.className = 'update-badge error';
    elements.updateSummary.textContent = `当前版本 ${currentVersion}`;
    elements.updateMeta.textContent = lastError;
    return;
  }

  if (update?.checkStatus === 'checking') {
    elements.updateBadge.textContent = '检查中';
    elements.updateBadge.className = 'update-badge';
    elements.updateSummary.textContent = `当前版本 ${currentVersion}`;
    elements.updateMeta.textContent = '正在检查远端版本';
    return;
  }

  if (update?.hasUpdate) {
    elements.updateBadge.textContent = '有新版本';
    elements.updateBadge.className = 'update-badge available';
    elements.updateSummary.textContent = `发现 ${latestVersion}，当前 ${currentVersion}`;
    elements.updateMeta.textContent = lastCheckedAt ? `上次检查 ${lastCheckedAt}` : '点击打开更新页获取最新版本';
    return;
  }

  elements.updateBadge.textContent = '已是最新';
  elements.updateBadge.className = 'update-badge';
  elements.updateSummary.textContent = `当前版本 ${currentVersion}`;
  elements.updateMeta.textContent = lastCheckedAt ? `上次检查 ${lastCheckedAt}` : '尚未检查远端版本';
}

async function refreshContext() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  try {
    context = await sendMessage({ type: 'sidepanel:get-context' });
    renderContext(context);
  } catch (error) {
    renderConnection(false, error instanceof Error ? error.message : String(error));
    renderPageIdentity({
      platform: 'redbox',
      name: '识别失败',
      logo: 'R',
      title: '当前页面状态读取失败',
      detail: '请确认页面已加载完成',
    });
  } finally {
    refreshing = false;
    elements.refresh.disabled = false;
  }
}

function renderContext(nextContext) {
  const health = nextContext?.health || {};
  renderConnection(Boolean(health.success), health.error || '');
  renderPageIdentity(resolvePageIdentity(nextContext));
  renderCaptureActions(nextContext);
  renderTaskQueue(nextContext?.queue || {});
  renderTaskLogs(nextContext?.logs || nextContext?.queue?.logs || []);
}

function renderConnection(isHealthy, errorText) {
  if (isHealthy) {
    elements.serverStatus.textContent = '本地知识库已链接';
    elements.serverStatus.className = 'status ok';
    return;
  }
  elements.serverStatus.textContent = errorText || '请先打开 RedBox 桌面端';
  elements.serverStatus.className = 'status error';
}

function resolvePageIdentity(nextContext) {
  const tab = nextContext?.tab || {};
  const pageInfo = nextContext?.pageInfo || {};
  const identity = nextContext?.pageIdentity || {};
  const platform = normalizePlatform(identity.platform || pageInfo.platform || tab.hostname || pageInfo.kind || tab.url);
  const platformMeta = getPlatformMeta(platform);
  const pageType = identity.pageType || inferPageType(pageInfo, tab);
  const fallbackTitle = cleanTitle(identity.title || tab.title || '');
  const hostname = tab.hostname || getHostname(tab.url);

  if (!tab.url) {
    return {
      ...platformMeta,
      title: '未检测到可操作页面',
      detail: '打开网页后会自动识别平台和页面类型',
    };
  }

  if (pageType === 'profile') {
    const username = cleanTitle(identity.username || identity.author || fallbackTitle);
    return {
      ...platformMeta,
      title: username || '博主主页',
      detail: `${platformMeta.name} · 博主主页`,
    };
  }

  if (pageType === 'note' || pageType === 'video' || pageType === 'article') {
    const detailParts = [platformMeta.name, getPageTypeLabel(pageType)];
    if (identity.author) detailParts.push(`作者：${identity.author}`);
    return {
      ...platformMeta,
      title: fallbackTitle || getPageTypeLabel(pageType),
      detail: detailParts.join(' · '),
    };
  }

  return {
    ...platformMeta,
    title: fallbackTitle || hostname || '当前网页',
    detail: hostname ? `${platformMeta.name} · ${hostname}` : platformMeta.name,
  };
}

function renderPageIdentity(view) {
  elements.platformLogo.className = `platform-logo platform-${view.platform || 'redbox'}`;
  elements.platformFallback.textContent = view.logo || 'R';
  if (view.icon) {
    elements.platformIcon.src = view.icon;
    elements.platformIcon.alt = `${view.name || '平台'} 图标`;
    elements.platformIcon.classList.remove('hidden');
    elements.platformFallback.classList.add('hidden');
  } else {
    elements.platformIcon.removeAttribute('src');
    elements.platformIcon.alt = '';
    elements.platformIcon.classList.add('hidden');
    elements.platformFallback.classList.remove('hidden');
  }
  elements.platformName.textContent = view.name || 'RedBox';
  elements.pageTitle.textContent = view.title || '当前页面';
  elements.pageDetail.textContent = view.detail || '';
}

function renderCaptureActions(nextContext) {
  const config = getCaptureActionConfig(nextContext);
  const nextSignature = `${config.variant}:${nextContext?.tab?.id || 0}:${nextContext?.tab?.url || ''}`;
  if (captureSignature !== nextSignature) {
    captureFeedback = null;
    captureSignature = nextSignature;
  }

  elements.captureActionPanel.classList.toggle('hidden', config.actions.length === 0);
  if (config.actions.length === 0) return;

  const isHealthy = Boolean(nextContext?.health?.success);
  elements.captureMark.textContent = config.mark || 'R';
  elements.captureTitle.textContent = config.title;
  elements.captureSubtitle.textContent = config.subtitle;
  elements.captureActions.replaceChildren();

  for (const item of config.actions) {
    const meta = getCaptureActionMeta(item.action);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = item.action;
    button.className = item.primary ? 'primary' : '';
    button.title = item.title || item.label;
    button.textContent = capturePendingAction === item.action ? meta.pending : item.label;
    button.disabled = Boolean(capturePendingAction) || !isHealthy || item.disabled;
    elements.captureActions.appendChild(button);
  }

  if (captureFeedback) {
    renderCaptureStatus(captureFeedback.message, captureFeedback.status);
    return;
  }
  if (!isHealthy) {
    renderCaptureStatus('请先打开 RedBox 桌面端', 'error');
    return;
  }
  renderCaptureStatus(config.hint || '点击按钮后任务会进入下方队列', 'idle');
}

async function runCaptureAction(action) {
  if (!action || capturePendingAction) return;
  const meta = getCaptureActionMeta(action);
  if (!meta.type) return;
  const tabId = Number(context?.tab?.id || 0);
  if (!tabId) {
    captureFeedback = { status: 'error', message: '未识别到当前标签页，请刷新侧栏后重试' };
    renderCaptureActions(context);
    return;
  }

  capturePendingAction = action;
  captureFeedback = { status: 'pending', message: meta.pending };
  renderCaptureActions(context);
  try {
    const tab = context?.tab || {};
    const response = await sendMessage({
      type: meta.type,
      tabId,
      tabUrl: tab.url || '',
      windowId: Number(tab.windowId || 0) || undefined,
    });
    if (response.taskQueue) {
      renderTaskQueue(response.taskQueue);
      renderTaskLogs(response.taskQueue.logs || []);
    }
    captureFeedback = {
      status: 'success',
      message: summarizeActionResponse(response, meta.done),
    };
    await refreshTaskQueue(false);
  } catch (error) {
    captureFeedback = {
      status: 'error',
      message: `执行失败：${error instanceof Error ? error.message : String(error)}`,
    };
    await refreshTaskQueue(false);
  } finally {
    capturePendingAction = '';
    renderCaptureActions(context);
  }
}

function renderCaptureStatus(message, status = 'idle') {
  elements.captureStatus.textContent = message || '';
  elements.captureStatus.dataset.state = status;
  elements.captureStatus.hidden = !message;
}

function getCaptureActionConfig(nextContext) {
  const tab = nextContext?.tab || {};
  const pageInfo = nextContext?.pageInfo || {};
  const identity = nextContext?.pageIdentity || {};
  const platform = normalizePlatform(identity.platform || pageInfo.platform || tab.hostname || pageInfo.kind || tab.url);
  const pageType = identity.pageType || inferPageType(pageInfo, tab);
  if (!tab.url) {
    return {
      variant: 'empty',
      title: 'RedBox 页面采集',
      subtitle: '打开网页后自动识别',
      actions: [],
    };
  }
  if (platform === 'xhs' && pageType === 'profile') {
    return {
      variant: 'xhs-profile',
      title: 'RedBox 博主采集',
      subtitle: '小红书博主页',
      actions: [
        { label: '保存博主', action: 'blogger', primary: true, title: '保存当前博主资料到 RedBox' },
        { label: '采集博主笔记', action: 'bloggerNotes', title: '采集当前博主主页笔记' },
      ],
    };
  }
  if (platform === 'xhs' && pageType === 'note') {
    return {
      variant: 'xhs-note',
      title: 'RedBox 笔记采集',
      subtitle: '小红书笔记页',
      actions: [
        { label: '保存笔记', action: 'save', primary: true, title: '保存当前笔记到 RedBox' },
      ],
    };
  }
  if (platform === 'xhs') {
    return {
      variant: 'xhs-page',
      title: 'RedBox 小红书采集',
      subtitle: '当前页面',
      actions: [
        { label: '保存网页', action: 'savePageLink', primary: true, title: '保存当前页面链接到 RedBox' },
      ],
    };
  }
  if (platform === 'youtube') {
    return {
      variant: 'youtube',
      title: 'RedBox 视频采集',
      subtitle: 'YouTube',
      actions: [
        { label: '保存视频', action: 'saveYoutube', primary: true, title: '保存当前 YouTube 视频到 RedBox' },
      ],
    };
  }
  if (platform === 'douyin') {
    return {
      variant: 'douyin',
      title: 'RedBox 视频采集',
      subtitle: '抖音',
      actions: [
        { label: '保存视频', action: 'saveDouyin', primary: true, title: '保存当前抖音视频到 RedBox' },
      ],
    };
  }
  if (platform === 'wechat' && pageType === 'article') {
    return {
      variant: 'wechat',
      title: 'RedBox 文章采集',
      subtitle: '微信公众号',
      actions: [
        { label: '保存文章', action: 'savePageLink', primary: true, title: '保存当前公众号文章到 RedBox' },
      ],
    };
  }
  const platformMap = {
    bilibili: { subtitle: 'Bilibili', label: pageType === 'video' ? '保存视频' : '保存页面', action: 'saveBilibili', title: '保存当前 Bilibili 内容到 RedBox' },
    kuaishou: { subtitle: '快手', label: pageType === 'video' ? '保存视频' : '保存页面', action: 'saveKuaishou', title: '保存当前快手内容到 RedBox' },
    tiktok: { subtitle: 'TikTok', label: pageType === 'video' ? '保存视频' : '保存页面', action: 'saveTiktok', title: '保存当前 TikTok 内容到 RedBox' },
    reddit: { subtitle: 'Reddit', label: pageType === 'post' ? '保存帖子' : '保存页面', action: 'saveReddit', title: '保存当前 Reddit 内容到 RedBox' },
    x: { subtitle: 'X', label: pageType === 'post' ? '保存推文' : '保存页面', action: 'saveX', title: '保存当前 X 内容到 RedBox' },
    instagram: { subtitle: 'Instagram', label: pageType === 'post' || pageType === 'video' ? '保存内容' : '保存页面', action: 'saveInstagram', title: '保存当前 Instagram 内容到 RedBox' },
  };
  if (platformMap[platform]) {
    const item = platformMap[platform];
    return {
      variant: platform,
      title: 'RedBox 页面采集',
      subtitle: item.subtitle,
      actions: [
        { label: item.label, action: item.action, primary: true, title: item.title },
      ],
    };
  }
  return {
    variant: 'generic',
    title: 'RedBox 页面采集',
    subtitle: tab.hostname || '当前网页',
    actions: [
      { label: '保存网页', action: pageInfo?.action === 'save-page-auto' ? 'savePageAuto' : 'savePageLink', primary: true, title: '保存当前网页到 RedBox' },
    ],
  };
}

function getCaptureActionMeta(action) {
  const map = {
    save: { type: 'save-xhs', pending: '保存中...', done: '已保存到 RedBox' },
    download: { type: 'xhs:download-current-note', pending: '下载中...', done: '已创建下载任务' },
    comments: { type: 'xhs:collect-current-comments', pending: '采集中...', done: '评论已写入知识库' },
    blogger: { type: 'xhs:collect-current-blogger', pending: '采集中...', done: '已保存博主资料' },
    bloggerNotes: { type: 'xhs:collect-blogger-notes', pending: '采集中...', done: '已采集主页笔记' },
    exportJson: { type: 'xhs:export-current-note-json', pending: '导出中...', done: '已导出 JSON' },
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
  return map[action] || {};
}

function summarizeActionResponse(response, fallback) {
  if (response?.noteId) {
    return response.duplicate ? '知识库中已存在' : '已保存到 RedBox';
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
    return response.duplicate ? '知识库中已存在这条内容' : fallback;
  }
  return fallback || '操作完成';
}

async function refreshTaskQueue(showErrors = false) {
  try {
    const response = await sendMessage({ type: 'xhs:get-task-queue' });
    renderTaskQueue(response.queue || {});
    renderTaskLogs(response.queue?.logs || []);
  } catch (error) {
    if (showErrors) {
      renderTaskQueue({
        active: {
          title: error instanceof Error ? error.message : String(error),
          startedAt: Date.now(),
        },
      });
    }
  }
}

function renderTaskQueue(queue) {
  const active = queue?.active || null;
  const queued = Array.isArray(queue?.queued) ? queue.queued : [];
  const last = queue?.last || null;
  if (active) {
    elements.taskQueueBadge.textContent = queued.length > 0 ? `执行中 · 排队 ${queued.length}` : '执行中';
    elements.taskQueueBadge.className = 'task-badge running';
    elements.taskCurrent.textContent = active.title || '小红书采集任务';
    elements.taskQueueMeta.textContent = [
      active.startedAt ? `开始 ${formatTime(active.startedAt)}` : '',
      queued.length > 0 ? `后续 ${queued.map((item) => item.title || '任务').slice(0, 2).join('、')}${queued.length > 2 ? '...' : ''}` : '队列无等待任务',
    ].filter(Boolean).join(' · ');
    return;
  }

  elements.taskQueueBadge.textContent = queued.length > 0 ? `排队 ${queued.length}` : '空闲';
  elements.taskQueueBadge.className = 'task-badge';
  if (queued.length > 0) {
    elements.taskCurrent.textContent = queued[0]?.title || '等待执行的小红书任务';
    elements.taskQueueMeta.textContent = queued.length > 1 ? `后续 ${queued.length - 1} 个任务` : '等待后台调度';
    return;
  }

  elements.taskCurrent.textContent = '暂无执行任务';
  elements.taskQueueMeta.textContent = last?.title
    ? `最近完成：${last.title}${last.summary ? ` · ${last.summary}` : ''}`
    : '队列为空';
}

function renderTaskLogs(logsInput) {
  const logs = Array.isArray(logsInput) ? logsInput.slice(0, 12) : [];
  elements.taskLogBadge.textContent = logs.length > 0 ? `最近 ${logs.length} 条` : '最近记录';
  elements.taskLogList.replaceChildren();
  if (logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = '暂无执行日志';
    elements.taskLogList.appendChild(empty);
    return;
  }

  for (const log of logs) {
    const status = normalizeLogStatus(log.status);
    const item = document.createElement('article');
    item.className = `log-item ${status}`;

    const row = document.createElement('div');
    row.className = 'log-row';

    const title = document.createElement('div');
    title.className = 'log-title';
    title.textContent = log.title || '采集任务';

    const time = document.createElement('time');
    time.className = 'log-time';
    time.textContent = formatTime(log.createdAt || log.updatedAt);

    const message = document.createElement('div');
    message.className = 'log-message';
    message.textContent = log.message || getFallbackLogMessage(status);

    row.append(title, time);
    item.append(row, message);
    elements.taskLogList.appendChild(item);
  }
}

function normalizeLogStatus(status) {
  const text = String(status || '').toLowerCase();
  if (text === 'failed' || text === 'error') return 'failed';
  if (text === 'partial' || text === 'warning') return 'partial';
  if (text === 'running' || text === 'queued') return 'running';
  return 'success';
}

function getFallbackLogMessage(status) {
  switch (status) {
    case 'failed':
      return '任务执行失败';
    case 'partial':
      return '任务部分完成';
    case 'running':
      return '任务正在执行';
    default:
      return '任务执行成功';
  }
}

function normalizePlatform(value) {
  const text = String(value || '').toLowerCase().trim();
  const hostname = getPlatformHostname(text);
  if (hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com' || hostname.endsWith('.twitter.com') || text === 'x') return 'x';
  if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com') || hostname === 'instagr.am' || hostname.endsWith('.instagr.am')) return 'instagram';
  if (hostname === 'reddit.com' || hostname.endsWith('.reddit.com')) return 'reddit';
  if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) return 'tiktok';
  if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com') || hostname === 'b23.tv') return 'bilibili';
  if (hostname === 'kuaishou.com' || hostname.endsWith('.kuaishou.com') || hostname === 'kwai.com' || hostname.endsWith('.kwai.com')) return 'kuaishou';
  if (hostname === 'douyin.com' || hostname.endsWith('.douyin.com')) return 'douyin';
  if (hostname === 'xiaohongshu.com' || hostname.endsWith('.xiaohongshu.com') || hostname === 'rednote.com' || hostname.endsWith('.rednote.com')) return 'xhs';
  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') return 'youtube';
  if (hostname === 'mp.weixin.qq.com' || hostname.endsWith('.weixin.qq.com')) return 'wechat';
  if (/xiaohongshu|xhs|rednote|小红书/.test(text)) return 'xhs';
  if (/youtube|youtu\.be/.test(text)) return 'youtube';
  if (/douyin|抖音/.test(text)) return 'douyin';
  if (/kuaishou|kwai|快手/.test(text)) return 'kuaishou';
  if (/bilibili|b站|哔哩/.test(text)) return 'bilibili';
  if (/tiktok/.test(text)) return 'tiktok';
  if (/reddit/.test(text)) return 'reddit';
  if (/instagram|instagr\.am|ins\b/.test(text)) return 'instagram';
  if (/^x$|(^|[^a-z])x\.com|twitter|platform-x|[^a-z]x[^a-z]/.test(text)) return 'x';
  if (/weixin|wechat|mp\.weixin|公众号/.test(text)) return 'wechat';
  if (/redbox|redconvert/.test(text)) return 'redbox';
  return 'web';
}

function getPlatformHostname(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function getPlatformMeta(platform) {
  const map = {
    xhs: { platform: 'xhs', name: '小红书', logo: '小', icon: 'assets/platforms/xiaohongshu.svg' },
    youtube: { platform: 'youtube', name: 'YouTube', logo: '▶' },
    douyin: { platform: 'douyin', name: '抖音', logo: '抖', icon: 'assets/platforms/douyin.svg' },
    kuaishou: { platform: 'kuaishou', name: '快手', logo: '快', icon: 'assets/platforms/kuaishou.svg' },
    bilibili: { platform: 'bilibili', name: 'Bilibili', logo: 'B', icon: 'assets/platforms/bilibili.svg' },
    tiktok: { platform: 'tiktok', name: 'TikTok', logo: 'T', icon: 'assets/platforms/tiktok.svg' },
    reddit: { platform: 'reddit', name: 'Reddit', logo: 'R', icon: 'assets/platforms/reddit.svg' },
    x: { platform: 'x', name: 'X', logo: 'X', icon: 'assets/platforms/x.svg' },
    instagram: { platform: 'instagram', name: 'Instagram', logo: 'I', icon: 'assets/platforms/instagram.svg' },
    wechat: { platform: 'wechat', name: '微信公众号', logo: '微' },
    redbox: { platform: 'redbox', name: 'RedBox', logo: 'R' },
    web: { platform: 'web', name: '网页', logo: 'W' },
  };
  return map[platform] || map.web;
}

function inferPageType(pageInfo, tab) {
  const kind = String(pageInfo?.kind || '').toLowerCase();
  const url = String(tab?.url || '').toLowerCase();
  if (/profile|author|博主|主页/.test(kind) || /\/user\/profile\//.test(url)) return 'profile';
  if (/note|image|小红书/.test(kind) || /\/explore\/|\/discovery\/item\//.test(url)) return 'note';
  if (/post|tweet|帖子|推文/.test(kind) || /\/comments\/|\/status\/|instagram\.com\/(p|reel)\//.test(url)) return 'post';
  if (/video|youtube|douyin|kuaishou|bilibili|tiktok/.test(kind)) return 'video';
  if (/article|wechat|公众号/.test(kind)) return 'article';
  return 'page';
}

function getPageTypeLabel(pageType) {
  switch (pageType) {
    case 'profile':
      return '博主主页';
    case 'note':
      return '笔记';
    case 'video':
      return '视频';
    case 'article':
      return '文章';
    case 'post':
      return '帖子';
    default:
      return '页面';
  }
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\s*-\s*小红书.*$/i, '')
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .replace(/\s*-\s*bilibili.*$/i, '')
    .replace(/\s*_\s*哔哩哔哩.*$/i, '')
    .replace(/\s*-\s*抖音.*$/i, '')
    .replace(/\s*-\s*快手.*$/i, '')
    .replace(/\s*-\s*TikTok.*$/i, '')
    .replace(/\s*\/\s*X\s*$/i, '')
    .replace(/\s*•\s*Instagram.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
