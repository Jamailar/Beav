import type { Message } from '../../components/MessageItem';
import type {
  TeamWorkbenchMember,
  TeamWorkbenchMessage,
  TeamWorkbenchReport,
  TeamWorkbenchTask,
} from './teamWorkbenchTypes';

export function isLeaderMember(member: TeamWorkbenchMember): boolean {
  const role = String(member.roleId || '').trim().toLowerCase();
  return role === 'leader' || role === 'coordinator' || role === 'director';
}

export function sortWorkbenchMembers(
  members: TeamWorkbenchMember[],
  storedOrder: string[] = [],
  coordinatorMemberId?: string | null,
): TeamWorkbenchMember[] {
  const coordinatorId = String(coordinatorMemberId || '').trim();
  const leader = (coordinatorId ? members.find((member) => member.id === coordinatorId) : null)
    || members.find(isLeaderMember)
    || members[0];
  const rest = members.filter((member) => member.id !== leader?.id);
  const orderRank = new Map(storedOrder.map((id, index) => [id, index]));
  rest.sort((left, right) => {
    const leftRank = orderRank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = orderRank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return String(left.displayName || '').localeCompare(String(right.displayName || ''));
  });
  return leader ? [leader, ...rest] : rest;
}

export function memberStatusLabel(status: string): string {
  switch (String(status || '').toLowerCase()) {
    case 'active':
    case 'running':
    case 'working':
    case 'in_progress':
      return '运行中';
    case 'failed':
    case 'error':
      return '失败';
    case 'completed':
    case 'done':
      return '完成';
    case 'blocked':
      return '阻塞';
    case 'pending':
    case 'queued':
      return '等待';
    default:
      return '空闲';
  }
}

export function memberStatusClassName(status: string): string {
  switch (String(status || '').toLowerCase()) {
    case 'active':
    case 'running':
    case 'working':
    case 'in_progress':
      return 'bg-emerald-500';
    case 'failed':
    case 'error':
      return 'bg-red-500';
    case 'completed':
    case 'done':
      return 'bg-blue-500';
    case 'blocked':
      return 'bg-amber-500';
    case 'pending':
    case 'queued':
      return 'bg-slate-400';
    default:
      return 'bg-zinc-400';
  }
}

export function getMemberInitials(member: TeamWorkbenchMember): string {
  const name = String(member.displayName || member.roleId || '?').trim();
  return name.slice(0, 2).toUpperCase();
}

export function messagesForMember(
  memberId: string,
  mailbox: TeamWorkbenchMessage[],
  reports: TeamWorkbenchReport[],
): Message[] {
  const messages = mailbox
    .filter((message) => (
      message.toMemberId === memberId
      || message.fromMemberId === memberId
      || (!message.toMemberId && !message.fromMemberId)
    ))
    .map((message): Message => {
      const fromCurrentMember = message.fromMemberId === memberId;
      const fromUser = String(message.fromKind || '').toLowerCase() === 'user';
      return {
        id: message.id,
        role: fromCurrentMember ? 'ai' : 'user',
        messageType: 'reply',
        content: message.body || '',
        displayContent: message.body || '',
        tools: [],
        timeline: [],
        memberActor: fromCurrentMember ? {
          type: 'member',
          memberId,
          displayName: '成员',
        } : undefined,
        suppressPendingIndicator: true,
        processingStartedAt: message.createdAt,
        processingFinishedAt: message.createdAt,
        knowledgeReferences: [],
        memberMention: fromUser ? undefined : undefined,
      };
    });

  const reportMessages = reports
    .filter((report) => report.memberId === memberId)
    .map((report): Message => ({
      id: report.id,
      role: 'ai',
      messageType: 'reply',
      content: report.summary || '',
      displayContent: report.summary || '',
      tools: [],
      timeline: [],
      suppressPendingIndicator: true,
      processingStartedAt: report.createdAt,
      processingFinishedAt: report.createdAt,
    }));

  return [...messages, ...reportMessages].sort((left, right) => (
    Number(left.processingStartedAt || 0) - Number(right.processingStartedAt || 0)
  ));
}

export function taskCountForMember(memberId: string, tasks: TeamWorkbenchTask[]): number {
  return tasks.filter((task) => task.memberId === memberId && !['completed', 'done', 'cancelled'].includes(task.status)).length;
}

export function taskStatusTone(status: string): string {
  switch (String(status || '').toLowerCase()) {
    case 'running':
    case 'in_progress':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700';
    case 'blocked':
    case 'waiting_for_review':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700';
    case 'failed':
    case 'cancelled':
      return 'border-red-500/30 bg-red-500/10 text-red-700';
    case 'completed':
    case 'done':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-700';
    default:
      return 'border-border bg-surface-secondary text-text-secondary';
  }
}
