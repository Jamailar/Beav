let webMcpEventPublisher = null;

export function configureWebMcpTelemetry(publisher) {
  webMcpEventPublisher = typeof publisher === 'function' ? publisher : null;
}

export async function listWebMcpTools(action = {}) {
  const tabId = normalizeTabId(action.tabId ?? action.tab_id);
  if (!tabId) throw new Error('webmcp_list_tools requires tabId');
  const frameId = normalizeFrameId(action.frameId ?? action.frame_id);
  const executed = await executeInPage(tabId, frameId, listWebMcpToolsInPage);
  const result = executed?.[0]?.result || { tools: [], available: false };
  const tools = Array.isArray(result.tools) ? result.tools.map(normalizeToolMetadata).filter((tool) => tool.name) : [];
  await publishWebMcpEvent('webmcp.tools.listed', {
    tabId,
    frameId,
    available: result.available === true,
    toolCount: tools.length,
    pageUrl: result.pageUrl || '',
  });
  return {
    success: true,
    tabId,
    frameId,
    available: result.available === true,
    tools,
    toolCount: tools.length,
    pageUrl: result.pageUrl || '',
    checkedAt: new Date().toISOString(),
  };
}

export async function invokeWebMcpTool(action = {}) {
  const tabId = normalizeTabId(action.tabId ?? action.tab_id);
  if (!tabId) throw new Error('webmcp_invoke_tool requires tabId');
  const toolName = String(action.toolName || action.tool_name || action.name || '').trim();
  if (!toolName) throw new Error('webmcp_invoke_tool requires toolName');
  const frameId = normalizeFrameId(action.frameId ?? action.frame_id);
  const timeoutMs = clamp(Number(action.timeoutMs || action.timeout_ms || 10_000), 500, 30_000);
  const executed = await executeInPage(tabId, frameId, invokeWebMcpToolInPage, [toolName, action.input ?? {}, timeoutMs]);
  const result = executed?.[0]?.result || {};
  if (result.success === false) {
    const error = new Error(result.error || 'webmcp tool invocation failed');
    error.code = result.code || 'webmcp_invoke_failed';
    throw error;
  }
  await publishWebMcpEvent('webmcp.tool.invoked', {
    tabId,
    frameId,
    toolName,
    timeoutMs,
    pageUrl: result.pageUrl || '',
  });
  return {
    success: true,
    tabId,
    frameId,
    toolName,
    result: result.result,
    pageUrl: result.pageUrl || '',
    completedAt: new Date().toISOString(),
  };
}

async function executeInPage(tabId, frameId, func, args = []) {
  const target = frameId == null ? { tabId } : { tabId, frameIds: [frameId] };
  return await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func,
    args,
  });
}

function listWebMcpToolsInPage() {
  const context = navigator.modelContext;
  const pageUrl = location.href;
  if (!context) return { available: false, tools: [], pageUrl };
  const normalizeTool = (tool) => {
    if (!tool || typeof tool !== 'object') return null;
    const name = String(tool.name || tool.id || '').trim();
    if (!name) return null;
    return {
      name,
      title: typeof tool.title === 'string' ? tool.title : undefined,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      input_schema: tool.input_schema || tool.inputSchema || tool.schema || {},
      annotations: normalizeToolAnnotations(tool.annotations),
      origin: tool.origin || location.origin,
      pageUrl: tool.pageUrl || pageUrl,
    };
  };
  const normalizeToolAnnotations = (annotations = {}) => {
    const normalized = {};
    if (annotations && typeof annotations === 'object') {
      if (typeof annotations.readOnlyHint === 'boolean') normalized.readOnlyHint = annotations.readOnlyHint;
      if (typeof annotations.untrustedContentHint === 'boolean') normalized.untrustedContentHint = annotations.untrustedContentHint;
    }
    return normalized;
  };
  const resolveTools = async () => {
    if (typeof context.listTools === 'function') return await context.listTools();
    if (typeof context.getTools === 'function') return await context.getTools();
    if (typeof context.tools === 'function') return await context.tools();
    return context.tools;
  };
  return Promise.resolve(resolveTools()).then((raw) => {
    const tools = Array.isArray(raw) ? raw : (Array.isArray(raw?.tools) ? raw.tools : []);
    return {
      available: true,
      tools: tools.map(normalizeTool).filter(Boolean),
      pageUrl,
    };
  }).catch((error) => ({
    available: true,
    tools: [],
    pageUrl,
    error: error instanceof Error ? error.message : String(error),
  }));
}

function invokeWebMcpToolInPage(toolName, input, timeoutMs) {
  const context = navigator.modelContext;
  const pageUrl = location.href;
  if (!context) {
    return { success: false, code: 'webmcp_context_unavailable', error: 'navigator.modelContext is not available', pageUrl };
  }
  const findTool = async () => {
    const raw = typeof context.listTools === 'function'
      ? await context.listTools()
      : (typeof context.getTools === 'function'
        ? await context.getTools()
        : (typeof context.tools === 'function' ? await context.tools() : context.tools));
    const tools = Array.isArray(raw) ? raw : (Array.isArray(raw?.tools) ? raw.tools : []);
    return tools.find((tool) => String(tool?.name || tool?.id || '') === toolName) || null;
  };
  const invoke = async () => {
    if (typeof context.invokeTool === 'function') return await context.invokeTool(toolName, input);
    if (typeof context.callTool === 'function') return await context.callTool(toolName, input);
    if (typeof context.executeTool === 'function') return await context.executeTool(toolName, input);
    const tool = await findTool();
    if (!tool) {
      return { success: false, code: 'webmcp_tool_not_found', error: `WebMCP tool not found: ${toolName}`, pageUrl };
    }
    if (typeof tool.invoke === 'function') return await tool.invoke(input);
    if (typeof tool.call === 'function') return await tool.call(input);
    if (typeof tool.execute === 'function') return await tool.execute(input);
    return { success: false, code: 'webmcp_tool_unavailable', error: `WebMCP tool is not invokable: ${toolName}`, pageUrl };
  };
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ success: false, code: 'webmcp_timeout', error: `WebMCP tool timed out after ${timeoutMs}ms`, pageUrl }), timeoutMs);
  });
  return Promise.race([
    Promise.resolve(invoke()).then((result) => ({ success: true, result, pageUrl })).catch((error) => ({
      success: false,
      code: 'webmcp_invoke_failed',
      error: error instanceof Error ? error.message : String(error),
      pageUrl,
    })),
    timeout,
  ]);
}

function normalizeToolMetadata(tool = {}) {
  return {
    name: String(tool.name || '').trim(),
    title: String(tool.title || ''),
    description: String(tool.description || ''),
    input_schema: tool.input_schema || tool.inputSchema || {},
    annotations: normalizeAnnotations(tool.annotations),
    origin: String(tool.origin || ''),
    pageUrl: String(tool.pageUrl || ''),
  };
}

function normalizeAnnotations(annotations = {}) {
  const normalized = {};
  if (annotations && typeof annotations === 'object') {
    if (typeof annotations.readOnlyHint === 'boolean') normalized.readOnlyHint = annotations.readOnlyHint;
    if (typeof annotations.untrustedContentHint === 'boolean') normalized.untrustedContentHint = annotations.untrustedContentHint;
  }
  return normalized;
}

function normalizeTabId(value) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeFrameId(value) {
  if (value == null || value === '') return 0;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

async function publishWebMcpEvent(kind, payload = {}) {
  if (!webMcpEventPublisher) return null;
  try {
    return await webMcpEventPublisher({
      kind,
      ...payload,
      emittedBy: 'webMcpRuntime',
    });
  } catch {
    return null;
  }
}
