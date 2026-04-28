import React, { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';

export type ProcessItemType =
  | 'phase'
  | 'thought'
  | 'error'
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
  failureTone?: 'danger' | 'neutral';
}

type StatusLine = {
  id: string;
  status: 'running' | 'done' | 'failed';
  text: string;
  detail?: string;
  preserveDetail?: boolean;
  forceDanger?: boolean;
};

const COLLAPSED_STATUS_LINE_COUNT = 4;

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

const textAtPath = (source: Record<string, unknown> | null, path: string): string => {
  if (!source) return '';
  const parts = path.split('.');
  let value: unknown = source;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === 'string' && value.trim() ? value.trim() : '';
};

const numberAtPath = (source: Record<string, unknown> | null, path: string): number | null => {
  if (!source) return null;
  const parts = path.split('.');
  let value: unknown = source;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const pickText = (source: Record<string, unknown> | null, ...paths: string[]): string => {
  for (const path of paths) {
    const value = textAtPath(source, path);
    if (value) return value;
  }
  return '';
};

const truncateInline = (value: string, maxLength = 96): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}...`;
};

const truncateDetail = (value: string, maxLength = 360): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}...`;
};

const normalizeActionName = (toolName: string, inputObject: Record<string, unknown> | null): string => {
  const explicitAction = pickText(inputObject, 'action', 'command');
  if (explicitAction) return explicitAction;

  const resource = pickText(inputObject, 'resource');
  const operation = pickText(inputObject, 'operation');
  if (resource && operation) return `${resource}.${operation}`;

  return toolName;
};

const statusVerb = (
  status: StatusLine['status'],
  running: string,
  done: string,
  failed: string,
): string => {
  if (status === 'running') return running;
  if (status === 'failed') return failed;
  return done;
};

const getHumanStatusText = (toolName: string, actionName: string, status: StatusLine['status']): string => {
  const normalizedTool = toolName.trim();
  const normalizedAction = actionName.trim();

  if (normalizedAction === 'image.generate' || normalizedAction === 'image.generation.generate') {
    return statusVerb(status, '正在生成图片', '已生成图片', '图片生成失败');
  }
  if (normalizedAction === 'video.generate') {
    return statusVerb(status, '正在生成视频', '已生成视频', '视频生成失败');
  }
  if (normalizedAction === 'tools.search') {
    return statusVerb(status, '正在查找可用能力', '已查找可用能力', '能力查找失败');
  }
  if (normalizedAction.startsWith('memory.')) {
    return statusVerb(status, '正在处理记忆', '已处理记忆', '记忆处理失败');
  }
  if (normalizedAction.startsWith('knowledge.') || normalizedAction.startsWith('subjects.')) {
    if (normalizedAction.includes('.search')) {
      return statusVerb(status, '正在搜索知识库', '已搜索知识库', '知识库搜索失败');
    }
    return statusVerb(status, '正在读取知识库', '已读取知识库', '知识库读取失败');
  }
  if (normalizedAction.startsWith('workspace.')) {
    if (normalizedAction.includes('.search')) {
      return statusVerb(status, '正在搜索工作区', '已搜索工作区', '工作区搜索失败');
    }
    if (normalizedAction.includes('.list')) {
      return statusVerb(status, '正在浏览工作区', '已浏览工作区', '工作区浏览失败');
    }
    return statusVerb(status, '正在读取工作区', '已读取工作区', '工作区读取失败');
  }
  if (normalizedAction.startsWith('redclaw.task.')) {
    return statusVerb(status, '正在处理 RedClaw 任务', '已处理 RedClaw 任务', 'RedClaw 任务处理失败');
  }
  if (normalizedAction.startsWith('manuscripts.')) {
    return statusVerb(status, '正在处理稿件', '已处理稿件', '稿件处理失败');
  }
  if (normalizedAction.startsWith('mcp.')) {
    return statusVerb(status, '正在连接外部服务', '已连接外部服务', '外部服务调用失败');
  }
  if (normalizedAction.startsWith('skills.')) {
    return statusVerb(status, '正在使用技能', '已使用技能', '技能执行失败');
  }
  if (normalizedAction.startsWith('cli_runtime.') || normalizedTool === 'bash' || normalizedTool === 'run_command') {
    return statusVerb(status, '正在执行命令', '已执行命令', '命令执行失败');
  }
  if (normalizedTool === 'Read' || normalizedTool === 'read_file' || normalizedAction.includes('read')) {
    return statusVerb(status, '正在读取文件', '已读取文件', '文件读取失败');
  }
  if (normalizedTool === 'List' || normalizedTool === 'list_dir' || normalizedAction.includes('list')) {
    return statusVerb(status, '正在浏览文件', '已浏览文件', '文件浏览失败');
  }
  if (normalizedTool === 'Search' || normalizedTool === 'grep' || normalizedTool === 'web_search' || normalizedTool === 'duckduckgo_search' || normalizedAction.includes('search')) {
    return statusVerb(status, '正在搜索内容', '已搜索内容', '内容搜索失败');
  }
  if (normalizedTool === 'Write' || normalizedTool === 'write_file' || normalizedTool === 'edit_file' || normalizedTool === 'redbox_editor' || normalizedAction.includes('write') || normalizedAction.includes('edit')) {
    return statusVerb(status, '正在编辑文件', '已编辑文件', '文件编辑失败');
  }
  if (normalizedTool.startsWith('task_node:')) {
    return statusVerb(status, '正在执行任务节点', '已执行任务节点', '任务节点失败');
  }
  if (normalizedTool.startsWith('subagent:')) {
    return statusVerb(status, '正在启动协作成员', '已启动协作成员', '协作成员启动失败');
  }

  return statusVerb(status, '正在处理', '已处理', '处理失败');
};

