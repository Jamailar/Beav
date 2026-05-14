const elements = {
  serverStatus: document.getElementById('server-status'),
  workspaceName: document.getElementById('workspace-name'),
  accountFooter: document.getElementById('account-footer'),
  boundAccountName: document.getElementById('bound-account-name'),
  accountBindingNotice: document.getElementById('account-binding-notice'),
  accountBindingTitle: document.getElementById('account-binding-title'),
  accountBindingCopy: document.getElementById('account-binding-copy'),
  accountBindingAction: document.getElementById('account-binding-action'),
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
  bloggerNotesPanel: document.getElementById('blogger-notes-panel'),
  bloggerNotesModePill: document.getElementById('blogger-notes-mode-pill'),
  bloggerNotesApiMode: document.getElementById('blogger-notes-api-mode'),
  bloggerNotesModeLabel: document.getElementById('blogger-notes-mode-label'),
  bloggerNotesLimit: document.getElementById('blogger-notes-limit'),
  bloggerNotesIntervalMax: document.getElementById('blogger-notes-interval-max'),
  bloggerNotesStart: document.getElementById('blogger-notes-start'),
  bloggerNotesProgress: document.getElementById('blogger-notes-progress'),
  bloggerNotesProgressLabel: document.getElementById('blogger-notes-progress-label'),
  bloggerNotesProgressPercent: document.getElementById('blogger-notes-progress-percent'),
  bloggerNotesProgressFill: document.getElementById('blogger-notes-progress-fill'),
  bloggerNotesProgressMeta: document.getElementById('blogger-notes-progress-meta'),
  bloggerNotesControls: document.getElementById('blogger-notes-controls'),
  bloggerNotesPause: document.getElementById('blogger-notes-pause'),
  bloggerNotesResume: document.getElementById('blogger-notes-resume'),
  bloggerNotesCancel: document.getElementById('blogger-notes-cancel'),
  taskQueueBadge: document.getElementById('task-queue-badge'),
  taskCurrent: document.getElementById('task-current'),
  taskQueueMeta: document.getElementById('task-queue-meta'),
  taskQueueControls: document.getElementById('task-queue-controls'),
  taskQueuePause: document.getElementById('task-queue-pause'),
  taskQueueResume: document.getElementById('task-queue-resume'),
  taskQueueCancel: document.getElementById('task-queue-cancel'),
  taskLogBadge: document.getElementById('task-log-badge'),
  taskLogList: document.getElementById('task-log-list'),
};

const USER_PROFILE_FEATURE_ENABLED = false;
let context = null;
let refreshing = false;
let capturePendingAction = '';
let captureFeedback = null;
let captureSignature = '';
let updateChecking = false;
let currentSettings = {
  xhsBloggerNoteLimit: 50,
  xhsIntervalMaxSeconds: 6,
  xhsBloggerCollectionMode: 'api',
};

function debugLog(scope, details) {
  console.debug(`[redbox-plugin][sidepanel][${scope}]`, details);
}

function debugWarn(scope, details) {
  console.warn(`[redbox-plugin][sidepanel][${scope}]`, details);
}

