import type { BridgeCore, Listener } from '../types';

export function createKnowledgeBridge(core: BridgeCore) {
  return {
    knowledge: {
      listNotes: <T = Record<string, unknown>>() => core.invokeCommandGuarded<Array<T>>(
        'knowledge_list',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:list',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      listYoutube: <T = Record<string, unknown>>() => core.invokeCommandGuarded<Array<T>>(
        'knowledge_list_youtube',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:list-youtube',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      listDocs: <T = Record<string, unknown>>() => core.invokeCommandGuarded<Array<T>>(
        'knowledge_docs_list',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:docs:list',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      listPage: <T = Record<string, unknown>>(payload?: Record<string, unknown>) => core.invokeCommandGuarded<T>(
        'knowledge_list_page',
        { payload: payload || {} },
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:list-page',
          normalize: (value) => {
            const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
            return {
              items: Array.isArray(raw.items) ? raw.items : [],
              nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
              total: typeof raw.total === 'number' ? raw.total : 0,
              kindCounts: (raw.kindCounts && typeof raw.kindCounts === 'object') ? raw.kindCounts : {},
            } as T;
          },
        },
      ),
      getItemDetail: <T = Record<string, unknown>>(payload: Record<string, unknown>) => core.invokeCommandGuarded<T | null>(
        'knowledge_get_item_detail',
        { payload },
        {
          timeoutMs: 3200,
          fallbackChannel: 'knowledge:get-item-detail',
          normalize: (value) => (value && typeof value === 'object') ? value as T : null,
        },
      ),
      getIndexStatus: <T = Record<string, unknown>>() => core.invokeCommandGuarded<T>(
        'knowledge_get_index_status',
        undefined,
        {
          timeoutMs: 1800,
          fallbackChannel: 'knowledge:get-index-status',
          normalize: (value) => {
            const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
            const visualRaw = (raw.visualIndex && typeof raw.visualIndex === 'object')
              ? raw.visualIndex as Record<string, unknown>
              : {};
            return {
              indexedCount: typeof raw.indexedCount === 'number' ? raw.indexedCount : 0,
              visualIndex: {
                totalUnits: typeof visualRaw.totalUnits === 'number' ? visualRaw.totalUnits : 0,
                indexedUnits: typeof visualRaw.indexedUnits === 'number' ? visualRaw.indexedUnits : 0,
                metadataOnlyUnits: typeof visualRaw.metadataOnlyUnits === 'number' ? visualRaw.metadataOnlyUnits : 0,
                failedUnits: typeof visualRaw.failedUnits === 'number' ? visualRaw.failedUnits : 0,
                retryDeferredUnits: typeof visualRaw.retryDeferredUnits === 'number' ? visualRaw.retryDeferredUnits : 0,
                retryReadyUnits: typeof visualRaw.retryReadyUnits === 'number' ? visualRaw.retryReadyUnits : 0,
                lastAttemptedAt: typeof visualRaw.lastAttemptedAt === 'string' ? visualRaw.lastAttemptedAt : null,
              },
              pendingCount: typeof raw.pendingCount === 'number' ? raw.pendingCount : 0,
              failedCount: typeof raw.failedCount === 'number' ? raw.failedCount : 0,
              rebuildProgress: typeof raw.rebuildProgress === 'number' ? raw.rebuildProgress : null,
              lastIndexedAt: typeof raw.lastIndexedAt === 'string' ? raw.lastIndexedAt : null,
              isBuilding: raw.isBuilding === true,
              lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
              migrationStatus: typeof raw.migrationStatus === 'string' ? raw.migrationStatus : null,
              pendingRebuildReason: typeof raw.pendingRebuildReason === 'string' ? raw.pendingRebuildReason : null,
            } as T;
          },
        },
      ),
      getFileIndexDashboard: async <T = Record<string, unknown>>() => {
        const value = await core.invokeCommand('knowledge_get_file_index_dashboard');
        return (value && typeof value === 'object') ? value as T : null as T;
      },
      rebuildCatalog: (payload?: { mode?: 'full' | 'fts' | 'canonicalBlocks' | 'canonicalReparse'; sourceId?: string; includeVisualIndex?: boolean }) => core.invokeCommandGuarded(
        'knowledge_rebuild_catalog',
        payload ? { payload } : undefined,
        {
        timeoutMs: 1800,
        fallbackChannel: 'knowledge:rebuild-catalog',
        },
      ),
      openIndexRoot: () => core.invokeCommandGuarded('knowledge_open_index_root', undefined, {
        timeoutMs: 1800,
        fallbackChannel: 'knowledge:open-index-root',
      }),
      deleteNote: (noteId: string) => core.invokeChannel('knowledge:delete', noteId),
      deleteBatch: (payload: { items: Array<{ id: string; kind: 'redbook-note' | 'link-article' | 'wechat-article' | 'zhihu-answer' | 'zhihu-article' | 'youtube-video' | 'document-source' }> }) => core.invokeChannel('knowledge:delete-batch', payload),
      batchIngest: (payload: { entries?: unknown[]; documentSources?: unknown[]; mediaAssets?: unknown[] }) => core.invokeChannel('knowledge:batch-ingest', payload),
      createFromChat: (payload: { title?: string; content: string; summary?: string; tags?: string[]; source?: Record<string, unknown>; metadata?: Record<string, unknown>; allowUpdate?: boolean }) => core.invokeChannel('knowledge:create-from-chat', payload),
      transcribe: (noteId: string) => core.invokeChannel('knowledge:transcribe', noteId),
      deleteYoutube: (videoId: string) => core.invokeChannel('knowledge:delete-youtube', videoId),
      retryYoutubeSubtitle: (videoId: string) => core.invokeChannel('knowledge:retry-youtube-subtitle', videoId),
      regenerateYoutubeSummaries: () => core.invokeChannel('knowledge:youtube-regenerate-summaries'),
      addDocFiles: () => core.invokeChannel('knowledge:docs:add-files'),
      addDocFolder: () => core.invokeChannel('knowledge:docs:add-folder'),
      addObsidianVault: () => core.invokeChannel('knowledge:docs:add-obsidian-vault'),
      deleteDocSource: (sourceId: string) => core.invokeChannel('knowledge:docs:delete-source', sourceId),
      onChanged: (listener: Listener) => core.on('knowledge:changed', listener),
      offChanged: (listener: Listener) => core.off('knowledge:changed', listener),
      onCatalogUpdated: (listener: Listener) => core.on('knowledge:catalog-updated', listener),
      offCatalogUpdated: (listener: Listener) => core.off('knowledge:catalog-updated', listener),
      onYoutubeVideoUpdated: (listener: Listener) => core.on('knowledge:youtube-video-updated', listener),
      offYoutubeVideoUpdated: (listener: Listener) => core.off('knowledge:youtube-video-updated', listener),
      onNewYoutubeVideo: (listener: Listener) => core.on('knowledge:new-youtube-video', listener),
      offNewYoutubeVideo: (listener: Listener) => core.off('knowledge:new-youtube-video', listener),
      onDocsUpdated: (listener: Listener) => core.on('knowledge:docs-updated', listener),
      offDocsUpdated: (listener: Listener) => core.off('knowledge:docs-updated', listener),
      onNoteUpdated: (listener: Listener) => core.on('knowledge:note-updated', listener),
      offNoteUpdated: (listener: Listener) => core.off('knowledge:note-updated', listener),
      onFileIndexUpdated: (listener: Listener) => core.on('knowledge:file-index-updated', listener),
      offFileIndexUpdated: (listener: Listener) => core.off('knowledge:file-index-updated', listener),
    },

    embedding: {
      getManuscriptCache: (manuscriptId: string) => core.invokeChannel('embedding:get-manuscript-cache', manuscriptId),
      compute: (content: string) => core.invokeChannel('embedding:compute', content),
      saveManuscriptCache: (payload: Record<string, unknown>) => core.invokeChannel('embedding:save-manuscript-cache', payload),
      getSortedSources: (embedding: unknown) => core.invokeChannel('embedding:get-sorted-sources', embedding),
    },

    similarity: {
      getCache: (manuscriptId: string) => core.invokeChannel('similarity:get-cache', manuscriptId),
      getKnowledgeVersion: () => core.invokeChannel('similarity:get-knowledge-version'),
      saveCache: (payload: Record<string, unknown>) => core.invokeChannel('similarity:save-cache', payload),
    },

    readYoutubeSubtitle: (videoId: string) => core.invokeChannel('knowledge:read-youtube-subtitle', videoId),
  };
}
