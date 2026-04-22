import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

export type ProcessItemType =
  | 'phase'
  | 'thought'
  | 'tool-call'
  | 'skill'
  | 'cli-install'
  | 'cli-exec'
  | 'cli-escalation'
  | 'cli-verify';

export interface ProcessItem {
  id: string;
  type: ProcessItemType;
  title?: string;
  content: string;
  status: 'running' | 'done' | 'failed';
  toolData?: {
    callId?: string;
    name: string;
    input: unknown;
    output?: string;
  };
  skillData?: {
    name: string;
    description: string;
  };
  cliData?: {
    executionId?: string;
    installId?: string;
    escalationId?: string;
    toolName?: string;
    environmentId?: string;
    argv?: string[];
    cwd?: string;
    installMethod?: string;
    spec?: string;
    commandPreview?: string;
    logPreview?: string;
    verificationSummary?: string;
    permissions?: string[];
    resolutionScope?: string;
  };
  duration?: number;
  timestamp: number;
}

interface ProcessTimelineProps {
  items: ProcessItem[];
  isStreaming?: boolean;
  variant?: 'default' | 'compact';
}

type SummaryItem = {
  id: string;
  status: 'running' | 'done' | 'failed';
  label: string;
  desc: string;
  input?: string;
  output?: string;
};

const getToolDisplayLabel = (name: string): string => {
  const labelMap: Record<string, string> = {
    save_memory: '写入记忆',
    read_file: '读取文件',
    write_file: '写入文件',
    edit_file: '编辑文件',
    list_dir: '列出目录',
    grep: '内容搜索',
    app_cli: '应用命令',
    bash: '终端执行',
    run_command: '终端执行',
    web_search: '联网搜索',
    duckduckgo_search: '联网搜索',
    calculator: '计算器',
    explore_workspace: '工作区浏览',
    workspace: '工作区操作',
  };
  return labelMap[name] || name;
};

const stringifyValue = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const toObjectIfJsonLike = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
};

