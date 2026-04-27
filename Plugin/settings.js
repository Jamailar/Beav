const DEFAULT_SETTINGS = {
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

const elements = {
  form: document.getElementById('settings-form'),
  apiBaseUrl: document.getElementById('api-base-url'),
  apiEndpointPath: document.getElementById('api-endpoint-path'),
  intervalMin: document.getElementById('interval-min'),
  intervalMax: document.getElementById('interval-max'),
  bloggerLimit: document.getElementById('blogger-limit'),
  keywordLimit: document.getElementById('keyword-limit'),
  batchLimit: document.getElementById('batch-limit'),
  saveDefault: document.getElementById('save-default'),
  autoUpdate: document.getElementById('auto-update'),
  reset: document.getElementById('reset-settings'),
  testConnection: document.getElementById('test-connection'),
  status: document.getElementById('status'),
};

init().catch((error) => {
  showStatus(error instanceof Error ? error.message : String(error), true);
});

async function init() {
  bindEvents();
  const response = await sendMessage({ type: 'settings:get' });
  renderSettings(response.settings || DEFAULT_SETTINGS);
}

function bindEvents() {
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings();
  });
  elements.reset.addEventListener('click', () => void resetSettings());
  elements.testConnection.addEventListener('click', () => void testConnection());
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || '操作失败'));
        return;
      }
      resolve(response);
    });
  });
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function normalizeFormSettings() {
  let minSeconds = clampNumber(Number(elements.intervalMin.value), 0.5, 60, DEFAULT_SETTINGS.xhsIntervalMinSeconds);
  let maxSeconds = clampNumber(Number(elements.intervalMax.value), 0.5, 60, DEFAULT_SETTINGS.xhsIntervalMaxSeconds);
  if (maxSeconds < minSeconds) {
    [minSeconds, maxSeconds] = [maxSeconds, minSeconds];
  }
  return {
    knowledgeApiBaseUrl: elements.apiBaseUrl.value.trim() || DEFAULT_SETTINGS.knowledgeApiBaseUrl,
    knowledgeApiEndpointPath: elements.apiEndpointPath.value.trim() || DEFAULT_SETTINGS.knowledgeApiEndpointPath,
    xhsIntervalMinSeconds: Math.round(minSeconds * 10) / 10,
    xhsIntervalMaxSeconds: Math.round(maxSeconds * 10) / 10,
    xhsBloggerNoteLimit: Math.round(clampNumber(Number(elements.bloggerLimit.value), 1, 200, DEFAULT_SETTINGS.xhsBloggerNoteLimit)),
    xhsKeywordNoteLimit: Math.round(clampNumber(Number(elements.keywordLimit.value), 1, 50, DEFAULT_SETTINGS.xhsKeywordNoteLimit)),
    xhsLinkBatchLimit: Math.round(clampNumber(Number(elements.batchLimit.value), 1, 50, DEFAULT_SETTINGS.xhsLinkBatchLimit)),
    saveToRedboxByDefault: elements.saveDefault.checked,
    autoUpdateCheck: elements.autoUpdate.checked,
  };
}

function renderSettings(settings) {
  const next = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  elements.apiBaseUrl.value = next.knowledgeApiBaseUrl;
  elements.apiEndpointPath.value = next.knowledgeApiEndpointPath;
  elements.intervalMin.value = next.xhsIntervalMinSeconds;
  elements.intervalMax.value = next.xhsIntervalMaxSeconds;
  elements.bloggerLimit.value = next.xhsBloggerNoteLimit;
  elements.keywordLimit.value = next.xhsKeywordNoteLimit;
  elements.batchLimit.value = next.xhsLinkBatchLimit;
  elements.saveDefault.checked = next.saveToRedboxByDefault !== false;
  elements.autoUpdate.checked = next.autoUpdateCheck !== false;
}

function setBusy(busy) {
  elements.form.querySelectorAll('input, button').forEach((element) => {
    element.disabled = busy;
  });
  elements.testConnection.disabled = busy;
}

async function saveSettings() {
  setBusy(true);
  try {
    const response = await sendMessage({
      type: 'settings:update',
      settings: normalizeFormSettings(),
    });
    renderSettings(response.settings);
    showStatus('设置已保存。', false);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
}

async function resetSettings() {
  setBusy(true);
  try {
    const response = await sendMessage({ type: 'settings:reset' });
    renderSettings(response.settings);
    showStatus('已恢复默认设置。', false);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
}

async function testConnection() {
  setBusy(true);
  try {
    await sendMessage({
      type: 'settings:update',
      settings: normalizeFormSettings(),
    });
    const response = await sendMessage({ type: 'settings:test-connection' });
    showStatus(`连接成功：${response.endpoint || 'Knowledge API'}`, false);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
}

function showStatus(message, isError) {
  elements.status.textContent = message;
  elements.status.className = `status-panel ${isError ? 'error' : 'ok'}`;
}
