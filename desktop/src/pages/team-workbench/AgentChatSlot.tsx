import React, { memo } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { clsx } from 'clsx';
import { AgentChatPanel } from './AgentChatPanel';
import type {
  TeamWorkbenchMember,
  TeamWorkbenchMessage,
  TeamWorkbenchReport,
  TeamWorkbenchTask,
} from './teamWorkbenchTypes';
import {
  getMemberInitials,
  isLeaderMember,
  memberStatusClassName,
  memberStatusLabel,
  taskCountForMember,
} from './teamWorkbenchUtils';

interface AgentChatSlotProps {
  member: TeamWorkbenchMember;
  tasks: TeamWorkbenchTask[];
  mailbox: TeamWorkbenchMessage[];
  reports: TeamWorkbenchReport[];
  isActive: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onSendMessage: (memberId: string, body: string) => Promise<void>;
}

export const AgentChatSlot = memo(({
  member,
  tasks,
  mailbox,
  reports,
  isActive,
  isFullscreen,
  onToggleFullscreen,
  onSendMessage,
}: AgentChatSlotProps) => {
  const leader = isLeaderMember(member);
  const activeTaskCount = taskCountForMember(member.id, tasks);
  const isMemberOffline = ['offline', 'archived', 'disabled', 'shutdown'].includes(String(member.status || '').toLowerCase());

  return (
    <div
      className={clsx(
        'flex h-full min-h-0 flex-col bg-surface-primary',
        leader && 'border-l-[3px] border-l-accent-primary bg-accent-primary/[0.025]',
      )}
    >
      <div className={clsx(
        'flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3',
        leader ? 'bg-accent-primary/[0.06]' : 'bg-surface-secondary/35',
      )}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-primary text-[11px] font-semibold text-text-secondary">
            {getMemberInitials(member)}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-text-primary">{member.displayName}</span>
              {leader ? <span className="shrink-0 rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">总监</span> : null}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
              <span className={clsx('h-2 w-2 rounded-full', memberStatusClassName(member.status))} />
              <span>{memberStatusLabel(member.status)}</span>
              {member.backend ? <span>· {member.backend}</span> : null}
              {activeTaskCount > 0 ? <span>· {activeTaskCount} 项任务</span> : null}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleFullscreen}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
          aria-label={isFullscreen ? '退出全屏' : '聚焦成员'}
          title={isFullscreen ? '退出全屏' : '聚焦成员'}
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>

      <AgentChatPanel
        member={member}
        mailbox={mailbox}
        reports={reports}
        isActive={isActive}
        disabled={isMemberOffline}
        onSendMessage={(body) => onSendMessage(member.id, body)}
      />
    </div>
  );
});
