import type {
  CollabMailboxMessageRecord,
  CollabMemberRecord,
  CollabProgressReportRecord,
  CollabSessionRecord,
  CollabSessionSnapshot,
  CollabTaskRecord,
} from '../../types';

export type TeamWorkbenchSnapshot = CollabSessionSnapshot;
export type TeamWorkbenchSession = CollabSessionRecord;
export type TeamWorkbenchMember = CollabMemberRecord;
export type TeamWorkbenchTask = CollabTaskRecord;
export type TeamWorkbenchMessage = CollabMailboxMessageRecord;
export type TeamWorkbenchReport = CollabProgressReportRecord;

export type TeamMemberStatus = 'active' | 'idle' | 'failed' | 'completed' | 'pending' | 'blocked';

export interface TeamRuntimeProviderValue {
  sessionId: string;
  snapshot: TeamWorkbenchSnapshot | null;
  members: TeamWorkbenchMember[];
  tasks: TeamWorkbenchTask[];
  mailbox: TeamWorkbenchMessage[];
  reports: TeamWorkbenchReport[];
  isRefreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  sendMessage: (payload: {
    toMemberId: string;
    body: string;
    subject?: string;
    attachmentRefs?: string[];
    payload?: Record<string, unknown>;
  }) => Promise<TeamWorkbenchMessage>;
  renameMember: (memberId: string, displayName: string) => Promise<TeamWorkbenchMember>;
  shutdownMember: (memberId: string) => Promise<TeamWorkbenchMember>;
}
