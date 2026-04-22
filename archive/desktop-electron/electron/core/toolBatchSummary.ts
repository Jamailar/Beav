import type { ToolResult } from './toolRegistry';

type ToolBatchItem = {
  name: string;
  args?: Record<string, unknown>;
  result: ToolResult;
};

const verbByTool: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'Listed',
  grep: 'Searched',
  explore_workspace: 'Explored',
  write_file: 'Wrote',
  edit_file: 'Edited',
  bash: 'Ran',
  app_cli: 'Ran',
  save_memory: 'Saved',
  todo_write: 'Updated',
  todo_read: 'Read',
  web_search: 'Searched',
  calculator: 'Calculated',
};

const truncateText = (value: unknown, limit: number): string => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
};

const pickStringArg = (args: Record<string, unknown> | undefined, keys: string[]): string => {
  if (!args) return '';
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const summarizeCommand = (command: string): string => {
  const normalized = truncateText(command, 60);
  if (!normalized) return 'command';
  if (/(\bpnpm\b|\bnpm\b|\byarn\b).*(test|vitest|jest|playwright)/i.test(normalized)) return 'tests';
  if (/(\bpnpm\b|\bnpm\b|\byarn\b).*(build|tsc|vite build)/i.test(normalized)) return 'build';
  if (/\bgit\s+status\b/i.test(normalized)) return 'git status';
  if (/\bgit\s+diff\b/i.test(normalized)) return 'git diff';
  if (/\b(rg|grep)\b/i.test(normalized)) return 'search';
  return normalized;
};

const summarizeAppCliCommand = (command: string): string => {
  const normalized = truncateText(command, 60);
  if (!normalized) return 'app task';
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return normalized;
};

const summarizeSingleTool = (item: ToolBatchItem): string => {
  const args = item.args || {};
  switch (item.name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return `${verbByTool[item.name] || 'Handled'} ${truncateText(pickStringArg(args, ['filePath', 'path']), 48) || 'file'}`;
    case 'list_dir':
      return `Listed ${truncateText(pickStringArg(args, ['path']), 48) || 'directory'}`;
    case 'grep':
      return `Searched ${truncateText(pickStringArg(args, ['pattern', 'query']), 48) || 'workspace'}`;
    case 'explore_workspace':
      return `Explored ${truncateText(pickStringArg(args, ['target']), 48) || 'workspace'}`;
    case 'bash':
      return `Ran ${summarizeCommand(pickStringArg(args, ['cmd', 'command']))}`;
    case 'app_cli':
      return `Ran ${summarizeAppCliCommand(pickStringArg(args, ['command']))}`;
    case 'web_search':
      return `Searched web for ${truncateText(pickStringArg(args, ['query', 'q']), 42) || 'topic'}`;
    case 'save_memory':
      return 'Saved memory';
    case 'todo_write':
      return 'Updated todo list';
    case 'todo_read':
      return 'Read todo list';
    case 'calculator':
      return `Calculated ${truncateText(pickStringArg(args, ['expression']), 42) || 'expression'}`;
    default:
      return `${verbByTool[item.name] || 'Handled'} ${item.name}`;
  }
};

export function summarizeToolBatch(items: ToolBatchItem[]): string | null {
  if (!items.length) return null;
  if (items.length === 1) {
    return summarizeSingleTool(items[0]);
  }

  const allSucceeded = items.every((item) => item.result.success);
  const uniqueNames = Array.from(new Set(items.map((item) => item.name)));
  if (uniqueNames.length === 1) {
    const toolName = uniqueNames[0];
    const action = verbByTool[toolName] || 'Handled';
    const noun = toolName === 'read_file'
      ? 'files'
      : toolName === 'list_dir'
        ? 'directories'
        : toolName === 'grep' || toolName === 'web_search'
          ? 'searches'
          : toolName === 'edit_file' || toolName === 'write_file'
            ? 'files'
            : `${toolName} calls`;
    return `${action} ${items.length} ${noun}${allSucceeded ? '' : ' with failures'}`;
  }

  const prefixes = uniqueNames.slice(0, 3).map((name) => {
    if (name === 'read_file') return 'read';
    if (name === 'list_dir' || name === 'explore_workspace') return 'explored';
    if (name === 'grep' || name === 'web_search') return 'searched';
    if (name === 'edit_file' || name === 'write_file') return 'updated';
    if (name === 'bash' || name === 'app_cli') return 'executed';
    return name;
  });
  const suffix = allSucceeded ? '' : ' with failures';
  return `Tools: ${prefixes.join(', ')}${uniqueNames.length > 3 ? ', ...' : ''}${suffix}`;
}
