import { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
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
  return '任务';
}

function taskTitle(task: ClipboardCaptureTask) {
  return task.candidate.title || kindLabel(task.candidate.kind);
}

function isActiveStatus(status: string | undefined) {
  return status === 'queued' || status === 'running';
}

function taskDetail(task: ClipboardCaptureTask) {
  return task.progressMessage || task.logs?.[task.logs.length - 1]?.message || '';
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
    const timer = window.setInterval(() => void load(), open || snapshot.active || snapshot.queued.length > 0 ? 8000 : 30000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [open, snapshot.active, snapshot.queued.length]);

  const runningLocalTasks = useMemo(() => {
    const tasks = [
      ...(snapshot.active ? [snapshot.active] : []),
      ...snapshot.queued,
    ];
    const seen = new Set<string>();
    return tasks.filter((task) => {
      if (!isActiveStatus(task.status)) return false;
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    });
  }, [snapshot]);

  const remoteActive = serverJobs.filter((job) => isActiveStatus(job.status));
  const activeCount = runningLocalTasks.length + remoteActive.length;
  const waitingCount = snapshot.queued.length;
  const hasContent = activeCount > 0;

  if (!hasContent) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-accent-primary/20 bg-accent-primary/5 px-3 py-2 text-left text-[12px] text-text-primary transition-all hover:border-accent-primary/35 hover:bg-accent-primary/10"
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-primary" />
          <span className="truncate font-semibold">
            {waitingCount > 0 ? `采集队列 ${activeCount}` : '采集中'}
          </span>
          {snapshot.active?.progressMessage && (
            <span className="truncate text-text-tertiary">{snapshot.active.progressMessage}</span>
          )}
        </span>
        {waitingCount > 0 && <span className="shrink-0 text-[11px] text-text-tertiary">等待 {waitingCount}</span>}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4" onClick={() => setOpen(false)}>
          <div
            className="w-full max-w-md rounded-lg border border-border bg-surface-elevated p-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-text-primary">采集队列</div>
                <div className="mt-0.5 text-[11px] text-text-tertiary">
                  {waitingCount > 0 ? `${waitingCount} 个任务等待中` : '当前任务处理中'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary"
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[320px] overflow-y-auto">
              {runningLocalTasks.map((task) => (
                <div key={task.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-[12px] hover:bg-surface-secondary">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-text-primary">{taskTitle(task)}</div>
                    <div className="mt-0.5 truncate text-[11px] text-text-tertiary">
                      {statusLabel(task.status)}{taskDetail(task) ? ` · ${taskDetail(task)}` : ''}
                    </div>
                  </div>
                  {typeof task.pointsCost === 'number' && task.pointsCost > 0 && (
                    <div className="shrink-0 text-[11px] text-text-tertiary">{task.pointsCost} pts</div>
                  )}
                </div>
              ))}
              {remoteActive.map((job) => (
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
              {waitingCount === 0 && remoteActive.length === 0 && (
                <div className="rounded-md px-2 py-6 text-center text-[12px] text-text-tertiary">没有等待中的采集任务</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
