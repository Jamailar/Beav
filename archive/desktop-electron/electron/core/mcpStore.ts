import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { getSettings, getWorkspacePaths, saveSettings } from '../db';

export type McpTransportType = 'stdio' | 'sse' | 'streamable-http';

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  oauth?: {
    enabled?: boolean;
    tokenPath?: string;
  };
}

export interface McpConnectionTestResult {
  success: boolean;
  message: string;
  detail?: string;
}

export interface McpLocalConfigDiscovery {
  sourcePath: string;
  servers: McpServerConfig[];
}

const DEFAULT_MCP_SERVERS_JSON = '[]';

const normalizeServerId = (input: string): string => {
  const normalized = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized) return normalized;
  return `mcp-${Date.now()}`;
};

const parseStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
};

const parseStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const text = String(raw || '').trim();
    if (!text) continue;
    next[key] = text;
  }
  return next;
};

const normalizeTransport = (raw: unknown, record: Record<string, unknown>): McpTransportType => {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'stdio' || text === 'sse' || text === 'streamable-http') return text;
  if (typeof record.url === 'string' && record.url.trim()) {
    return 'streamable-http';
  }
  return 'stdio';
};

const normalizeServer = (raw: unknown, fallbackName?: string): McpServerConfig | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = String(record.name || fallbackName || '').trim();
  if (!name) return null;

  const transport = normalizeTransport(record.transport || record.type, record);
  const command = String(record.command || '').trim();
  const url = String(record.url || '').trim();

  if (transport === 'stdio' && !command) return null;
  if ((transport === 'sse' || transport === 'streamable-http') && !url) return null;

  const id = normalizeServerId(String(record.id || name));
  return {
    id,
    name,
    enabled: record.enabled === undefined ? true : Boolean(record.enabled),
    transport,
    command: command || undefined,
    args: parseStringArray(record.args),
    env: parseStringRecord(record.env),
    url: url || undefined,
    oauth: record.oauth && typeof record.oauth === 'object'
      ? {
          enabled: (record.oauth as Record<string, unknown>).enabled === undefined
            ? undefined
            : Boolean((record.oauth as Record<string, unknown>).enabled),
          tokenPath: String((record.oauth as Record<string, unknown>).tokenPath || '').trim() || undefined,
        }
      : undefined,
  };
};

const parseMcpServerList = (raw: unknown): McpServerConfig[] => {
  const candidates: McpServerConfig[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const normalized = normalizeServer(item);
      if (normalized) candidates.push(normalized);
    }
  } else if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;

    if (record.mcpServers && typeof record.mcpServers === 'object' && !Array.isArray(record.mcpServers)) {
      for (const [name, value] of Object.entries(record.mcpServers as Record<string, unknown>)) {
        const normalized = normalizeServer(value, name);
        if (normalized) candidates.push(normalized);
      }
    }

    if (record.servers && Array.isArray(record.servers)) {
      for (const item of record.servers) {
        const normalized = normalizeServer(item);
        if (normalized) candidates.push(normalized);
      }
    }
  }

  const seen = new Set<string>();
  const deduped: McpServerConfig[] = [];
  for (const server of candidates) {
    const key = server.id || normalizeServerId(server.name);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...server, id: key });
  }
  return deduped;
};

const serializeMcpServers = (servers: McpServerConfig[]): string => {
  const normalized = parseMcpServerList(servers).map((server) => ({
    ...server,
    args: server.args || [],
    env: server.env || {},
  }));
  return JSON.stringify(normalized, null, 2);
};

const updateSettingsWithMcpServers = (mcpServersJson: string) => {
  const current = (getSettings() || {}) as Record<string, unknown>;
  saveSettings({
    api_endpoint: String(current.api_endpoint || ''),
    api_key: String(current.api_key || ''),
    model_name: String(current.model_name || ''),
    role_mapping: typeof current.role_mapping === 'string' ? current.role_mapping : JSON.stringify(current.role_mapping || {}),
    workspace_dir: String(current.workspace_dir || ''),
    active_space_id: String(current.active_space_id || ''),
    transcription_model: String(current.transcription_model || ''),
    transcription_endpoint: String(current.transcription_endpoint || ''),
    transcription_key: String(current.transcription_key || ''),
    embedding_endpoint: String(current.embedding_endpoint || ''),
    embedding_key: String(current.embedding_key || ''),
    embedding_model: String(current.embedding_model || ''),
    ai_sources_json: typeof current.ai_sources_json === 'string' ? current.ai_sources_json : JSON.stringify(current.ai_sources_json || []),
    default_ai_source_id: String(current.default_ai_source_id || ''),
    image_provider: String(current.image_provider || ''),
    image_endpoint: String(current.image_endpoint || ''),
    image_api_key: String(current.image_api_key || ''),
    image_model: String(current.image_model || ''),
    image_provider_template: String(current.image_provider_template || ''),
    image_aspect_ratio: String(current.image_aspect_ratio || ''),
    image_size: String(current.image_size || ''),
    image_quality: String(current.image_quality || ''),
    mcp_servers_json: mcpServersJson,
    redclaw_compact_target_tokens: Number(current.redclaw_compact_target_tokens || 256000),
  });
};

