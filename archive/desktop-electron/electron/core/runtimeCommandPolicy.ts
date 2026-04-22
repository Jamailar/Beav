export type CommandPermissionClass =
  | 'read-only'
  | 'trusted-write'
  | 'confirm'
  | 'deny';

export interface CommandPermissionAnalysis {
  className: CommandPermissionClass;
  summary: string;
  reason: string;
}

const READ_ONLY_APP_ACTIONS = new Set([
  'list',
  'get',
  'read',
  'search',
  'show',
  'status',
  'profiles',
  'samples',
  'oauth-status',
  'tools',
  'test',
  'random',
  'ready',
]);

const TRUSTED_INTERACTIVE_APP_ACTIONS = new Map<string, Set<string>>([
  ['work', new Set(['create', 'update', 'link', 'dep-add', 'dep-remove', 'promote-redclaw', 'schedule-add', 'schedule-update', 'cycle-add', 'cycle-update', 'run-now'])],
  ['manuscripts', new Set(['write', 'create', 'rename', 'move'])],
  ['memory', new Set(['add', 'update', 'delete'])],
  ['redclaw', new Set([
    'create',
    'save-copy',
    'save-image',
    'save-retrospective',
    'runner-start',
    'runner-stop',
    'runner-status',
    'runner-update',
    'runner-enable-project',
    'runner-disable-project',
    'heartbeat-set',
    'schedule-add',
    'schedule-update',
    'schedule-remove',
    'schedule-run',
    'long-add',
    'long-update',
    'long-remove',
    'long-run',
  ])],
  ['media', new Set(['bind', 'update'])],
  ['subjects', new Set(['create', 'update', 'delete'])],
  ['image', new Set(['generate'])],
  ['archives', new Set(['create-profile', 'update-profile', 'delete-profile', 'create-sample', 'update-sample', 'delete-sample'])],
  ['wander', new Set(['save', 'delete', 'run', 'brainstorm'])],
]);

const TRUSTED_BACKGROUND_APP_ACTIONS = new Map<string, Set<string>>([
  ['work', new Set(['update', 'link', 'run-now'])],
  ['manuscripts', new Set(['write', 'create', 'rename', 'move'])],
  ['memory', new Set(['add', 'update'])],
  ['redclaw', new Set([
    'save-copy',
    'save-image',
    'save-retrospective',
    'runner-start',
    'runner-stop',
    'runner-status',
    'runner-update',
    'runner-enable-project',
    'runner-disable-project',
    'heartbeat-set',
    'schedule-add',
    'schedule-update',
    'schedule-remove',
    'schedule-run',
    'long-add',
    'long-update',
    'long-remove',
    'long-run',
  ])],
  ['media', new Set(['bind', 'update'])],
  ['image', new Set(['generate'])],
  ['wander', new Set(['save', 'run', 'brainstorm'])],
]);

const tokenize = (input: string): string[] => {
  const tokens: string[] = [];
  const regex = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(String(input || '').trim())) !== null) {
    const quotedDouble = match[1];
    const quotedSingle = match[2];
    const plain = match[3];
    tokens.push(
      quotedDouble !== undefined
        ? quotedDouble.replace(/\\"/g, '"')
        : quotedSingle !== undefined
          ? quotedSingle.replace(/\\'/g, '\'')
          : plain,
    );
  }
  return tokens;
};

const normalizeAction = (value: string): string => value.trim().toLowerCase();

const mapHasAction = (map: Map<string, Set<string>>, namespace: string, action: string): boolean => {
  return map.get(namespace)?.has(action) === true;
};

