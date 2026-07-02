import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Users } from 'lucide-react';
import { clsx } from 'clsx';
import type { TeamWorkbenchSession } from './teamWorkbenchTypes';
import { TeamRuntimeProvider, useTeamRuntime } from './TeamRuntimeProvider';
import { TeamAgentTabs } from './TeamAgentTabs';
import { AgentChatSlot } from './AgentChatSlot';
import { sortWorkbenchMembers } from './teamWorkbenchUtils';
import { appConfirm } from '../../utils/appDialogs';

interface TeamWorkbenchProps {
  session: TeamWorkbenchSession;
  isActive?: boolean;
}

const MEMBER_ORDER_PREFIX = 'redbox:team-member-order:';
const ACTIVE_MEMBER_PREFIX = 'redbox:team-active-member:';

function readStringArray(key: string): string[] {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) as string[] : [];
  } catch {
    return [];
  }
}

function TeamWorkbenchContent({ session, isActive = true }: TeamWorkbenchProps) {
  const {
    members,
    tasks,
    mailbox,
    reports,
    snapshot,
    isRefreshing,
    error,
    refresh,
    sendMessage,
    renameMember,
    shutdownMember,
  } = useTeamRuntime();
  const orderKey = `${MEMBER_ORDER_PREFIX}${session.id}`;
  const activeKey = `${ACTIVE_MEMBER_PREFIX}${session.id}`;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeMemberId, setActiveMemberId] = useState(() => window.localStorage.getItem(activeKey) || '');
  const [fullscreenMemberId, setFullscreenMemberId] = useState<string | null>(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);
  const [memberOrder, setMemberOrder] = useState<string[]>(() => readStringArray(orderKey));

  useEffect(() => {
    setMemberOrder(readStringArray(orderKey));
  }, [orderKey]);

  const coordinatorMemberId = snapshot?.session.coordinatorMemberId || session.coordinatorMemberId || null;
  const sortedMembers = useMemo(
    () => sortWorkbenchMembers(members, memberOrder, coordinatorMemberId),
    [coordinatorMemberId, memberOrder, members],
  );

  useEffect(() => {
    if (sortedMembers.length === 0) return;
    if (!activeMemberId || !sortedMembers.some((member) => member.id === activeMemberId)) {
      const nextId = sortedMembers[0].id;
      setActiveMemberId(nextId);
      window.localStorage.setItem(activeKey, nextId);
    }
  }, [activeKey, activeMemberId, sortedMembers]);

  const updateArrows = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const overflow = node.scrollWidth > node.clientWidth + 1;
    setShowLeftArrow(overflow && node.scrollLeft > 8);
    setShowRightArrow(overflow && node.scrollLeft + node.clientWidth < node.scrollWidth - 8);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.addEventListener('scroll', updateArrows, { passive: true });
    window.addEventListener('resize', updateArrows);
    const observer = new ResizeObserver(updateArrows);
    observer.observe(node);
    updateArrows();
    return () => {
      node.removeEventListener('scroll', updateArrows);
      window.removeEventListener('resize', updateArrows);
      observer.disconnect();
    };
  }, [updateArrows, sortedMembers.length]);

  const selectMember = useCallback((memberId: string) => {
    setActiveMemberId(memberId);
    window.localStorage.setItem(activeKey, memberId);
    if (fullscreenMemberId) {
      setFullscreenMemberId(memberId);
      return;
    }
    window.requestAnimationFrame(() => {
      slotRefs.current[memberId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    });
  }, [activeKey, fullscreenMemberId]);

  const scrollStep = useCallback((direction: -1 | 1) => {
    const currentIndex = sortedMembers.findIndex((member) => member.id === activeMemberId);
    const nextIndex = Math.max(0, Math.min(sortedMembers.length - 1, currentIndex + direction));
    const next = sortedMembers[nextIndex] || sortedMembers[0];
    if (next) selectMember(next.id);
  }, [activeMemberId, selectMember, sortedMembers]);

  const handleSendMessage = useCallback(async (memberId: string, body: string) => {
    await sendMessage({ toMemberId: memberId, body });
  }, [sendMessage]);

  const handleReorderMember = useCallback((fromMemberId: string, toMemberId: string) => {
    setMemberOrder((currentOrder) => {
      const currentIds = sortedMembers
        .filter((member) => member.id !== coordinatorMemberId && member.id !== sortedMembers[0]?.id)
        .map((member) => member.id);
      const orderedIds = currentOrder.length > 0
        ? currentOrder.filter((id) => currentIds.includes(id))
        : currentIds;
      for (const id of currentIds) {
        if (!orderedIds.includes(id)) orderedIds.push(id);
      }
      const fromIndex = orderedIds.indexOf(fromMemberId);
      const toIndex = orderedIds.indexOf(toMemberId);
      if (fromIndex === -1 || toIndex === -1) return currentOrder;
      const nextOrder = [...orderedIds];
      const [removed] = nextOrder.splice(fromIndex, 1);
      nextOrder.splice(toIndex, 0, removed);
      window.localStorage.setItem(orderKey, JSON.stringify(nextOrder));
      return nextOrder;
    });
  }, [coordinatorMemberId, orderKey, sortedMembers]);

  const handleRenameMember = useCallback((memberId: string, displayName: string) => {
    void renameMember(memberId, displayName);
  }, [renameMember]);

  const handleCloseMember = useCallback(async (memberId: string) => {
    const confirmed = await appConfirm('停用这个协作成员？', {
      title: '停用成员',
      confirmLabel: '停用',
      tone: 'danger',
    });
    if (!confirmed) return;
    await shutdownMember(memberId);
    if (fullscreenMemberId === memberId) setFullscreenMemberId(null);
  }, [fullscreenMemberId, shutdownMember]);

  const visibleMembers = fullscreenMemberId
    ? sortedMembers.filter((member) => member.id === fullscreenMemberId)
    : sortedMembers;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-primary px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Users className="h-4 w-4 shrink-0 text-text-tertiary" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text-primary">{snapshot?.session.title || session.title}</div>
            <div className="truncate text-xs text-text-tertiary">{snapshot?.session.objective || session.objective}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error ? <span className="hidden max-w-72 truncate text-xs text-red-600 md:block">{error}</span> : null}
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
            title="刷新"
            aria-label="刷新"
          >
            {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <TeamAgentTabs
        members={sortedMembers}
        tasks={tasks}
        activeMemberId={activeMemberId}
        onSelectMember={selectMember}
        onRenameMember={handleRenameMember}
        onCloseMember={handleCloseMember}
        onReorderMember={handleReorderMember}
      />

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {showLeftArrow && !fullscreenMemberId ? (
            <button
              type="button"
              onClick={() => scrollStep(-1)}
              className="absolute left-2 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white shadow-lg"
              aria-label="上一个成员"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          ) : null}

          {sortedMembers.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
              暂无成员
            </div>
          ) : (
            <div
              ref={scrollRef}
              className={clsx(
                'flex h-full w-full overflow-y-hidden [scrollbar-width:none]',
                fullscreenMemberId ? 'overflow-x-hidden' : 'overflow-x-auto',
              )}
              style={{ scrollSnapType: fullscreenMemberId ? undefined : 'x proximity' }}
            >
              {visibleMembers.map((member) => (
                <div
                  key={member.id}
                  ref={(node) => {
                    slotRefs.current[member.id] = node;
                  }}
                  className="relative h-full min-h-0 border-r border-border"
                  style={{
                    flex: fullscreenMemberId ? '1 1 100%' : '1 1 400px',
                    minWidth: fullscreenMemberId ? '100%' : sortedMembers.length <= 2 ? '240px' : '400px',
                    scrollSnapAlign: 'start',
                  }}
                >
                  <AgentChatSlot
                    member={member}
                    tasks={tasks}
                    mailbox={mailbox}
                    reports={reports}
                    isActive={isActive && member.id === activeMemberId}
                    isFullscreen={Boolean(fullscreenMemberId)}
                    onToggleFullscreen={() => setFullscreenMemberId((current) => current ? null : member.id)}
                    onSendMessage={handleSendMessage}
                  />
                </div>
              ))}
            </div>
          )}

          {showRightArrow && !fullscreenMemberId ? (
            <button
              type="button"
              onClick={() => scrollStep(1)}
              className="absolute right-2 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white shadow-lg"
              aria-label="下一个成员"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function TeamWorkbench(props: TeamWorkbenchProps) {
  return (
    <TeamRuntimeProvider sessionId={props.session.id}>
      <TeamWorkbenchContent {...props} />
    </TeamRuntimeProvider>
  );
}