const getToolSummary = (toolName: string, input: unknown): string => {
  const inputObject = toObjectIfJsonLike(input);
  if (!inputObject) return '';

  const pickText = (...keys: string[]): string => {
    for (const key of keys) {
      const value = inputObject[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  if (toolName === 'app_cli') return pickText('action', 'command');
  if (toolName === 'redbox_fs') {
    const action = pickText('action');
    const target = pickText('path', 'pattern', 'query');
    if (action && target) return `${action} · ${target}`;
    return action || target;
  }
  if (toolName === 'redbox_editor') return pickText('action', 'filePath');
  if (toolName === 'bash' || toolName === 'run_command') return pickText('cmd', 'command');
  if (toolName === 'workspace') return pickText('action', 'path', 'query');
  if (toolName === 'read_file') return pickText('filePath', 'path');
  if (toolName === 'write_file' || toolName === 'edit_file') return pickText('filePath', 'path');
  if (toolName === 'list_dir') return pickText('path');
  if (toolName === 'explore_workspace') return pickText('target');
  if (toolName === 'web_search' || toolName === 'duckduckgo_search') return pickText('query', 'q');
  return '';
};

const truncateText = (text: string, maxLength = 800): string => {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...`;
};

const stringifyCliCommand = (argv?: string[], fallback?: string): string => {
  if (Array.isArray(argv) && argv.length > 0) {
    return argv.join(' ');
  }
  return String(fallback || '').trim();
};

const getStatusTone = (status: SummaryItem['status']) => {
  if (status === 'running') {
    return {
      dot: 'bg-blue-500 animate-pulse',
      badge: 'processing',
      text: '运行中',
    };
  }
  if (status === 'failed') {
    return {
      dot: 'bg-red-500',
      badge: 'error',
      text: '失败',
    };
  }
  return {
    dot: 'bg-emerald-500',
    badge: 'success',
    text: '完成',
  };
};

const buildSummaryItem = (item: ProcessItem): SummaryItem | null => {
  if (item.type === 'tool-call') {
    const name = item.toolData?.name || 'tool_call';
    return {
      id: item.id,
      status: item.status,
      label: getToolDisplayLabel(name),
      desc: getToolSummary(name, item.toolData?.input) || item.content || name,
      input: stringifyValue(item.toolData?.input),
      output: item.toolData?.output ? truncateText(item.toolData.output) : '',
    };
  }

  if (item.type === 'skill') {
    return {
      id: item.id,
      status: item.status,
      label: item.skillData?.name || item.title || '技能',
      desc: item.skillData?.description || truncateText(item.content || '', 180),
      output: '',
    };
  }

  if (item.type === 'cli-install') {
    const toolName = item.cliData?.toolName || item.title || 'CLI 安装';
    const parts = [
      item.cliData?.installMethod,
      item.cliData?.spec,
      item.cliData?.environmentId ? `env ${item.cliData.environmentId}` : '',
    ].filter(Boolean);
    return {
      id: item.id,
      status: item.status,
      label: `安装 ${toolName}`,
      desc: parts.join(' · ') || item.content || toolName,
      input: stringifyValue({
        installId: item.cliData?.installId,
        environmentId: item.cliData?.environmentId,
        installMethod: item.cliData?.installMethod,
        spec: item.cliData?.spec,
      }),
      output: item.cliData?.logPreview ? truncateText(item.cliData.logPreview, 1200) : '',
    };
  }

  if (item.type === 'cli-exec') {
    const toolName = item.cliData?.toolName || item.title || 'CLI 执行';
    const commandPreview = stringifyCliCommand(item.cliData?.argv, item.cliData?.commandPreview);
    return {
      id: item.id,
      status: item.status,
      label: toolName,
      desc: commandPreview || item.content || '执行外部命令',
      input: stringifyValue({
        executionId: item.cliData?.executionId,
        command: commandPreview,
        cwd: item.cliData?.cwd,
        environmentId: item.cliData?.environmentId,
      }),
      output: item.cliData?.logPreview ? truncateText(item.cliData.logPreview, 1200) : '',
    };
  }

  if (item.type === 'cli-escalation') {
    return {
      id: item.id,
      status: item.status,
      label: item.title || '权限确认',
      desc: item.content || 'CLI 请求额外权限',
      input: stringifyValue({
        escalationId: item.cliData?.escalationId,
        commandPreview: item.cliData?.commandPreview,
        permissions: item.cliData?.permissions,
      }),
      output: truncateText(
        [
          item.cliData?.resolutionScope ? `scope: ${item.cliData.resolutionScope}` : '',
          item.content,
        ].filter(Boolean).join('\n'),
        1200,
      ),
    };
  }

  if (item.type === 'cli-verify') {
    return {
      id: item.id,
      status: item.status,
      label: item.title || '结果校验',
      desc: item.cliData?.verificationSummary || item.content || '执行后校验',
      input: stringifyValue({
        executionId: item.cliData?.executionId,
      }),
      output: item.cliData?.verificationSummary ? truncateText(item.cliData.verificationSummary, 1200) : '',
    };
  }

  return null;
};

export function ProcessTimeline({ items, isStreaming, variant = 'default' }: ProcessTimelineProps) {
  if (!items || items.length === 0) return null;

  const isCompact = variant === 'compact';
  const summaryItems = useMemo(
    () => items.map(buildSummaryItem).filter((item): item is SummaryItem => Boolean(item)),
    [items],
  );
  const runningCount = summaryItems.filter((item) => item.status === 'running').length;
  const failedCount = summaryItems.filter((item) => item.status === 'failed').length;
  const [expanded, setExpanded] = useState(() => Boolean(isStreaming));

  useEffect(() => {
    if (runningCount > 0 || isStreaming) {
      setExpanded(true);
    }
  }, [runningCount, isStreaming]);

  if (summaryItems.length === 0) return null;

  return (
    <div
      className={clsx(
        'w-full max-w-[780px] overflow-hidden rounded-lg border border-border/70 bg-surface-primary/60',
        isCompact ? 'mt-2' : 'mt-3',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-secondary/45"
      >
        <div className="flex min-w-0 items-center gap-2 text-xs text-text-tertiary">
          <span
            className={clsx(
              'inline-flex h-2 w-2 shrink-0 rounded-full',
              runningCount > 0 || isStreaming ? 'bg-amber-500 animate-pulse' : failedCount > 0 ? 'bg-red-500' : 'bg-slate-400',
            )}
          />
          <span className="truncate">
            查看执行过程
            <span className="ml-1 text-text-tertiary/80">({summaryItems.length})</span>
          </span>
          {runningCount > 0 && <span className="text-blue-500">{runningCount} 运行中</span>}
          {failedCount > 0 && <span className="text-red-500">{failedCount} 失败</span>}
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-text-tertiary" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" />
        )}
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-border/60 px-3 py-3">
          {summaryItems.map((item) => {
            const tone = getStatusTone(item.status);
            const hasDetail = Boolean((item.input && item.input.trim()) || (item.output && item.output.trim()));

            return (
              <details
                key={item.id}
                className="border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
                open={item.status === 'running'}
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-text-secondary marker:hidden">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-full', tone.dot)} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-text-primary">{item.label}</span>
                    {item.desc && <span className="ml-1 text-text-tertiary">({item.desc})</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-tertiary">{tone.text}</span>
                  {hasDetail ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-tertiary" /> : null}
                </summary>

                {hasDetail && (
                  <div className="ml-4 mt-2 space-y-2 border-l-2 border-border/70 pl-3">
                    {item.input && item.input.trim() && (
                      <div>
                        <div className="mb-1 text-[11px] font-medium text-text-tertiary">Input</div>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-secondary/60 px-3 py-2 text-xs text-text-secondary">
                          {item.input}
                        </pre>
                      </div>
                    )}
                    {item.output && item.output.trim() && (
                      <div>
                        <div className="mb-1 text-[11px] font-medium text-text-tertiary">Output</div>
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-secondary/60 px-3 py-2 text-xs text-text-secondary">
                          {item.output}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