const getProgressText = (output: string | undefined): string => {
  const value = String(output || '');
  const match = value.match(/已完成\s*\d+\s*\/\s*\d+\s*张/);
  return match ? match[0].replace(/\s+/g, ' ') : '';
};

const getDetailText = (
  toolName: string,
  actionName: string,
  inputObject: Record<string, unknown> | null,
  output: string | undefined,
): string => {
  const progress = getProgressText(output);
  if (progress) return progress;

  if (actionName === 'image.generate' || actionName === 'video.generate') {
    const count = numberAtPath(inputObject, 'input.count') ?? numberAtPath(inputObject, 'count');
    const aspectRatio = pickText(inputObject, 'input.aspectRatio', 'aspectRatio');
    const size = pickText(inputObject, 'input.size', 'size');
    return [count ? `${count} 个结果` : '', aspectRatio, size].filter(Boolean).join(' · ');
  }

  const query = pickText(inputObject, 'input.query', 'input.q', 'query', 'q', 'pattern');
  if (query) return truncateInline(query);

  const path = pickText(inputObject, 'input.path', 'input.filePath', 'path', 'filePath', 'cwd');
  if (path) return truncateInline(path);

  const prompt = pickText(inputObject, 'input.prompt', 'prompt');
  if (prompt && (actionName === 'tools.search' || toolName === 'Search')) {
    return truncateInline(prompt);
  }

  return '';
};

const stringifyCliCommand = (argv?: string[], fallback?: string): string => {
  if (Array.isArray(argv) && argv.length > 0) {
    return argv.join(' ');
  }
  return String(fallback || '').trim();
};

