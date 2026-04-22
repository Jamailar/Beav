const pendingToolBatches = new Map();
let currentAbortController = null;
let currentRunId = null;

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

function now() {
  return Date.now();
}

function nextId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeBaseUrl(baseURL) {
  const fallback = 'https://api.openai.com/v1';
  const raw = String(baseURL || '').trim() || fallback;
  try {
    const url = new URL(raw);
    return url.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

function joinUrl(baseURL, pathname) {
  const root = normalizeBaseUrl(baseURL);
  const suffix = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${root}${suffix}`;
}

function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof item.text === 'string') {
        return item.text;
      }
      return '';
    }).join('');
  }
  return '';
}

function toToolFeedbackMessage(name, content) {
  return {
    role: 'user',
    content: `Tool result from ${name}:\n${content}`,
  };
}

async function callLlm(payload, messages, signal) {
  const response = await fetch(joinUrl(payload.baseURL, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${payload.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: payload.model,
      temperature: payload.temperature ?? 0.6,
      messages,
      tools: Array.isArray(payload.toolSchemas) ? payload.toolSchemas : [],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Runtime LLM error (${response.status}): ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message;
  return {
    content: extractAssistantText(message?.content),
    toolCalls: Array.isArray(message?.tool_calls)
      ? message.tool_calls
        .map((toolCall) => ({
          id: String(toolCall?.id || nextId('tool')),
          name: String(toolCall?.function?.name || ''),
          args: (() => {
            try {
              return JSON.parse(String(toolCall?.function?.arguments || '{}'));
            } catch {
              return {};
            }
          })(),
        }))
        .filter((toolCall) => toolCall.name)
      : [],
    finishReason: typeof data?.choices?.[0]?.finish_reason === 'string'
      ? data.choices[0].finish_reason
      : undefined,
    usage: data?.usage || undefined,
  };
}

function waitForToolResults(runId, calls) {
  return new Promise((resolve, reject) => {
    pendingToolBatches.set(runId, { resolve, reject });
    process.send?.({
      type: 'tool-call-batch',
      runId,
      calls,
    });
  });
}

async function runQueryTask(runId, payload) {
  const startedAt = now();
  const maxTurns = Number(payload.maxTurns || 24);
  const maxTimeMs = Number(payload.maxTimeMinutes || 12) * 60 * 1000;
  let continuationCount = 0;
  let lastContinuationDelta = 0;
  let turnCount = 0;
  let responseText = '';
  let messages = [
    { role: 'system', content: payload.systemPrompt },
    ...(Array.isArray(payload.messages) ? payload.messages : []),
    { role: 'user', content: payload.userInput },
  ];

  process.send?.({ type: 'progress', runId, phase: 'starting', text: '[worker] runtime task started' });

  while (turnCount < maxTurns) {
    if (currentRunId !== runId) {
      throw new Error('Runtime worker run invalidated');
    }
    if (now() - startedAt > maxTimeMs) {
      throw new Error('Query runtime timeout');
    }
    if (currentAbortController?.signal.aborted) {
      throw new Error('Query runtime cancelled');
    }

    turnCount += 1;

    const llmResponse = await callLlm(payload, messages, currentAbortController?.signal);

    if (Array.isArray(llmResponse.toolCalls) && llmResponse.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: llmResponse.content || '' });
      const thoughtText = String(llmResponse.content || '').trim();
      if (thoughtText) {
        process.send?.({
          type: 'progress',
          runId,
          phase: 'tooling',
          text: thoughtText,
        });
      }
      const toolResults = await waitForToolResults(runId, llmResponse.toolCalls);
      const feedback = Array.isArray(toolResults?.results) ? toolResults.results : [];
      messages.push(...feedback.map((item) => toToolFeedbackMessage(item.toolName, item.promptText || '')));
      continue;
    }

    responseText = llmResponse.content || '';
    process.send?.({
      type: 'progress',
      runId,
      phase: 'responding',
      text: responseText ? responseText.slice(0, 1200) : `Turn ${turnCount}: preparing final response`,
    });

    const shouldContinueForLength =
      llmResponse.finishReason === 'length' &&
      continuationCount < 3 &&
      !(continuationCount >= 2 && responseText.length <= 500 && lastContinuationDelta <= 500);
    if (shouldContinueForLength) {
      continuationCount += 1;
      lastContinuationDelta = responseText.length;
      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content: `Continue exactly from where you stopped. Do not repeat prior content. This is continuation ${continuationCount}.`,
      });
      process.send?.({
        type: 'progress',
        runId,
        phase: 'responding',
        text: `Response hit model output limit, continuing (${continuationCount}/3)`,
      });
      continue;
    }

    return {
      response: responseText,
      usage: llmResponse.usage,
      finishReason: llmResponse.finishReason ?? null,
    };
  }

  throw new Error('Query runtime exceeded max turns');
}

async function handleRunQueryTask(runId, payload) {
  currentRunId = runId;
  currentAbortController = new AbortController();
  try {
    const result = await runQueryTask(runId, payload);
    process.send?.({
      type: 'result',
      runId,
      response: result.response,
      usage: result.usage,
      finishReason: result.finishReason,
    });
  } catch (error) {
    process.send?.({
      type: 'error',
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    currentRunId = null;
    currentAbortController = null;
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'abort') {
    if (!message.runId || message.runId === currentRunId) {
      currentAbortController?.abort();
    }
    return;
  }

  if (message.type === 'tool-result-batch') {
    const pending = pendingToolBatches.get(message.runId);
    if (!pending) return;
    pendingToolBatches.delete(message.runId);
    if (message.error) {
      pending.reject(new Error(String(message.error)));
      return;
    }
    pending.resolve({ results: Array.isArray(message.results) ? message.results : [] });
    return;
  }

  if (message.type === 'run-query-task') {
    void handleRunQueryTask(message.runId, message.payload || {});
  }
});

setInterval(() => {
  process.send?.({
    type: 'heartbeat',
    runId: currentRunId,
    pid: process.pid,
  });
}, 3000);

await configureProxyDispatcher();
process.send?.({ type: 'ready', pid: process.pid });