export function analyzeAppCliCommand(command: string, options?: {
  interactive?: boolean;
  runtimeMode?: string;
}): CommandPermissionAnalysis {
  const tokens = tokenize(command);
  while (tokens.length > 0 && ['app-cli', 'app_cli', 'redconvert', 'redconvert-cli'].includes(normalizeAction(tokens[0]))) {
    tokens.shift();
  }
  const namespace = normalizeAction(tokens[0] || 'help');
  const action = normalizeAction(tokens[1] && !tokens[1].startsWith('--') ? tokens[1] : 'list');
  const summary = `app_cli ${namespace} ${action}`.trim();

  if (!namespace || namespace === 'help') {
    return {
      className: 'read-only',
      summary: 'app_cli help',
      reason: '帮助命令为只读。',
    };
  }

  if (READ_ONLY_APP_ACTIONS.has(action)) {
    return {
      className: 'read-only',
      summary,
      reason: `${summary} 为只读命令。`,
    };
  }

  if (namespace === 'mcp' && action === 'call') {
    return {
      className: options?.interactive === false ? 'deny' : 'confirm',
      summary,
      reason: 'MCP 调用能力边界过大，后台默认禁止，前台需人工确认。',
    };
  }

  if (namespace === 'settings' || namespace === 'skills' || namespace === 'spaces') {
    return {
      className: options?.interactive === false ? 'deny' : 'confirm',
      summary,
      reason: `${namespace} 会改动全局工作区状态，后台默认禁止，前台需人工确认。`,
    };
  }

  if (options?.runtimeMode === 'background-maintenance') {
    if (mapHasAction(TRUSTED_BACKGROUND_APP_ACTIONS, namespace, action)) {
      return {
        className: 'trusted-write',
        summary,
        reason: `${summary} 属于后台允许的业务写入命令。`,
      };
    }
    return {
      className: 'deny',
      summary,
      reason: `${summary} 不在后台维护模式允许的 app_cli 命令范围内。`,
    };
  }

  if (mapHasAction(TRUSTED_INTERACTIVE_APP_ACTIONS, namespace, action)) {
    return {
      className: 'trusted-write',
      summary,
      reason: `${summary} 属于受信任的业务写入命令。`,
    };
  }

  return {
    className: options?.interactive === false ? 'deny' : 'confirm',
    summary,
    reason: `${summary} 未命中受信任命令清单。`,
  };
}

const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /:\(\)\s*\{/,
];

const READ_ONLY_BASH_PATTERNS = [
  /^\s*pwd(?:\s|$)/i,
  /^\s*ls(?:\s|$)/i,
  /^\s*find(?:\s|$)/i,
  /^\s*rg(?:\s|$)/i,
  /^\s*grep(?:\s|$)/i,
  /^\s*cat(?:\s|$)/i,
  /^\s*sed(?:\s|$)/i,
  /^\s*head(?:\s|$)/i,
  /^\s*tail(?:\s|$)/i,
  /^\s*wc(?:\s|$)/i,
  /^\s*stat(?:\s|$)/i,
  /^\s*which(?:\s|$)/i,
  /^\s*type(?:\s|$)/i,
  /^\s*echo(?:\s|$)/i,
  /^\s*git\s+(status|diff|log|show|branch|rev-parse|ls-files)\b/i,
];

const CONFIRM_BASH_PATTERNS = [
  /\b(node|python|ruby|perl|sh|bash|zsh)\b/i,
  /\b(npm|pnpm|yarn)\s+(test|build|install|add|remove|run)\b/i,
  /\bmake\b/i,
  /\bcp\b/i,
  /\bmv\b/i,
  /\btouch\b/i,
  /\bmkdir\b/i,
];

export function analyzeBashCommand(command: string, options?: {
  interactive?: boolean;
  runtimeMode?: string;
}): CommandPermissionAnalysis {
  const normalized = String(command || '').trim();
  const summary = normalized.length > 80 ? `${normalized.slice(0, 80)}...` : (normalized || 'bash command');

  if (!normalized) {
    return {
      className: 'deny',
      summary,
      reason: '空命令不允许执行。',
    };
  }

  if (DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      className: 'deny',
      summary,
      reason: '命中高危 shell 命令模式，直接拒绝。',
    };
  }

  if (READ_ONLY_BASH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      className: 'read-only',
      summary,
      reason: '命中只读 shell 命令模式。',
    };
  }

  if (options?.runtimeMode === 'background-maintenance') {
    return {
      className: 'deny',
      summary,
      reason: '后台维护模式仅允许只读 shell 命令。',
    };
  }

  if (CONFIRM_BASH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      className: options?.interactive === false ? 'deny' : 'confirm',
      summary,
      reason: '该 shell 命令可能改动文件或执行程序，需明确确认。',
    };
  }

  return {
    className: options?.interactive === false ? 'deny' : 'confirm',
    summary,
    reason: '未识别的 shell 命令默认按高风险执行处理。',
  };
}
