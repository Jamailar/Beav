export function buildFallbackResponse(channel: string, error: unknown): any {
  const message = error instanceof Error ? error.message : String(error);

  if (channel === 'spaces:list') {
    return {
      activeSpaceId: 'default',
      spaces: [{ id: 'default', name: '默认空间' }],
    };
  }

  if (channel === 'auth:get-state') {
    return {
      status: 'anonymous',
      loggedIn: false,
      session: null,
      user: null,
      points: null,
      models: [],
      callRecords: [],
      degradedReason: 'electron-archive-official-auth-unavailable',
      lastError: null,
      lastErrorKind: null,
      lastRefreshAt: null,
      nextRefreshAtMs: null,
    };
  }

  if (channel === 'llm-readiness:get-state') {
    return {
      ready: false,
      mode: 'custom',
      reason: 'electron-archive-official-auth-unavailable',
      officialLoggedIn: false,
      canUseOfficial: false,
      canUseCustom: true,
      updatedAt: new Date().toISOString(),
    };
  }

  if (
    channel === 'redbox-auth:bootstrap'
    || channel === 'redbox-auth:refresh'
    || channel === 'redbox-auth:me'
    || channel === 'redbox-auth:points'
    || channel === 'redbox-auth:call-records'
    || channel === 'auth:refresh-now'
  ) {
    return {
      success: false,
      loggedIn: false,
      session: null,
      data: null,
      error: '官方账号未登录',
      reason: 'electron-archive-official-auth-unavailable',
    };
  }

  if (
    channel === 'notifications:sync-remote'
    || channel === 'notifications:list-remote'
    || channel === 'notifications:mark-remote-read'
    || channel === 'notifications:mark-all-remote-read'
  ) {
    return {
      success: true,
      notifications: [],
      unreadCount: 0,
      cursor: null,
      remoteUnavailable: true,
    };
  }

  if (
    channel.endsWith(':list')
    || channel.includes('list-sessions')
    || channel.includes('get-tool-results')
    || channel.includes('get-checkpoints')
    || channel.includes('history')
  ) {
    return [];
  }

  if (
    channel.includes(':get')
    || channel.includes(':status')
    || channel.includes(':oauth-status')
  ) {
    return null;
  }

  return {
    success: false,
    error: `RedBox host request failed for "${channel}": ${message}`,
  };
}