export const getMcpServers = (): McpServerConfig[] => {
  const settings = (getSettings() || {}) as Record<string, unknown>;
  const raw = String(settings.mcp_servers_json || DEFAULT_MCP_SERVERS_JSON);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseMcpServerList(parsed);
  } catch {
    return [];
  }
};

export const saveMcpServers = (servers: McpServerConfig[]): McpServerConfig[] => {
  const normalized = parseMcpServerList(servers);
  const payload = serializeMcpServers(normalized);
  updateSettingsWithMcpServers(payload);
  return normalized;
};

const knownLocalMcpConfigPaths = (): string[] => {
  const home = os.homedir();
  return [
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.cursor', 'mcp_config.json'),
    path.join(home, '.claude', 'mcp.json'),
    path.join(home, '.config', 'claude', 'mcp.json'),
    path.join(home, '.codex', 'mcp.json'),
    path.join(home, '.continue', 'config.json'),
    path.join(home, '.vscode', 'extensions', 'saoudrizwan.claude-dev', 'mcp.json'),
  ];
};

export const discoverLocalMcpConfigs = async (): Promise<McpLocalConfigDiscovery[]> => {
  const discovered: McpLocalConfigDiscovery[] = [];
  for (const sourcePath of knownLocalMcpConfigPaths()) {
    try {
      const raw = await fs.readFile(sourcePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const servers = parseMcpServerList(parsed);
      if (servers.length > 0) {
        discovered.push({ sourcePath, servers });
      }
    } catch {
      // Ignore missing/unreadable files.
    }
  }
  return discovered;
};

export const importLocalMcpServers = async (): Promise<{ imported: number; total: number; sources: string[]; servers: McpServerConfig[] }> => {
  const local = await discoverLocalMcpConfigs();
  const existing = getMcpServers();

  const nextById = new Map<string, McpServerConfig>();
  for (const server of existing) {
    nextById.set(server.id, server);
  }

  let imported = 0;
  for (const source of local) {
    for (const server of source.servers) {
      const key = server.id || normalizeServerId(server.name);
      if (!nextById.has(key)) {
        imported += 1;
      }
      nextById.set(key, { ...server, id: key });
    }
  }

  const servers = Array.from(nextById.values());
  saveMcpServers(servers);

  return {
    imported,
    total: servers.length,
    sources: local.map((item) => item.sourcePath),
    servers,
  };
};

const resolveOAuthTokenPath = (server: McpServerConfig): string => {
  const configured = String(server.oauth?.tokenPath || '').trim();
  if (configured) return configured;
  const workspaceBase = getWorkspacePaths().base;
  return path.join(workspaceBase, 'mcp', 'oauth', `${server.id}.json`);
};

export const getMcpOAuthStatus = async (serverId: string): Promise<{ connected: boolean; tokenPath: string }> => {
  const server = getMcpServers().find((item) => item.id === serverId);
  if (!server) {
    throw new Error('MCP server not found');
  }

  const tokenPath = resolveOAuthTokenPath(server);
  try {
    await fs.access(tokenPath);
    return { connected: true, tokenPath };
  } catch {
    return { connected: false, tokenPath };
  }
};

export const testMcpServerConnection = async (server: McpServerConfig): Promise<McpConnectionTestResult> => {
  if (server.transport === 'stdio') {
    if (!server.command) {
      return { success: false, message: '缺少 command，无法测试 stdio MCP 服务' };
    }

    return await new Promise<McpConnectionTestResult>((resolve) => {
      let settled = false;
      const finalize = (result: McpConnectionTestResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const child = spawn(server.command as string, server.args || [], {
        env: { ...process.env, ...(server.env || {}) },
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      const timeout = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        finalize({ success: true, message: `命令可启动：${server.command}` });
      }, 1500);

      child.once('error', (error) => {
        clearTimeout(timeout);
        finalize({ success: false, message: `启动失败：${error.message}` });
      });

      child.once('spawn', () => {
        clearTimeout(timeout);
        setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          finalize({ success: true, message: `命令可启动：${server.command}` });
        }, 300);
      });

      child.once('exit', (code) => {
        if (settled) return;
        clearTimeout(timeout);
        if (code === 0) {
          finalize({ success: true, message: `进程已启动并退出（code=${code})` });
        } else {
          finalize({ success: false, message: `进程退出异常（code=${code ?? 'unknown'}）` });
        }
      });
    });
  }

  const url = String(server.url || '').trim();
  if (!url) {
    return { success: false, message: '缺少 URL，无法测试远程 MCP 服务' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    const ok = response.status < 500;
    return {
      success: ok,
      message: ok
        ? `端点可达（HTTP ${response.status}）`
        : `端点错误（HTTP ${response.status}）`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `连接失败：${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
};