init().catch((error) => {
  renderConnection({ success: false, error: error instanceof Error ? error.message : String(error) });
  renderWorkspaceAndAccounts(null, null);
  renderAccountBindingNotice(null, null);
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
  elements.bloggerNotesApiMode.addEventListener('change', () => {
    renderBloggerNotesMode();
  });
  elements.bloggerNotesStart.addEventListener('click', () => void startBloggerNotesCollection());
  elements.bloggerNotesPause.addEventListener('click', () => void controlActiveTask('pause'));
  elements.bloggerNotesResume.addEventListener('click', () => void controlActiveTask('resume'));
  elements.bloggerNotesCancel.addEventListener('click', () => void controlActiveTask('cancel'));
  elements.taskQueuePause.addEventListener('click', () => void controlActiveTask('pause'));
  elements.taskQueueResume.addEventListener('click', () => void controlActiveTask('resume'));
  elements.taskQueueCancel.addEventListener('click', () => void controlActiveTask('cancel'));
  if (USER_PROFILE_FEATURE_ENABLED) {
    elements.accountBindingAction.addEventListener('click', () => void bindCurrentProfileAsAccount());
  }
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
      debugLog('task-queue-update', message.queue || {});
      renderTaskQueue(message.queue || {});
      renderTaskLogs(message.queue?.logs || []);
      renderBloggerNotesPanel({
        ...context,
        queue: message.queue || {},
      });
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
    const [nextContext, settingsResponse] = await Promise.all([
      sendMessage({ type: 'sidepanel:get-context' }),
      sendMessage({ type: 'settings:get' }),
    ]);
    context = nextContext;
    currentSettings = {
      ...currentSettings,
      ...(settingsResponse?.settings || {}),
    };
    debugLog('refresh-context', {
      context: nextContext,
      settings: currentSettings,
    });
    renderContext(context);
  } catch (error) {
    debugWarn('refresh-context-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    renderConnection({ success: false, error: error instanceof Error ? error.message : String(error) });
    renderWorkspaceAndAccounts(null, null);
    renderAccountBindingNotice(null, null);
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
  const healthPayload = extractHealthPayload(health);
  renderConnection(health);
  renderWorkspaceAndAccounts(nextContext, healthPayload);
  renderAccountBindingNotice(nextContext, healthPayload);
  renderPageIdentity(resolvePageIdentity(nextContext));
  renderCaptureActions(nextContext);
  renderBloggerNotesPanel(nextContext);
  renderTaskQueue(nextContext?.queue || {});
  renderTaskLogs(nextContext?.logs || nextContext?.queue?.logs || []);
}

function renderConnection(health) {
  if (!health?.success) {
    elements.serverStatus.textContent = health?.error || '请先打开 RedBox 桌面端';
    elements.serverStatus.className = 'status error';
    return;
  }

  if (!USER_PROFILE_FEATURE_ENABLED) {
    elements.serverStatus.textContent = '已链接';
    elements.serverStatus.className = 'status ok';
    return;
  }

  const payload = extractHealthPayload(health);
  if (payload?.accountBindingStatus === 'hasAccountProfile') {
    elements.serverStatus.textContent = '已链接 · 已有账号档案';
    elements.serverStatus.className = 'status ok';
    return;
  }

  elements.serverStatus.textContent = '已链接 · 当前空间无账号档案';
  elements.serverStatus.className = 'status warn';
}

function renderWorkspaceAndAccounts(nextContext, healthPayload) {
  elements.accountFooter?.classList.toggle('hidden', !USER_PROFILE_FEATURE_ENABLED);
  if (!USER_PROFILE_FEATURE_ENABLED) {
    elements.workspaceName.textContent = healthPayload?.success
      ? `当前空间：${cleanTitle(healthPayload.workspaceName || healthPayload.spaceName || '') || '已连接'}`
      : '当前空间：未连接';
    elements.boundAccountName.textContent = '';
    return;
  }
  if (!healthPayload?.success) {
    elements.workspaceName.textContent = '当前空间：未连接';
    elements.boundAccountName.textContent = '未连接 RedBox';
    return;
  }

  const workspaceName = cleanTitle(healthPayload?.workspace?.name || healthPayload?.spaceName || healthPayload?.spaceId || '');
  elements.workspaceName.textContent = workspaceName ? `当前空间：${workspaceName}` : '当前空间：未命名空间';

  const accounts = healthPayload?.platformAccounts || {};
  const view = resolvePageIdentity(nextContext);
  const platformKey = healthPlatformKey(view.platform);
  const platformLabels = {
    xiaohongshu: '小红书',
    douyin: '抖音',
    bilibili: 'Bilibili',
  };

  if (platformKey && accounts[platformKey]) {
    const account = accounts[platformKey];
    const label = platformLabels[platformKey] || platformKey;
    elements.boundAccountName.textContent = accountLabel(label, account);
    return;
  }

  const boundAccounts = Object.entries(accounts)
    .filter(([, account]) => account?.bound)
    .map(([key, account]) => accountLabel(platformLabels[key] || key, account));

  if (boundAccounts.length > 0) {
    elements.boundAccountName.textContent = boundAccounts.join(' · ');
    return;
  }

  elements.boundAccountName.textContent = '未绑定小红书 / 抖音 / Bilibili 账号';
}

function renderAccountBindingNotice(nextContext, healthPayload) {
  if (!USER_PROFILE_FEATURE_ENABLED) {
    elements.accountBindingNotice.classList.add('hidden');
    elements.accountBindingAction.disabled = true;
    return;
  }
  const hasBoundAccount = healthPayload?.accountBindingStatus === 'hasAccountProfile';
  const isConnected = healthPayload?.success === true;
  elements.accountBindingNotice.classList.toggle('hidden', !isConnected || hasBoundAccount);
  if (!isConnected || hasBoundAccount) return;

  const view = resolvePageIdentity(nextContext);
  const platformKey = healthPlatformKey(view.platform);
  const pageInfo = nextContext?.pageInfo || {};
  const pageType = nextContext?.pageIdentity?.pageType || inferPageType(pageInfo, nextContext?.tab || {});
  const isXhsProfile = platformKey === 'xiaohongshu' && pageType === 'profile';
  const canBindCurrentPlatform = platformKey === 'douyin'
    || platformKey === 'bilibili'
    || isXhsProfile;
  const platformLabels = {
    xiaohongshu: '小红书',
    douyin: '抖音',
    bilibili: 'Bilibili',
  };

  elements.accountBindingTitle.textContent = '当前空间还没有绑定自媒体账号';
  if (canBindCurrentPlatform) {
    const platformLabel = platformLabels[platformKey] || '当前平台';
    elements.accountBindingCopy.textContent = isXhsProfile
      ? '用当前小红书主页绑定运营账号，并自动学习历史内容。'
      : `用当前${platformLabel}页面绑定运营账号，并把当前内容加入账号档案。`;
    elements.accountBindingAction.textContent = '绑定并学习这个账号';
    elements.accountBindingAction.disabled = Boolean(capturePendingAction);
    return;
  }

  const platformLabel = platformLabels[platformKey] || '平台';
  elements.accountBindingCopy.textContent = platformKey
    ? `请打开${platformLabel}账号主页，再绑定并学习这个账号。`
    : '请打开小红书、抖音或 Bilibili 账号主页，再绑定并学习这个账号。';
  elements.accountBindingAction.textContent = '等待账号主页';
  elements.accountBindingAction.disabled = true;
}

function accountLabel(platformLabel, account) {
  if (!account?.bound) return `${platformLabel}：未绑定`;
  const username = cleanTitle(account.username || account.name || '');
  const accountId = cleanTitle(account.id || account.platformUserId || '');
  if (username && accountId) return `${platformLabel}：${username}（${accountId}）`;
  return `${platformLabel}：${username || accountId || '已绑定账号'}`;
}

function healthPlatformKey(platform) {
  if (platform === 'xhs' || platform === 'xiaohongshu') return 'xiaohongshu';
  if (platform === 'douyin') return 'douyin';
  if (platform === 'bilibili') return 'bilibili';
  return '';
}

function extractHealthPayload(health) {
  return health?.health || health || null;
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
  if (!USER_PROFILE_FEATURE_ENABLED && (action === 'blogger' || action === 'bloggerNotes')) return;
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
    debugLog('capture-action-start', {
      action,
      messageType: meta.type,
      tabId,
      tabUrl: tab.url || '',
    });
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
    debugLog('capture-action-success', {
      action,
      response,
    });
    captureFeedback = {
      status: 'success',
      message: summarizeActionResponse(response, meta.done),
    };
    await refreshTaskQueue(false);
  } catch (error) {
    debugWarn('capture-action-failed', {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
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

async function bindCurrentProfileAsAccount() {
  if (!USER_PROFILE_FEATURE_ENABLED) return;
  if (capturePendingAction) return;
  const tabId = Number(context?.tab?.id || 0);
  if (!tabId) {
    captureFeedback = { status: 'error', message: '未识别到当前标签页，请刷新侧栏后重试' };
    renderCaptureActions(context);
    return;
  }

  capturePendingAction = 'bindProfile';
  captureFeedback = { status: 'pending', message: '正在绑定账号并准备学习…' };
  renderAccountBindingNotice(context, extractHealthPayload(context?.health || {}));
  renderCaptureActions(context);
  try {
    const tab = context?.tab || {};
    const view = resolvePageIdentity(context);
    const platformKey = healthPlatformKey(view.platform);
    const baseMessage = {
      tabId,
      tabUrl: tab.url || '',
      windowId: Number(tab.windowId || 0) || undefined,
    };
    if (platformKey === 'douyin' || platformKey === 'bilibili') {
      const response = await sendMessage({
        type: 'account:bind-current-platform',
        platform: platformKey,
        ...baseMessage,
      });
      if (response.taskQueue) {
        renderTaskQueue(response.taskQueue);
        renderTaskLogs(response.taskQueue.logs || []);
      }
      captureFeedback = {
        status: 'success',
        message: summarizeActionResponse(response, '账号档案已绑定'),
      };
      await refreshTaskQueue(false);
      await refreshContext();
      return;
    }
    await sendMessage({
      type: 'xhs:collect-current-blogger',
      ...baseMessage,
    });
    const options = getBloggerNotesOptions();
    const response = await sendMessage({
      type: 'xhs:collect-blogger-notes',
      ...baseMessage,
      options,
    });
    if (response.taskQueue) {
      renderTaskQueue(response.taskQueue);
      renderTaskLogs(response.taskQueue.logs || []);
      renderBloggerNotesPanel({
        ...context,
        queue: response.taskQueue,
      });
    }
    captureFeedback = {
      status: 'success',
      message: summarizeActionResponse(response, '账号学习任务已启动'),
    };
    await refreshTaskQueue(false);
    await refreshContext();
  } catch (error) {
    debugWarn('bind-current-profile-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    captureFeedback = {
      status: 'error',
      message: `绑定和学习失败：${error instanceof Error ? error.message : String(error)}`,
    };
    await refreshTaskQueue(false);
  } finally {
    capturePendingAction = '';
    renderAccountBindingNotice(context, extractHealthPayload(context?.health || {}));
    renderCaptureActions(context);
  }
}

function renderCaptureStatus(message, status = 'idle') {
  elements.captureStatus.textContent = message || '';
  elements.captureStatus.dataset.state = status;
  elements.captureStatus.hidden = !message;
}

function renderBloggerNotesMode() {
  const apiMode = elements.bloggerNotesApiMode.checked;
  elements.bloggerNotesModeLabel.textContent = apiMode ? 'API 模式（更快）' : '传统模式（更稳定）';
  elements.bloggerNotesModePill.textContent = apiMode ? 'API 模式' : '传统模式';
}

function applyBloggerNotesSettings() {
  if (elements.bloggerNotesPanel.dataset.hydrated === 'true') {
    renderBloggerNotesMode();
    return;
  }
  const defaultMode = String(currentSettings?.xhsBloggerCollectionMode || 'api') !== 'tab';
  elements.bloggerNotesApiMode.checked = defaultMode;
  elements.bloggerNotesLimit.value = Number(currentSettings?.xhsBloggerNoteLimit || 50);
  elements.bloggerNotesIntervalMax.value = Math.max(3, Number(currentSettings?.xhsIntervalMaxSeconds || 6));
  elements.bloggerNotesPanel.dataset.hydrated = 'true';
  renderBloggerNotesMode();
}

function getBloggerNotesOptions() {
  const limit = Math.max(1, Math.min(Number(elements.bloggerNotesLimit.value || 50), 200));
  const intervalMaxSeconds = Math.max(3, Math.min(Number(elements.bloggerNotesIntervalMax.value || 6), 60));
  return {
    mode: elements.bloggerNotesApiMode.checked ? 'api' : 'tab',
    limit,
    interval: {
      minSeconds: 3,
      maxSeconds: intervalMaxSeconds,
    },
  };
}

async function startBloggerNotesCollection() {
  if (!USER_PROFILE_FEATURE_ENABLED) return;
  const tabId = Number(context?.tab?.id || 0);
  if (!tabId) {
    renderBloggerNotesProgress({
      label: '未识别到当前标签页',
      meta: '请刷新后重试',
      status: 'error',
    });
    return;
  }
  elements.bloggerNotesStart.disabled = true;
  renderBloggerNotesProgress({
    label: '正在创建采集任务…',
    meta: '准备提交到后台队列',
    status: 'pending',
  });
  try {
    const tab = context?.tab || {};
    const options = getBloggerNotesOptions();
    debugLog('blogger-notes-start', {
      tabId,
      tabUrl: tab.url || '',
      options,
    });
    const response = await sendMessage({
      type: 'xhs:collect-blogger-notes',
      tabId,
      tabUrl: tab.url || '',
      windowId: Number(tab.windowId || 0) || undefined,
      options,
    });
    debugLog('blogger-notes-start-success', response);
    if (response.taskQueue) {
      renderTaskQueue(response.taskQueue);
      renderTaskLogs(response.taskQueue.logs || []);
      renderBloggerNotesPanel({
        ...context,
        queue: response.taskQueue,
      });
    }
    renderBloggerNotesProgress({
      label: '采集任务已启动',
      meta: summarizeActionResponse(response, '采集任务已加入队列'),
      status: 'success',
    });
    await refreshTaskQueue(false);
  } catch (error) {
    debugWarn('blogger-notes-start-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    renderBloggerNotesProgress({
      label: '启动失败',
      meta: error instanceof Error ? error.message : String(error),
      status: 'error',
    });
  } finally {
    elements.bloggerNotesStart.disabled = false;
  }
}

async function controlActiveTask(action) {
  try {
    debugLog('blogger-notes-control', { action });
    const response = await sendMessage({ type: 'xhs:control-active-task', action });
    debugLog('blogger-notes-control-success', response);
    renderTaskQueue(response.queue || {});
    renderTaskLogs(response.queue?.logs || []);
    renderBloggerNotesPanel({
      ...context,
      queue: response.queue || {},
    });
  } catch (error) {
    debugWarn('blogger-notes-control-failed', {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
    renderBloggerNotesProgress({
      label: '操作失败',
      meta: error instanceof Error ? error.message : String(error),
      status: 'error',
    });
  }
}

function renderBloggerNotesProgress({
  label = '',
  status = 'idle',
  current = 0,
  total = 0,
  meta = '',
} = {}) {
  const safeTotal = Math.max(Number(total || 0), 0);
  const safeCurrent = Math.max(Number(current || 0), 0);
  const percentage = safeTotal > 0 ? Math.max(0, Math.min(100, Math.round((safeCurrent / safeTotal) * 100))) : 0;
  const hasContent = Boolean(label || meta || status === 'pending' || status === 'success' || status === 'error');
  elements.bloggerNotesProgress.dataset.state = status;
  elements.bloggerNotesProgress.hidden = !hasContent;
  elements.bloggerNotesProgressLabel.textContent = label || '准备开始采集';
  elements.bloggerNotesProgressPercent.textContent = `${percentage}%`;
  elements.bloggerNotesProgressFill.style.width = `${percentage}%`;
  elements.bloggerNotesProgressMeta.textContent = meta || (safeTotal > 0 ? `已完成 ${safeCurrent} / ${safeTotal}` : '等待任务开始');
}

function renderBloggerNotesPanel(nextContext) {
  if (!USER_PROFILE_FEATURE_ENABLED) {
    elements.bloggerNotesPanel.classList.add('hidden');
    elements.bloggerNotesControls.classList.add('hidden');
    elements.bloggerNotesPause.classList.add('hidden');
    elements.bloggerNotesResume.classList.add('hidden');
    elements.bloggerNotesCancel.classList.add('hidden');
    return;
  }
  const tab = nextContext?.tab || {};
  const pageInfo = nextContext?.pageInfo || {};
  const identity = nextContext?.pageIdentity || {};
  const platform = normalizePlatform(identity.platform || pageInfo.platform || tab.hostname || pageInfo.kind || tab.url);
  const pageType = identity.pageType || inferPageType(pageInfo, tab);
  const visible = platform === 'xhs' && pageType === 'profile';
  elements.bloggerNotesPanel.classList.toggle('hidden', !visible);
  if (!visible) {
    elements.bloggerNotesControls.classList.add('hidden');
    elements.bloggerNotesPause.classList.add('hidden');
    elements.bloggerNotesResume.classList.add('hidden');
    elements.bloggerNotesCancel.classList.add('hidden');
    return;
  }

  applyBloggerNotesSettings();
  const active = nextContext?.queue?.active || null;
  const last = nextContext?.queue?.last || null;
  const isRunning = active?.type === 'xhs:collect-blogger-notes';
  const paused = active?.paused === true;
  const progress = active?.progress || null;
  const disabled = !nextContext?.health?.success || Boolean(capturePendingAction) || isRunning;

  elements.bloggerNotesStart.disabled = disabled;
  elements.bloggerNotesApiMode.disabled = isRunning;
  elements.bloggerNotesLimit.disabled = isRunning;
  elements.bloggerNotesIntervalMax.disabled = isRunning;

  elements.bloggerNotesControls.classList.toggle('hidden', !isRunning);
  elements.bloggerNotesPause.classList.toggle('hidden', !isRunning || paused);
  elements.bloggerNotesResume.classList.toggle('hidden', !isRunning || !paused);
  elements.bloggerNotesCancel.classList.toggle('hidden', !isRunning);

  if (isRunning && progress) {
    renderBloggerNotesProgress({
      label: paused ? '任务已暂停' : (progress.message || '正在采集博主笔记'),
      status: paused ? 'idle' : 'pending',
      current: Number(progress.current || 0),
      total: Number(progress.total || 0),
      meta: `已完成 ${Number(progress.current || 0)} / ${Number(progress.total || 0)}${paused ? ' · 点击继续恢复' : ''}`,
    });
  } else if (!nextContext?.health?.success) {
    renderBloggerNotesProgress({
      label: '桌面端未连接',
      meta: '请先打开 RedBox 桌面端',
      status: 'error',
    });
  } else if (last?.type === 'xhs:collect-blogger-notes' && last?.status === 'cancelled') {
    renderBloggerNotesProgress({
      label: '采集博主笔记已取消',
      meta: `已保存 ${Number(last?.savedCount || 0)} 条`,
      status: 'error',
      current: Number(last?.savedCount || 0),
      total: Math.max(Number(last?.progress?.total || 0), Number(last?.savedCount || 0)),
    });
  } else {
    renderBloggerNotesProgress({
      label: '准备开始采集',
      meta: '设置模式、数量和间隔后即可开始',
      status: 'idle',
    });
  }
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
    if (!USER_PROFILE_FEATURE_ENABLED) {
      return {
        variant: 'xhs-profile-hidden',
        title: 'RedBox 博主采集',
        subtitle: '小红书博主页',
        actions: [],
      };
    }
    return {
      variant: 'xhs-profile',
      title: 'RedBox 博主采集',
      subtitle: '小红书博主页',
      actions: [
        { label: '绑定并学习账号', action: 'blogger', primary: true, title: '绑定当前账号并学习历史内容' },
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
    blogger: { type: 'xhs:collect-current-blogger', pending: '绑定中...', done: '已绑定账号资料' },
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
    renderBloggerNotesPanel({
      ...context,
      queue: response.queue || {},
    });
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
    elements.taskQueueControls.classList.remove('hidden');
    const canPause = active?.capabilities?.pause === true;
    elements.taskQueuePause.classList.toggle('hidden', !canPause || active.paused === true || active.cancelRequested === true);
    elements.taskQueueResume.classList.toggle('hidden', !canPause || active.paused !== true || active.cancelRequested === true);
    elements.taskQueuePause.disabled = active.cancelRequested === true;
    elements.taskQueueResume.disabled = active.cancelRequested === true;
    elements.taskQueueCancel.disabled = active.cancelRequested === true;
    elements.taskQueueCancel.textContent = active.cancelRequested === true ? '停止中' : '停止任务';
    const progressText = active?.progress?.total
      ? `进度 ${Number(active.progress.current || 0)}/${Number(active.progress.total || 0)}`
      : '';
    elements.taskQueueMeta.textContent = [
      active?.paused ? '已暂停' : '',
      progressText,
      active?.progress?.message || '',
      active.startedAt ? `开始 ${formatTime(active.startedAt)}` : '',
      queued.length > 0 ? `后续 ${queued.map((item) => item.title || '任务').slice(0, 2).join('、')}${queued.length > 2 ? '...' : ''}` : '队列无等待任务',
    ].filter(Boolean).join(' · ');
    return;
  }

  elements.taskQueueBadge.textContent = queued.length > 0 ? `排队 ${queued.length}` : '空闲';
  elements.taskQueueBadge.className = 'task-badge';
  elements.taskQueueControls.classList.add('hidden');
  elements.taskQueuePause.classList.add('hidden');
  elements.taskQueueResume.classList.add('hidden');
  elements.taskQueueCancel.disabled = false;
  elements.taskQueueCancel.textContent = '停止任务';
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
