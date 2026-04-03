const serverStatusEl = document.getElementById('server-status');
const pageMetaEl = document.getElementById('page-meta');
const resultEl = document.getElementById('result');

const buttons = {
  primary: document.getElementById('save-primary'),
  pageLink: document.getElementById('save-page-link'),
};

let activeTab = null;
const actionSupport = {
  primary: false,
  pageLink: false,
};
let primaryActionType = 'save-page-link';
let captureTypeEl = null;

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

  const inspect = await sendMessage({ type: 'inspect-page', tabId: activeTab?.id || 0 }).catch(() => null);
  const pageInfo = inspect?.pageInfo || inferPageInfoFromUrl(url) || {
    kind: 'generic',
    action: 'save-page-link',
    label: '保存当前页面链接到知识库',
    description: '当前页面可作为链接收藏保存到知识库。',
    primaryEnabled: true,
  };
  primaryActionType = pageInfo.action || 'save-page-link';

  buttons.primary.textContent = pageInfo.label || '保存到知识库';
  buttons.pageLink.textContent = '仅保存链接到知识库';
  ensureCaptureTypeElement();
  captureTypeEl.textContent = pageInfo.description || '';

  actionSupport.primary = Boolean(activeTab?.id) && pageInfo.primaryEnabled !== false;
  actionSupport.pageLink = Boolean(activeTab?.id);

  applyButtonState(buttons.primary, actionSupport.primary);
  applyButtonState(buttons.pageLink, actionSupport.pageLink);

  buttons.primary.addEventListener('click', () => runAction(primaryActionType));
  buttons.pageLink.addEventListener('click', () => runAction('save-page-link'));
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
    };
  }

  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') {
    const isVideoPage = pathname.startsWith('/watch') || pathname.startsWith('/shorts/') || hostname === 'youtu.be';
    if (isVideoPage) {
      return {
        kind: 'youtube',
        action: 'save-youtube',
        label: '保存youtube视频到知识库',
        description: '当前页面已识别为 YouTube 视频页。',
        primaryEnabled: true,
      };
    }
  }

  if (/(^|\.)xiaohongshu\.com$/i.test(hostname)) {
    return {
      kind: 'xhs-pending',
      action: 'save-xhs',
      label: '未检测到有效内容请刷新',
      description: '当前页面还没有稳定识别到有效的小红书笔记内容。',
      primaryEnabled: false,
    };
  }

  return null;
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

function setBusy(busy) {
  applyButtonState(buttons.primary, !busy && actionSupport.primary);
  applyButtonState(buttons.pageLink, !busy && actionSupport.pageLink);
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
