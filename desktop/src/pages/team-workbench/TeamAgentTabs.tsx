import React, { useEffect, useRef, useState } from 'react';
import { Check, Crown, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { TeamWorkbenchMember, TeamWorkbenchTask } from './teamWorkbenchTypes';
import {
  getMemberInitials,
  isLeaderMember,
  memberStatusClassName,
  memberStatusLabel,
  taskCountForMember,
} from './teamWorkbenchUtils';

interface TeamAgentTabsProps {
  members: TeamWorkbenchMember[];
  tasks: TeamWorkbenchTask[];
  activeMemberId: string;
  onSelectMember: (memberId: string) => void;
  onCloseMember?: (memberId: string) => void;
  onRenameMember?: (memberId: string, displayName: string) => void;
  onReorderMember?: (fromMemberId: string, toMemberId: string) => void;
}

export function TeamAgentTabs({
  members,
  tasks,
  activeMemberId,
  onSelectMember,
  onCloseMember,
  onRenameMember,
  onReorderMember,
}: TeamAgentTabsProps) {
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [dragOverMemberId, setDragOverMemberId] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingMemberId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingMemberId]);

  if (members.length === 0) return null;

  const startRename = (member: TeamWorkbenchMember) => {
    setEditingMemberId(member.id);
    setEditingName(member.displayName);
  };

  const commitRename = () => {
    if (!editingMemberId) return;
    const nextName = editingName.trim();
    const current = members.find((member) => member.id === editingMemberId);
    setEditingMemberId(null);
    if (nextName && current && nextName !== current.displayName) {
      onRenameMember?.(editingMemberId, nextName);
    }
  };

  return (
    <div className="h-11 shrink-0 overflow-hidden border-b border-border bg-surface-secondary/45">
      <div className="flex h-full min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
        {members.map((member) => {
          const active = member.id === activeMemberId;
          const leader = isLeaderMember(member);
          const taskCount = taskCountForMember(member.id, tasks);
          return (
            <button
              key={member.id}
              type="button"
              draggable={!leader}
              onClick={() => onSelectMember(member.id)}
              onDoubleClick={() => startRename(member)}
              onDragStart={(event) => {
                dragSourceRef.current = member.id;
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (leader) return;
                if (!dragSourceRef.current || dragSourceRef.current === member.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOverMemberId(member.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const source = dragSourceRef.current;
                dragSourceRef.current = null;
                setDragOverMemberId(null);
                if (source && source !== member.id && !leader) {
                  onReorderMember?.(source, member.id);
                }
              }}
              onDragEnd={() => {
                dragSourceRef.current = null;
                setDragOverMemberId(null);
              }}
              className={clsx(
                'group flex h-full max-w-[15rem] shrink-0 items-center gap-2 border-r border-border px-3 text-left transition-colors',
                active
                  ? 'border-t-2 border-t-accent-primary bg-surface-primary text-text-primary'
                  : 'text-text-tertiary hover:bg-surface-primary/60 hover:text-text-secondary',
                dragOverMemberId === member.id && 'border-l-2 border-l-accent-primary',
              )}
            >
              <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface-primary text-[10px] font-semibold">
                {leader ? <Crown className="h-3.5 w-3.5 text-amber-500" /> : getMemberInitials(member)}
                <span
                  className={clsx(
                    'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-surface-primary',
                    memberStatusClassName(member.status),
                  )}
                />
              </span>
              {editingMemberId === member.id ? (
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  <input
                    ref={inputRef}
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename();
                      if (event.key === 'Escape') setEditingMemberId(null);
                    }}
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium text-text-primary outline-none"
                  />
                  <Check className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                </span>
              ) : (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{member.displayName}</span>
                  <span className="block truncate text-[11px] text-text-tertiary">
                    {memberStatusLabel(member.status)}
                    {taskCount > 0 ? ` · ${taskCount} 项` : ''}
                  </span>
                </span>
              )}
              {!leader && onCloseMember ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseMember(member.id);
                  }}
                  className="hidden h-5 w-5 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-red-500 group-hover:flex"
                  aria-label="关闭成员"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
