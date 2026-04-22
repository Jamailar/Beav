import {
  createChatSession,
  getChatSessionByContext,
  updateChatSessionMetadata,
} from '../db';

export type BackgroundSessionSpec = {
  contextId: string;
  contextType: string;
  title: string;
  contextContent?: string;
  runtimeMode?: string;
  metadata?: Record<string, unknown>;
};

export class BackgroundSessionStore {
  ensureSession(spec: BackgroundSessionSpec) {
    let session = getChatSessionByContext(spec.contextId, spec.contextType);
    const nextMetadata = {
      contextId: spec.contextId,
      contextType: spec.contextType,
      contextContent: spec.contextContent || '',
      runtimeMode: spec.runtimeMode || 'background-maintenance',
      isContextBound: true,
      isBackgroundSession: true,
      ...spec.metadata,
    };

    if (!session) {
      const safeContext = spec.contextId.replace(/[^a-zA-Z0-9_:-]/g, '_');
      session = createChatSession(
        `session_bg_${safeContext}_${Date.now()}`,
        spec.title,
        nextMetadata,
      );
      return session;
    }

    updateChatSessionMetadata(session.id, nextMetadata);
    return {
      ...session,
      metadata: JSON.stringify(nextMetadata),
    };
  }
}

let backgroundSessionStore: BackgroundSessionStore | null = null;

export function getBackgroundSessionStore(): BackgroundSessionStore {
  if (!backgroundSessionStore) {
    backgroundSessionStore = new BackgroundSessionStore();
  }
  return backgroundSessionStore;
}
