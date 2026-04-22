function normalizeBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim();
  if (!text) return 'https://api.openai.com/v1';
  return text.replace(/\/+$/, '');
}

async function configureProxyDispatcher() {
  const proxyUrl = String(
    process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || '',
  ).trim();
  const undici = await import('undici');
  if (proxyUrl) {
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
    return;
  }
  undici.setGlobalDispatcher(new undici.Agent());
}

function joinUrl(baseUrl, pathname) {
  return `${normalizeBaseUrl(baseUrl)}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

let currentAbortController = null;
let currentRunId = null;

setInterval(() => {
  process.send?.({
    type: 'heartbeat',
    runId: currentRunId,
    pid: process.pid,
  });
}, 3000);

async function runJsonTask(runId, payload) {
  const {
    model,
    apiKey,
    baseURL,
    systemPrompt,
    userInput,
    temperature,
  } = payload || {};

  currentAbortController = new AbortController();
  currentRunId = runId;
  process.send?.({
    type: 'progress',
    runId,
    phase: 'starting',
    text: '[worker] json task started',
  });

  const response = await fetch(joinUrl(baseURL, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${String(apiKey || '').trim()}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: String(systemPrompt || '') },
        { role: 'user', content: String(userInput || '') },
      ],
    }),
    signal: currentAbortController.signal,
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Worker API error (${response.status}): ${rawText || response.statusText}`);
  }

  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    throw new Error(`Worker JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const text = extractAssistantText(parsed?.choices?.[0]?.message?.content);
  process.send?.({
    type: 'progress',
    runId,
    phase: 'responding',
    text: text ? text.slice(0, 500) : '[worker] empty response',
  });
  process.send?.({
    type: 'result',
    runId,
    response: text,
    usage: parsed?.usage || null,
    finishReason: parsed?.choices?.[0]?.finish_reason || null,
  });
}

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'abort') {
    if (!message.runId || message.runId === currentRunId) {
      currentAbortController?.abort();
    }
    return;
  }
  if (message.type !== 'run-json-task') return;
  try {
    await runJsonTask(message.runId || null, message.payload);
  } catch (error) {
    process.send?.({
      type: 'error',
      runId: message.runId || null,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    currentAbortController = null;
    currentRunId = null;
  }
});

await configureProxyDispatcher();
process.send?.({ type: 'ready', pid: process.pid });
