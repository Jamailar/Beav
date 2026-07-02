import type { RefObject } from 'react';
import { BookOpenText, Search } from 'lucide-react';
import { clsx } from 'clsx';
import type { GlobalKnowledgeSearchItem } from './useGlobalKnowledgeSearch';

interface AppGlobalSearchOverlayProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (query: string) => void;
  results: GlobalKnowledgeSearchItem[];
  isLoading: boolean;
  isClosing: boolean;
  closeSearch: () => void;
  submitSearch: () => void;
  navigateToSearch: (queryOverride?: string) => void;
}

export function AppGlobalSearchOverlay({
  inputRef,
  query,
  setQuery,
  results,
  isLoading,
  isClosing,
  closeSearch,
  submitSearch,
  navigateToSearch,
}: AppGlobalSearchOverlayProps) {
  const trimmedQuery = query.trim();

  return (
    <div
      className={clsx(
        'app-global-search-backdrop fixed inset-0 z-[125] flex items-center justify-center px-4',
        isClosing ? 'app-global-search-backdrop--closing' : 'app-global-search-backdrop--open'
      )}
      onMouseDown={closeSearch}
    >
      <div
        className={clsx(
          'app-global-search-panel w-full max-w-xl space-y-2',
          isClosing ? 'app-global-search-panel--closing' : 'app-global-search-panel--open'
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="app-global-search-box flex h-14 items-center gap-3 rounded-2xl bg-surface-primary px-4">
          <Search className="app-global-search-icon h-4 w-4 shrink-0" strokeWidth={1.8} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitSearch();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                closeSearch();
              }
            }}
            className="app-global-search-input h-full min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-tertiary"
            placeholder="搜索知识库"
          />
        </div>

        {trimmedQuery && (
          <div className="app-global-search-results overflow-hidden rounded-2xl border border-border/80 bg-surface-primary/92 shadow-[0_22px_70px_-34px_rgba(0,0,0,0.58)] backdrop-blur-md">
            {isLoading && results.length === 0 ? (
              <div className="h-12 px-4 text-[13px] text-text-tertiary flex items-center">搜索中...</div>
            ) : results.length === 0 ? (
              <div className="h-12 px-4 text-[13px] text-text-tertiary flex items-center">没有结果</div>
            ) : (
              <div className="max-h-[360px] overflow-y-auto py-1">
                {results.map((item, index) => {
                  const title = String(item.title || '').trim() || '未命名';
                  const preview = String(item.previewText || item.author || item.siteName || '').trim();
                  const kindLabel = item.kind === 'youtube-video'
                    ? '视频'
                    : item.kind === 'document-source' ? '文档' : '笔记';
                  return (
                    <button
                      key={`${item.kind || 'item'}-${item.itemId || index}`}
                      type="button"
                      onClick={() => navigateToSearch(query)}
                      className="app-global-search-result-item group flex w-full items-start gap-3 px-4 py-3 text-left"
                    >
                      <span className="app-global-search-result-icon mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-secondary">
                        <BookOpenText className="h-3.5 w-3.5" strokeWidth={1.8} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-text-primary">{title}</span>
                          <span className="shrink-0 rounded-md bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">
                            {kindLabel}
                          </span>
                        </span>
                        {preview && (
                          <span className="mt-1 block truncate text-[12px] text-text-tertiary">{preview}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
