const DEFAULT_SETTINGS = {
  knowledgeApiBaseUrl: 'http://127.0.0.1:31937',
  knowledgeApiEndpointPath: '/api/knowledge',
  saveToRedboxByDefault: true,
  autoUpdateCheck: true,
};

const elements = {
  form: document.getElementById('settings-form'),
  apiBaseUrl: document.getElementById('api-base-url'),
  apiEndpointPath: document.getElementById('api-endpoint-path'),
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

function normalizeFormSettings() {
  return {
    knowledgeApiBaseUrl: elements.apiBaseUrl.value.trim() || DEFAULT_SETTINGS.knowledgeApiBaseUrl,
    knowledgeApiEndpointPath: elements.apiEndpointPath.value.trim() || DEFAULT_SETTINGS.knowledgeApiEndpointPath,
    saveToRedboxByDefault: elements.saveDefault.checked,
    autoUpdateCheck: elements.autoUpdate.checked,
  };
}

function renderSettings(settings) {
  const next = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  elements.apiBaseUrl.value = next.knowledgeApiBaseUrl;
  elements.apiEndpointPath.value = next.knowledgeApiEndpointPath;
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
