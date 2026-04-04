import React, { useEffect, useState } from 'react';
import { Database, Loader2, CheckCircle2, RefreshCw, HardDrive, X, List, PlayCircle, Clock } from 'lucide-react';
import { clsx } from 'clsx';

interface IndexingStatusData {
  isIndexing: boolean;
  totalQueueLength: number;
  activeItems: { id: string; title: string; startTime: number }[];
  queuedItems: { id: string; title: string }[];
  processedCount: number;
  totalStats: {
    vectors: number;
    documents: number;
  };
}

export function IndexingStatus() {
  const [status, setStatus] = useState<IndexingStatusData | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    // Initial fetch
    window.ipcRenderer.invoke('indexing:get-stats').then((data) => setStatus(data as IndexingStatusData));

    // Listen for updates
    const listener = (_: any, newStatus: IndexingStatusData) => {
      setStatus(newStatus);
    };

    window.ipcRenderer.on('indexing:status', listener);

    return () => {
      window.ipcRenderer.off('indexing:status', listener);
    };
  }, []);

  const handleRemoveItem = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.ipcRenderer.invoke('indexing:remove-item', id);
  };

  const handleClearQueue = async () => {
    if (confirm('确定要清空所有等待中的任务吗？')) {
      await window.ipcRenderer.invoke('indexing:clear-queue');
    }
  };

  if (!status) return null;

  return (
    <div className="relative">
      {/* Status Bar Item */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className={clsx(
          "flex items-center gap-2 px-3 py-2 text-xs rounded-lg transition-all w-full",
          status.isIndexing
            ? "bg-accent-primary/10 text-accent-primary"
            : "text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary"
        )}
      >
        {status.isIndexing ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Database className="w-3.5 h-3.5" />
        )}

        <span className="font-medium truncate flex-1 text-left">
          {status.isIndexing
            ? `处理中... (剩余 ${status.activeItems.length + status.totalQueueLength} 个)`
            : `已索引 ${status.totalStats.documents} 个文档`}
        </span>
      </button>

      {/* Details Popover */}
      {showDetails && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowDetails(false)}
          />
          <div className="absolute bottom-full left-0 mb-2 w-72 bg-surface-primary border border-border rounded-xl shadow-xl z-50 p-0 overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200 flex flex-col">

            {/* Header */}
            <div className="p-3 border-b border-border bg-surface-secondary/30 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
                <HardDrive className="w-3.5 h-3.5 text-accent-primary" />
                索引任务管理器
              </h3>
              {status.isIndexing ? (
                <span className="text-[10px] bg-accent-primary/10 text-accent-primary px-1.5 py-0.5 rounded-full font-medium animate-pulse">
                  运行中
                </span>
              ) : (
                <span className="text-[10px] bg-green-500/10 text-green-500 px-1.5 py-0.5 rounded-full font-medium">
                  完成
                </span>
              )}
            </div>

            {/* Content Scrollable Area */}
            <div className="max-h-80 overflow-y-auto p-3 space-y-4">

              {/* Active Tasks */}
              {status.activeItems.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
                    <PlayCircle className="w-3 h-3" />
                    进行中 ({status.activeItems.length})
                  </div>
                  <div className="space-y-1.5">
                    {status.activeItems.map(item => (
                      <div key={item.id} className="bg-accent-primary/5 border border-accent-primary/20 rounded-md p-2 relative overflow-hidden">
                        {/* Progress Bar Animation */}
                        <div className="absolute bottom-0 left-0 h-0.5 bg-accent-primary/30 w-full overflow-hidden">
                           <div className="h-full bg-accent-primary w-full animate-progress-indeterminate origin-left" />
                        </div>
                        <div className="text-xs font-medium text-text-primary truncate pr-2">
                          {item.title}
                        </div>
                        <div className="text-[10px] text-text-tertiary mt-0.5">
                          处理中...
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Queued Tasks */}
              {(status.queuedItems.length > 0 || status.totalQueueLength > 0) && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3 h-3" />
                      排队中 ({status.totalQueueLength})
                    </div>
                    {status.totalQueueLength > 0 && (
                      <button
                        onClick={handleClearQueue}
                        className="text-text-tertiary hover:text-red-500 transition-colors"
                        title="清空队列"
                      >
                        清空
                      </button>
                    )}
                  </div>

                  {status.queuedItems.length > 0 ? (
                    <div className="space-y-1">
                      {status.queuedItems.map(item => (
                        <div key={item.id} className="group flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-surface-secondary transition-colors text-xs">
                          <span className="truncate text-text-secondary flex-1 pr-2">
                            {item.title}
                          </span>
                          <button
                            onClick={(e) => handleRemoveItem(e, item.id)}
                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/10 hover:text-red-500 rounded transition-all"
                            title="取消任务"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                      {status.totalQueueLength > status.queuedItems.length && (
                        <div className="text-[10px] text-text-tertiary text-center py-1">
                          还有 {status.totalQueueLength - status.queuedItems.length} 个任务...
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[10px] text-text-tertiary px-2">
                      队列空
                    </div>
                  )}
                </div>
              )}

              {/* Empty State */}
              {!status.isIndexing && status.totalQueueLength === 0 && (
                <div className="flex flex-col items-center justify-center py-4 text-center">
                  <div className="w-8 h-8 bg-green-500/10 rounded-full flex items-center justify-center mb-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  </div>
                  <span className="text-xs text-text-secondary font-medium">所有索引已完成</span>
                  <span className="text-[10px] text-text-tertiary mt-0.5">知识库内容已最新</span>
                </div>
              )}
            </div>

            {/* Footer Stats */}
            <div className="bg-surface-secondary/50 p-3 border-t border-border grid grid-cols-2 gap-px text-center">
              <div>
                <div className="text-[10px] text-text-tertiary mb-0.5">已索引文档</div>
                <div className="text-sm font-bold text-text-primary">
                  {status.totalStats.documents}
                </div>
              </div>
              <div className="border-l border-border">
                <div className="text-[10px] text-text-tertiary mb-0.5">向量切片</div>
                <div className="text-sm font-bold text-text-primary">
                  {status.totalStats.vectors}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