const buildStatusLine = (item: ProcessItem): StatusLine | null => {
  if (item.type === 'error') {
    return {
      id: item.id,
      status: 'failed',
      text: item.title || 'AI 请求失败',
      detail: truncateDetail(item.content || ''),
      preserveDetail: true,
      forceDanger: true,
    };
  }

  if (item.type === 'tool-call') {
    const name = item.toolData?.name || 'tool_call';
    const inputObject = toObjectIfJsonLike(item.toolData?.input);
    const actionName = normalizeActionName(name, inputObject);
    const detail = getDetailText(name, actionName, inputObject, item.toolData?.output || item.content);
    return {
      id: item.id,
      status: item.status,
      text: getHumanStatusText(name, actionName, item.status),
      detail,
    };
  }

  if (item.type === 'skill') {
    const skillName = truncateInline(item.skillData?.name || item.title || '技能');
    return {
      id: item.id,
      status: item.status,
      text: statusVerb(item.status, '正在使用技能', '已使用技能', '技能执行失败'),
      detail: skillName,
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
      text: statusVerb(item.status, '正在安装命令环境', '已安装命令环境', '命令环境安装失败'),
      detail: truncateInline(parts.join(' · ') || item.content || toolName),
    };
  }

  if (item.type === 'cli-exec') {
    const toolName = item.cliData?.toolName || item.title || 'CLI 执行';
    const commandPreview = stringifyCliCommand(item.cliData?.argv, item.cliData?.commandPreview);
    return {
      id: item.id,
      status: item.status,
      text: statusVerb(item.status, '正在执行命令', '已执行命令', '命令执行失败'),
      detail: truncateInline(commandPreview || item.content || toolName),
    };
  }

  if (item.type === 'cli-escalation') {
    return {
      id: item.id,
      status: item.status,
      text: statusVerb(item.status, '等待确认', '已确认', '确认未通过'),
      detail: truncateInline(item.content || item.cliData?.commandPreview || '需要额外权限'),
    };
  }

  if (item.type === 'cli-verify') {
    return {
      id: item.id,
      status: item.status,
      text: statusVerb(item.status, '正在校验结果', '已校验结果', '结果校验失败'),
      detail: truncateInline(item.cliData?.verificationSummary || item.content || ''),
    };
  }

  return null;
};

export function ProcessTimeline({ items, isStreaming, variant = 'default', failureTone = 'danger' }: ProcessTimelineProps) {
  if (!items || items.length === 0) return null;

  const isCompact = variant === 'compact';
  const failedTextClass = failureTone === 'neutral' ? 'text-text-tertiary/70' : 'text-red-500/80';
  const statusLines = useMemo(
    () => items.map(buildStatusLine).filter((item): item is StatusLine => Boolean(item)),
    [items],
  );
  const runningLines = statusLines.filter((item) => item.status === 'running');
  const failedCount = statusLines.filter((item) => item.status === 'failed').length;
  const hasCriticalFailure = statusLines.some((item) => item.status === 'failed' && item.forceDanger);
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, statusLines.length - COLLAPSED_STATUS_LINE_COUNT);
  const visibleStatusLines = expanded || hiddenCount === 0
    ? statusLines
    : statusLines.slice(-COLLAPSED_STATUS_LINE_COUNT);
  const activeText = runningLines.length === 1
    ? runningLines[0].text
    : runningLines.length > 1
      ? `正在处理 ${runningLines.length} 个任务`
      : '';

  useEffect(() => {
    if (hiddenCount === 0 && expanded) {
      setExpanded(false);
    }
  }, [expanded, hiddenCount]);

  if (statusLines.length === 0) return null;

  return (
    <div
      className={clsx(
        'w-full max-w-[780px] space-y-1 text-[12px] leading-5 text-text-tertiary/80',
        isCompact ? 'mt-1.5' : 'mt-2',
      )}
      aria-live={runningLines.length > 0 || isStreaming ? 'polite' : 'off'}
    >
      {activeText ? (
        <div className="font-medium text-text-tertiary/85">
          {activeText}
        </div>
      ) : failedCount > 0 ? (
        <div className={clsx('font-medium', hasCriticalFailure ? 'text-red-500/80' : failedTextClass)}>
          有 {failedCount} 个步骤失败
        </div>
      ) : null}

      <div className="space-y-0.5">
        {visibleStatusLines.map((item) => (
          <div
            key={item.id}
            className={clsx(
              'min-w-0',
              item.preserveDetail ? 'whitespace-normal break-words' : 'truncate',
              item.status === 'running' && 'text-text-tertiary/85',
              item.status === 'done' && 'text-text-tertiary/70',
              item.status === 'failed' && (item.forceDanger ? 'text-red-500/80' : failedTextClass),
            )}
            title={[item.text, item.detail].filter(Boolean).join(' · ')}
          >
            <span>{item.text}</span>
            {item.detail ? <span className="ml-1">{item.detail}</span> : null}
          </div>
        ))}
      </div>

      {hiddenCount > 0 ? (
        <button
          type="button"
          className="text-[12px] leading-5 text-text-tertiary/70 underline-offset-2 hover:text-text-secondary hover:underline"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? '收起' : `展开 ${hiddenCount} 条更早状态`}
        </button>
      ) : null}
    </div>
  );
}
