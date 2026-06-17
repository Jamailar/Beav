import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeUnifiedEvent } from '../../types';
import type { TeamRuntimeProviderValue, TeamWorkbenchSnapshot } from './teamWorkbenchTypes';

const TeamRuntimeContext = createContext<TeamRuntimeProviderValue | null>(null);

const SNAPSHOT_STORAGE_PREFIX = 'redbox:team-workbench-snapshot:';

function readWarmSnapshot(sessionId: string): TeamWorkbenchSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${SNAPSHOT_STORAGE_PREFIX}${sessionId}`);
    return raw ? JSON.parse(raw) as TeamWorkbenchSnapshot : null;
  } catch {
    return null;
  }
}

function writeWarmSnapshot(sessionId: string, snapshot: TeamWorkbenchSnapshot): void {
  try {
    window.localStorage.setItem(`${SNAPSHOT_STORAGE_PREFIX}${sessionId}`, JSON.stringify(snapshot));
  } catch {
    // localStorage can fail in private modes; the live snapshot is still usable.
  }
}

function eventSessionId(event: RuntimeUnifiedEvent): string {
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {};
  return String(payload.collabSessionId || payload.sessionId || event.sessionId || '').trim();
}

export function TeamRuntimeProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: React.ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<TeamWorkbenchSnapshot | null>(() => readWarmSnapshot(sessionId));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const latestSessionIdRef = useRef(sessionId);
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    latestSessionIdRef.current = sessionId;
    setSnapshot(readWarmSnapshot(sessionId));
    setError(null);
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const requestSessionId = sessionId;
    const requestSeq = refreshSeqRef.current + 1;
    refreshSeqRef.current = requestSeq;
    setIsRefreshing(true);
    try {
      const next = await window.ipcRenderer.teamRuntime.getSession({
        sessionId: requestSessionId,
        mailboxLimit: 80,
        reportLimit: 80,
      });
      if (latestSessionIdRef.current !== requestSessionId || refreshSeqRef.current !== requestSeq) return;
      setSnapshot(next);
      writeWarmSnapshot(requestSessionId, next);
      setError(null);
    } catch (refreshError) {
      if (latestSessionIdRef.current !== requestSessionId || refreshSeqRef.current !== requestSeq) return;
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError || '刷新失败');
      setError(message);
    } finally {
      if (latestSessionIdRef.current === requestSessionId && refreshSeqRef.current === requestSeq) {
        setIsRefreshing(false);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleRuntimeEvent = (_event: unknown, envelope?: RuntimeUnifiedEvent) => {
      const event = envelope;
      if (!event || !event.eventType) return;
      if (!String(event.eventType).startsWith('runtime:collab-')) return;
      if (eventSessionId(event) !== sessionId) return;
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh();
      }, 120);
    };

    window.ipcRenderer.teamRuntime.onEvent(handleRuntimeEvent);
    return () => {
      window.ipcRenderer.teamRuntime.offEvent(handleRuntimeEvent);
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [refresh, sessionId]);

  const sendMessage: TeamRuntimeProviderValue['sendMessage'] = useCallback(async (payload) => {
    const message = await window.ipcRenderer.teamRuntime.sendMessage({
      sessionId,
      toMemberId: payload.toMemberId,
      fromKind: 'user',
      kind: 'message',
      messageType: 'message',
      subject: payload.subject,
      body: payload.body,
      attachmentRefs: payload.attachmentRefs,
      payload: payload.payload,
    });
    void window.ipcRenderer.teamRuntime.tickReports({ sessionId }).catch(() => {});
    void refresh();
    return message;
  }, [refresh, sessionId]);

  const renameMember: TeamRuntimeProviderValue['renameMember'] = useCallback(async (memberId, displayName) => {
    const member = await window.ipcRenderer.teamRuntime.renameMember({
      sessionId,
      memberId,
      displayName,
    });
    void refresh();
    return member;
  }, [refresh, sessionId]);

  const shutdownMember: TeamRuntimeProviderValue['shutdownMember'] = useCallback(async (memberId) => {
    const member = await window.ipcRenderer.teamRuntime.shutdownMember({
      sessionId,
      memberId,
      status: 'offline',
      reason: 'Stopped from team workbench',
    });
    void refresh();
    return member;
  }, [refresh, sessionId]);

  const value = useMemo<TeamRuntimeProviderValue>(() => ({
    sessionId,
    snapshot,
    members: snapshot?.members || [],
    tasks: snapshot?.tasks || [],
    mailbox: snapshot?.mailbox || [],
    reports: snapshot?.reports || [],
    isRefreshing,
    error,
    refresh,
    sendMessage,
    renameMember,
    shutdownMember,
  }), [error, isRefreshing, refresh, renameMember, sendMessage, sessionId, shutdownMember, snapshot]);

  return (
    <TeamRuntimeContext.Provider value={value}>
      {children}
    </TeamRuntimeContext.Provider>
  );
}

export function useTeamRuntime(): TeamRuntimeProviderValue {
  const value = useContext(TeamRuntimeContext);
  if (!value) {
    throw new Error('useTeamRuntime must be used within TeamRuntimeProvider');
  }
  return value;
}
