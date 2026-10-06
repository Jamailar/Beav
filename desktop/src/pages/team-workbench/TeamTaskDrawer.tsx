import React, { useMemo } from 'react';
import { FileVideo2, ListChecks } from 'lucide-react';
import type {
  TeamWorkbenchMember,
  TeamWorkbenchReport,
  TeamWorkbenchTask,
} from './teamWorkbenchTypes';
import { taskStatusTone } from './teamWorkbenchUtils';

interface TeamTaskDrawerProps {
  members: TeamWorkbenchMember[];
  tasks: TeamWorkbenchTask[];
  reports: TeamWorkbenchReport[];
}

function artifactTitle(artifact: unknown): string {
  if (!artifact || typeof artifact !== 'object') return '产物';
  const record = artifact as Record<string, unknown>;
  return String(record.title || record.name || record.path || record.url || record.id || '产物');
}

export function TeamTaskDrawer({ members, tasks, reports }: TeamTaskDrawerProps) {
  const memberNameById = useMemo(() => new Map(members.map((member) => [member.id, member.displayName])), [members]);
  const visibleTasks = tasks.slice().sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  const recentReports = reports.slice().sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0)).slice(0, 6);

  return (
    <aside className="hidden w-80 shrink-0 border-l border-border bg-surface-secondary/25 xl:flex xl:flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <ListChecks className="h-4 w-4 text-text-tertiary" />
        <div className="text-sm font-semibold text-text-primary">任务</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {visibleTasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-text-tertiary">
            暂无任务
          </div>
        ) : (
          <div className="space-y-2">
            {visibleTasks.map((task) => {
              const artifacts = [...(task.artifacts || []), ...(task.artifactIds || []).map((id) => ({ id }))];
              const isVideoTask = String(task.taskType || '').startsWith('video.');
              return (
                <div key={task.id} className="rounded-xl border border-border bg-surface-primary px-3 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-text-primary">{task.title}</div>
                      <div className="mt-1 text-xs text-text-tertiary">
                        {task.memberId ? memberNameById.get(task.memberId) || task.memberId : '未分配'}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${taskStatusTone(task.status)}`}>
                      {task.status || 'todo'}
                    </span>
                  </div>
                  {typeof task.progressPercent === 'number' ? (
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-secondary">
                      <div
                        className="h-full rounded-full bg-accent-primary"
                        style={{ width: `${Math.max(0, Math.min(100, task.progressPercent))}%` }}
                      />
                    </div>
                  ) : null}
                  {task.resultSummary ? (
                    <div className="mt-2 line-clamp-3 text-xs leading-5 text-text-secondary">{task.resultSummary}</div>
                  ) : null}
                  {artifacts.length > 0 ? (
                    <div className="mt-3 space-y-1.5">
                      {artifacts.slice(0, 3).map((artifact, index) => (
                        <div key={`${task.id}:artifact:${index}`} className="flex min-w-0 items-center gap-2 rounded-lg bg-surface-secondary/65 px-2 py-1.5 text-xs text-text-secondary">
                          {isVideoTask ? <FileVideo2 className="h-3.5 w-3.5 shrink-0 text-accent-primary" /> : <ListChecks className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />}
                          <span className="truncate">{artifactTitle(artifact)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {recentReports.length > 0 ? (
          <div className="mt-5">
            <div className="mb-2 px-1 text-xs font-medium text-text-tertiary">最近汇报</div>
            <div className="space-y-2">
              {recentReports.map((report) => (
                <div key={report.id} className="rounded-xl border border-border bg-surface-primary px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium text-text-secondary">{memberNameById.get(report.memberId) || report.memberId}</span>
                    <span className="shrink-0 text-text-tertiary">{report.status || report.reportType}</span>
                  </div>
                  <div className="mt-1 line-clamp-3 text-xs leading-5 text-text-tertiary">{report.summary}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
