import { getMcpServers, type McpServerConfig } from './mcpStore';

const DEFAULT_VISIBLE_SERVER_LIMIT = 4;
const DEFAULT_MAX_SECTION_CHARS = 1400;

const truncateText = (value: string, limit: number): string => {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...`;
};

const summarizeTransportBreakdown = (servers: McpServerConfig[]): string => {
    const counts = new Map<string, number>();
    for (const server of servers) {
        counts.set(server.transport, (counts.get(server.transport) || 0) + 1);
    }
    return Array.from(counts.entries())
        .sort((left, right) => right[1] - left[1])
        .map(([transport, count]) => `${transport}=${count}`)
        .join(', ');
};

const summarizeServerLine = (server: McpServerConfig): string => {
    const endpoint = server.transport === 'stdio'
        ? `command=${truncateText(server.command || '(missing)', 48)}`
        : `url=${truncateText(server.url || '(missing)', 72)}`;
    const oauth = server.oauth?.enabled ? ' oauth' : '';
    return `- ${server.id}: ${server.name} [${server.transport}${oauth}] ${endpoint}`;
};

export function buildMcpPromptSection(options?: {
    maxVisibleServers?: number;
    maxChars?: number;
    includeDiscoveryGuide?: boolean;
}): string {
    const enabledServers = getMcpServers().filter((server) => server.enabled);
    if (enabledServers.length === 0) {
        return '';
    }

    const maxVisibleServers = options?.maxVisibleServers ?? DEFAULT_VISIBLE_SERVER_LIMIT;
    const maxChars = options?.maxChars ?? DEFAULT_MAX_SECTION_CHARS;
    const includeDiscoveryGuide = options?.includeDiscoveryGuide ?? true;
    const visibleServers = enabledServers.slice(0, maxVisibleServers);
    const hiddenCount = Math.max(0, enabledServers.length - visibleServers.length);
    const oauthCount = enabledServers.filter((server) => server.oauth?.enabled).length;
    const lines: string[] = [
        '## MCP Access',
        `- Enabled MCP servers: ${enabledServers.length}`,
        `- Transport mix: ${summarizeTransportBreakdown(enabledServers) || 'unknown'}`,
        oauthCount > 0 ? `- OAuth-enabled servers: ${oauthCount}` : '',
        '- To preserve prompt budget, detailed MCP tool inventories are intentionally omitted from the system prompt.',
        '- Discover MCP capabilities lazily: list servers first, inspect one server\'s tools second, call a tool only after you know the exact server id and tool name.',
        '',
        '### Visible server index',
        ...visibleServers.map((server) => summarizeServerLine(server)),
        hiddenCount > 0 ? `- (${hiddenCount} more enabled MCP servers omitted from prompt for context compression)` : '',
    ].filter(Boolean);

    if (includeDiscoveryGuide) {
        lines.push(
            '',
            '### Discovery workflow',
            '- `app_cli(command="mcp list --enabled-only true")`',
            '- `app_cli(command="mcp tools --id <server-id>")`',
            '- `app_cli(command="mcp oauth-status --id <server-id>")`',
            '- `app_cli(command="mcp call --id <server-id> --tool <tool-name> --args \\"{...}\\"")`',
        );
    }

    return truncateText(lines.join('\n'), maxChars);
}
