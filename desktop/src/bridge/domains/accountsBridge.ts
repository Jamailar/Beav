import type { BridgeCore } from '../types';

export function createAccountsBridge(core: BridgeCore) {
  return {
    accounts: {
      list: <T = unknown>() => core.invokeChannel('accounts:list') as Promise<T>,
      get: <T = unknown>(payload: { accountId: string }) => core.invokeChannel('accounts:get', payload) as Promise<T>,
      createFromHomepage: <T = unknown>(payload: { homepageUrl: string; limit?: number }) => core.invokeChannel('accounts:create-from-homepage', payload) as Promise<T>,
      postsBatch: <T = unknown>(payload: { accountId: string; sessionId?: string; platform?: string; profile?: unknown; posts: unknown[] }) => core.invokeChannel('accounts:posts-batch', payload) as Promise<T>,
      commentsBatch: <T = unknown>(payload: { accountId: string; sessionId?: string; platform?: string; postId?: string; comments: unknown[] }) => core.invokeChannel('accounts:comments-batch', payload) as Promise<T>,
      mediaBatch: <T = unknown>(payload: { accountId: string; sessionId?: string; platform?: string; media: unknown[] }) => core.invokeChannel('accounts:media-batch', payload) as Promise<T>,
      completeImportSession: <T = unknown>(payload: { sessionId: string; status?: string; importedPostCount?: number; failedPostCount?: number; lastError?: string }) => core.invokeChannel('accounts:complete-import-session', payload) as Promise<T>,
      delete: <T = unknown>(payload: { accountId: string }) => core.invokeChannel('accounts:delete', payload) as Promise<T>,
    },
  };
}
