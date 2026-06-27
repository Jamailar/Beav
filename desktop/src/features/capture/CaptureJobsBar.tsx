import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, XCircle } from 'lucide-react';
import { clsx } from 'clsx';
import type { ClipboardCaptureKind, ClipboardCaptureTask, ServerCaptureJob } from './captureTypes';
import { clipboardCaptureQueue, type ClipboardCaptureQueueSnapshot } from './captureQueue';
import { listServerCaptureJobs } from './serverCaptureClient';

const EMPTY_SNAPSHOT: ClipboardCaptureQueueSnapshot = {
  active: null,
  queued: [],
  recent: [],
};

function kindLabel(kind: ClipboardCaptureKind | string | undefined) {
  if (kind === 'xhs-note') return '小红书笔记';
  if (kind === 'xhs-profile') return '小红书主页';
  if (kind === 'douyin-video') return '抖音视频';
  if (kind === 'youtube-video') return 'YouTube';
  return '采集任务';
}

function statusLabel(status: string | undefined) {
  if (status === 'queued') return '等待';
  if (status === 'running') return '处理中';
  if (status === 'completed' || status === 'success') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'skipped') return '跳过';
  return '任务';
}

function taskTitle(task: ClipboardCaptureTask) {
  return task.candidate.title || kindLabel(task.candidate.kind);
}

function isActiveStatus(status: string | undefined) {
  return status === 'queued' || status === 'running';
}

export function CaptureJobsBar() {
  const [snapshot, setSnapshot] = useState<ClipboardCaptureQueueSnapshot>(() => clipboardCaptureQueue.getSnapshot?.() || EMPTY_SNAPSHOT);
  const [serverJobs, setServerJobs] = useState<ServerCaptureJob[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => clipboardCaptureQueue.subscribe(setSnapshot), []);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const response = await listServerCaptureJobs(8).catch(() => null);
      if (!disposed && response?.success && Array.isArray(response.jobs)) {
        setServerJobs(response.jobs);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), open || snapshot.active ? 8000 : 30000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [open, snapshot.active]);

  const localTasks = useMemo(() => {
    const tasks = [
      ...(snapshot.active ? [snapshot.active] : []),
      ...snapshot.queued,
      ...snapshot.recent,
    ];
    const seen = new Set<string>();
    return tasks.filter((task) => {
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    });
  }, [snapshot]);

  const remoteActive = serverJobs.filter((job) => isActiveStatus(job.status));
  const remoteRecent = serverJobs.filter((job) => !isActiveStatus(job.status)).slice(0, 5);
  const activeCount = localTasks.filter((task) => isActiveStatus(task.status)).length + remoteActive.length;
  const failedCount = localTasks.filter((task) => task.status === 'failed').length + serverJobs.filter((job) => job.status === 'failed').length;
  const hasContent = localTasks.length > 0 || serverJobs.length > 0;

  if (!hasContent) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-[12px] transition-all',
          activeCount > 0
            ? 'border-accent-primary/20 bg-accent-primary/5 text-text-primary'
            : failedCount > 0
              ? 'border-red-100 bg-red-50 text-red-700'
              : 'border-border/70 bg-surface-secondary/45 text-text-secondary',
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          {activeCount > 0 ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-primary" />
          ) : failedCount > 0 ? (
            <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
          )}
          <span className="truncate font-semibold">
            {activeCount > 0 ? `采集中 ${activeCount}` : failedCount > 0 ? `采集失败 ${failedCount}` : '采集已完成'}
          </span>
          {snapshot.active?.progressMessage && (
            <span className="truncate text-text-tertiary">{snapshot.active.progressMessage}</span>
          )}
        </span>
        <ChevronDown className={clsx('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-2 rounded-lg border border-border bg-surface-elevated p-2 shadow-xl">
          <div className="max-h-[260px] overflow-y-auto">
            {localTasks.map((task) => (
              <div key={task.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-[12px] hover:bg-surface-secondary">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-text-primary">{taskTitle(task)}</div>
                  <div className="mt-0.5 truncate text-[11px] text-text-tertiary">
                    {statusLabel(task.status)}{task.progressMessage ? ` · ${task.progressMessage}` : ''}
                  </div>
                </div>
                {typeof task.pointsCost === 'number' && task.pointsCost > 0 && (
                  <div className="shrink-0 text-[11px] text-text-tertiary">{task.pointsCost} pts</div>
                )}
              </div>
            ))}
            {[...remoteActive, ...remoteRecent].map((job) => (
              <div key={`server-${job.id}`} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-[12px] hover:bg-surface-secondary">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-text-primary">{kindLabel(job.kind)}</div>
                  <div className="mt-0.5 truncate text-[11px] text-text-tertiary">
                    {statusLabel(job.status)}{job.progress?.message ? ` · ${job.progress.message}` : ''}
                  </div>
                </div>
                {typeof job.pointsCost === 'number' && job.pointsCost > 0 && (
                  <div className="shrink-0 text-[11px] text-text-tertiary">{job.pointsCost} pts</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
