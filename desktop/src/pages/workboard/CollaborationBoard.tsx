import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Clock3, MessageSquare, Plus, RefreshCw, Send, Users } from 'lucide-react';
import type {
  CollabMemberRecord,
  CollabProgressReportRecord,
  CollabSessionRecord,
  CollabSessionSnapshot,
  CollabTaskRecord,
} from '../../types';

type BoardStatus = 'todo' | 'ready' | 'running' | 'blocked' | 'review' | 'completed';

interface CollaborationBoardProps {
  isActive?: boolean;
  onSwitchRedclaw?: () => void;
}

const boardColumns: Array<{ key: BoardStatus; label: string }> = [
  { key: 'todo', label: 'Backlog' },
  { key: 'ready', label: 'Ready' },
  { key: 'running', label: 'In Progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'review', label: 'Review' },
  { key: 'completed', label: 'Done' },
];

function formatTs(value?: number | string | null): string {
  if (!value) return '-';
  const millis = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(millis)) return String(value);
  return new Date(millis).toLocaleString('zh-CN', { hour12: false });
}

function statusLabel(value?: string | null): string {
  switch (String(value || '').trim()) {
    case 'active':
    case 'running':
    case 'working':
      return '工作中';
    case 'blocked':
      return '阻塞';
    case 'review':
      return '评审';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'paused':
      return '暂停';
    case 'archived':
      return '归档';
    case 'idle':
      return '空闲';
    default:
      return value || '待处理';
  }
}

function taskColumn(status?: string | null): BoardStatus {
  const normalized = String(status || '').trim();
  if (normalized === 'in_progress' || normalized === 'active' || normalized === 'working') return 'running';
  if (normalized === 'done') return 'completed';
  if (normalized === 'reviewing') return 'review';
  if (boardColumns.some((column) => column.key === normalized)) return normalized as BoardStatus;
  return 'todo';
}

function latestReportForMember(reports: CollabProgressReportRecord[], memberId: string): CollabProgressReportRecord | null {
  return [...reports]
    .filter((report) => report.memberId === memberId)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null;
}

function latestReportForTask(reports: CollabProgressReportRecord[], taskId: string): CollabProgressReportRecord | null {
  return [...reports]
    .filter((report) => report.taskId === taskId)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null;
}

export function CollaborationBoard({ isActive = true, onSwitchRedclaw }: CollaborationBoardProps) {
  const [sessions, setSessions] = useState<CollabSessionRecord[]>([]);
  const [snapshot, setSnapshot] = useState<CollabSessionSnapshot | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [draftObjective, setDraftObjective] = useState('');
  const [draftMember, setDraftMember] = useState('');
  const [draftTask, setDraftTask] = useState('');
  const snapshotRef = useRef<CollabSessionSnapshot | null>(null);
  const sessionsRef = useRef<CollabSessionRecord[]>([]);
  const selectedSessionIdRef = useRef('');

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  const loadSessions = useCallback(async (preferredSessionId?: string) => {
    if (sessionsRef.current.length === 0) setLoading(true);
    setError('');
    try {
      const nextSessions = await window.ipcRenderer.teamRuntime.listSessions();
      setSessions(Array.isArray(nextSessions) ? nextSessions : []);
      const currentSelected = selectedSessionIdRef.current;
      const nextSelected = (
        preferredSessionId && nextSessions.some((session) => session.id === preferredSessionId)
          ? preferredSessionId
          : currentSelected && nextSessions.some((session) => session.id === currentSelected)
            ? currentSelected
            : nextSessions?.[0]?.id || ''
      );
      setSelectedSessionId(nextSelected);
      if (nextSelected) {
        const nextSnapshot = await window.ipcRenderer.teamRuntime.getSession({
          sessionId: nextSelected,
          mailboxLimit: 100,
          reportLimit: 120,
        });
        setSnapshot(nextSnapshot?.session ? nextSnapshot : null);
      } else {
        setSnapshot(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSnapshot = useCallback(async (sessionId = selectedSessionId) => {
    if (!sessionId) return;
    setError('');
    try {
      const nextSnapshot = await window.ipcRenderer.teamRuntime.getSession({
        sessionId,
        mailboxLimit: 100,
        reportLimit: 120,
      });
      setSnapshot(nextSnapshot?.session ? nextSnapshot : snapshotRef.current);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [selectedSessionId]);

  useEffect(() => {
    if (!isActive) return;
    void loadSessions();
  }, [isActive, loadSessions]);

  useEffect(() => {
    if (!isActive) return;
    const listener = (_event: unknown, envelope?: unknown) => {
      const eventRecord = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {};
      const eventType = String(eventRecord.eventType || '');
      const payload = eventRecord.payload && typeof eventRecord.payload === 'object' ? eventRecord.payload as Record<string, unknown> : {};
      const collabSessionId = String(payload.collabSessionId || payload.sessionId || '');
      if (!eventType.startsWith('runtime:collab-')) return;
      if (selectedSessionId && collabSessionId && collabSessionId !== selectedSessionId) return;
      void loadSnapshot(collabSessionId || selectedSessionId);
    };
    window.ipcRenderer.teamRuntime.onEvent(listener);
    return () => window.ipcRenderer.teamRuntime.offEvent(listener);
  }, [isActive, loadSnapshot, selectedSessionId]);

  const members = snapshot?.members || [];
  const tasks = snapshot?.tasks || [];
  const reports = snapshot?.reports || [];
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || tasks[0] || null,
    [selectedTaskId, tasks],
  );
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  useEffect(() => {
    if (!selectedTaskId || !tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(tasks[0]?.id || '');
    }
  }, [selectedTaskId, tasks]);

  const createSession = useCallback(async () => {
    const objective = draftObjective.trim();
    if (!objective) return;
    setBusy('create-session');
    try {
      const created = await window.ipcRenderer.teamRuntime.createSession({
        title: objective.slice(0, 48),
        objective,
        runtimeMode: 'default',
        source: 'workboard',
      });
      setDraftObjective('');
      setSelectedSessionId(created.id);
      await loadSessions(created.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy('');
    }
  }, [draftObjective, loadSessions]);

  const addMember = useCallback(async () => {
    if (!snapshot?.session?.id) return;
    const displayName = draftMember.trim();
    if (!displayName) return;
    setBusy('add-member');
    try {
      await window.ipcRenderer.teamRuntime.addMember({
        sessionId: snapshot.session.id,
        displayName,
        roleId: 'executor',
        sourceKind: 'internal_runtime',
        adapterKind: 'internal',
        capabilities: ['team_tools', 'runtime_tasks'],
      });
      setDraftMember('');
      await loadSnapshot(snapshot.session.id);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setBusy('');
    }
  }, [draftMember, loadSnapshot, snapshot?.session?.id]);

  const createTask = useCallback(async () => {
    if (!snapshot?.session?.id) return;
    const title = draftTask.trim();
    if (!title) return;
    setBusy('create-task');
    try {
      await window.ipcRenderer.teamRuntime.createTask({
        sessionId: snapshot.session.id,
        title,
        objective: title,
        memberId: members[0]?.id,
        status: 'todo',
        priority: 0,
      });
      setDraftTask('');
      await loadSnapshot(snapshot.session.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy('');
    }
  }, [draftTask, loadSnapshot, members, snapshot?.session?.id]);

  const requestReport = useCallback(async (member: CollabMemberRecord) => {
    setBusy(`report:${member.id}`);
    try {
      await window.ipcRenderer.teamRuntime.requestReport({
        sessionId: member.sessionId,
        toMemberId: member.id,
        taskId: member.currentTaskId,
      });
      await loadSnapshot(member.sessionId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy('');
    }
  }, [loadSnapshot]);

  const moveTask = useCallback(async (task: CollabTaskRecord, status: string) => {
    setBusy(`task:${task.id}`);
    try {
      await window.ipcRenderer.teamRuntime.updateTask({ taskId: task.id, status });
      await loadSnapshot(task.sessionId);
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : String(moveError));
    } finally {
      setBusy('');
    }
  }, [loadSnapshot]);

  const setSessionStatus = useCallback(async (status: 'active' | 'paused' | 'archived') => {
    if (!snapshot?.session?.id) return;
    setBusy(`session:${status}`);
    try {
      if (status === 'active') {
        await window.ipcRenderer.teamRuntime.resumeSession({ sessionId: snapshot.session.id });
      } else if (status === 'paused') {
        await window.ipcRenderer.teamRuntime.pauseSession({ sessionId: snapshot.session.id });
      } else {
        await window.ipcRenderer.teamRuntime.archiveSession({ sessionId: snapshot.session.id });
      }
      await loadSessions(snapshot.session.id);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : String(statusError));
    } finally {
      setBusy('');
    }
  }, [loadSessions, snapshot?.session?.id]);

  const tickReports = useCallback(async () => {
    if (!snapshot?.session?.id) return;
    setBusy('tick-reports');
    try {
      await window.ipcRenderer.teamRuntime.tickReports({ sessionId: snapshot.session.id });
      await loadSnapshot(snapshot.session.id);
    } catch (tickError) {
      setError(tickError instanceof Error ? tickError.message : String(tickError));
    } finally {
      setBusy('');
    }
  }, [loadSnapshot, snapshot?.session?.id]);

  const assignTaskOwner = useCallback(async (task: CollabTaskRecord, memberId: string) => {
    setBusy(`assign:${task.id}`);
    try {
      await window.ipcRenderer.teamRuntime.updateTask({ taskId: task.id, memberId });
      await loadSnapshot(task.sessionId);
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : String(assignError));
    } finally {
      setBusy('');
    }
  }, [loadSnapshot]);

  return (
    <div className="h-full min-h-0 bg-[#f8faf8] text-[#18211b]">
      <div className="flex h-full min-h-0 flex-col gap-4 px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-[#dbe8d8] bg-white px-2.5 py-1 text-[11px] text-[#5f7662]">
              <Users className="h-3 w-3" />
              Collaboration Workboard
            </div>
            <h1 className="mt-2 text-[24px] font-semibold tracking-[-0.04em]">团队成员与任务看板</h1>
          </div>
          <div className="flex items-center gap-2">
            {onSwitchRedclaw && (
              <button onClick={onSwitchRedclaw} className="rounded-full border border-[#dce6da] bg-white px-3 py-1.5 text-[12px] text-[#607166]">
                RedClaw 任务
              </button>
            )}
            {snapshot?.session?.id && (
              <>
                <button
                  onClick={() => void tickReports()}
                  disabled={busy === 'tick-reports'}
                  className="rounded-full border border-[#dce6da] bg-white px-3 py-1.5 text-[12px] text-[#607166]"
                >
                  汇报 tick
                </button>
                {snapshot.session.status === 'paused' ? (
                  <button
                    onClick={() => void setSessionStatus('active')}
                    disabled={busy === 'session:active'}
                    className="rounded-full border border-[#b8d2b8] bg-[#eef7ef] px-3 py-1.5 text-[12px] text-[#37563d]"
                  >
                    恢复
                  </button>
                ) : (
                  <button
                    onClick={() => void setSessionStatus('paused')}
                    disabled={busy === 'session:paused'}
                    className="rounded-full border border-[#dce6da] bg-white px-3 py-1.5 text-[12px] text-[#607166]"
                  >
                    暂停
                  </button>
                )}
                <button
                  onClick={() => void setSessionStatus('archived')}
                  disabled={busy === 'session:archived'}
                  className="rounded-full border border-[#eed0d0] bg-[#fff8f8] px-3 py-1.5 text-[12px] text-[#9a5656]"
                >
                  归档
                </button>
              </>
            )}
            <button onClick={() => void loadSessions()} className="inline-flex items-center rounded-full border border-[#dce6da] bg-white px-3 py-1.5 text-[12px] text-[#607166]">
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>
        </div>

        {error && (
          <div className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-700">
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </div>
        )}

        <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[260px_minmax(0,1fr)_340px]">
          <aside className="min-h-0 overflow-hidden rounded-[24px] border border-[#dfe9dc] bg-white">
            <div className="border-b border-[#edf2ea] px-4 py-3">
              <div className="text-[13px] font-medium">协作项目</div>
              <div className="mt-2 flex gap-1.5">
                <input
                  value={draftObjective}
                  onChange={(event) => setDraftObjective(event.currentTarget.value)}
                  placeholder="新建项目目标"
                  className="min-w-0 flex-1 rounded-full border border-[#dde7da] px-3 py-1.5 text-[12px] outline-none"
                />
                <button onClick={() => void createSession()} disabled={busy === 'create-session'} className="rounded-full bg-[#24412c] px-2.5 text-white">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="h-[calc(100%-94px)] overflow-y-auto p-2.5">
              {sessions.length === 0 ? (
                <div className="px-3 py-8 text-center text-[12px] leading-5 text-[#71806f]">
                  还没有协作项目。先创建一个目标，然后添加成员和任务。
                </div>
              ) : sessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => {
                    setSelectedSessionId(session.id);
                    void loadSnapshot(session.id);
                  }}
                  className={`mb-2 w-full rounded-[18px] border px-3 py-2.5 text-left ${
                    selectedSessionId === session.id ? 'border-[#9fbea2] bg-[#eef7ef]' : 'border-[#edf2ea] bg-[#fbfdfb]'
                  }`}
                >
                  <div className="truncate text-[13px] font-medium">{session.title}</div>
                  <div className="mt-1 text-[11px] text-[#748070]">{statusLabel(session.status)} · {formatTs(session.updatedAt)}</div>
                </button>
              ))}
            </div>
          </aside>

          <main className="min-h-0 overflow-hidden rounded-[24px] border border-[#dfe9dc] bg-white">
            <div className="flex items-center justify-between border-b border-[#edf2ea] px-4 py-3">
              <div>
                <div className="text-[13px] font-medium">{snapshot?.session?.objective || '选择或创建协作项目'}</div>
                <div className="mt-0.5 text-[11px] text-[#748070]">
                  {members.length} 个成员 · {tasks.length} 个任务 · {reports.length} 条汇报
                </div>
              </div>
              {snapshot?.session?.id && (
                <div className="flex gap-1.5">
                  <input
                    value={draftTask}
                    onChange={(event) => setDraftTask(event.currentTarget.value)}
                    placeholder="新建任务"
                    className="w-[180px] rounded-full border border-[#dde7da] px-3 py-1.5 text-[12px] outline-none"
                  />
                  <button onClick={() => void createTask()} disabled={busy === 'create-task'} className="rounded-full bg-[#24412c] px-3 py-1.5 text-[12px] text-white">
                    创建
                  </button>
                </div>
              )}
            </div>

            <div className="grid h-[calc(100%-61px)] min-h-0 grid-cols-1 gap-2 overflow-x-auto p-3 lg:grid-cols-3 2xl:grid-cols-6">
              {boardColumns.map((column) => {
                const columnTasks = tasks.filter((task) => taskColumn(task.status) === column.key);
                return (
                  <section key={column.key} className="min-h-[260px] rounded-[20px] border border-[#edf2ea] bg-[#f8fbf7] p-2.5">
                    <div className="mb-2 flex items-center justify-between px-1">
                      <div className="text-[12px] font-medium text-[#314237]">{column.label}</div>
                      <div className="text-[11px] text-[#768474]">{columnTasks.length}</div>
                    </div>
                    <div className="space-y-2">
                      {columnTasks.map((task) => {
                        const owner = task.memberId ? memberById.get(task.memberId) : null;
                        const latest = latestReportForTask(reports, task.id);
                        return (
                          <button
                            key={task.id}
                            onClick={() => setSelectedTaskId(task.id)}
                            className={`w-full rounded-[16px] border bg-white px-3 py-2.5 text-left ${
                              selectedTask?.id === task.id ? 'border-[#94b99b]' : 'border-[#e4ece1]'
                            }`}
                          >
                            <div className="text-[12px] font-semibold">{task.title}</div>
                            <div className="mt-1 text-[10px] text-[#748070]">
                              {owner?.displayName || '未分配'} · P{task.priority}
                            </div>
                            {latest && (
                              <div className="mt-2 line-clamp-2 rounded-[12px] bg-[#f1f6ef] px-2 py-1.5 text-[10px] leading-4 text-[#5b6d5f]">
                                {latest.summary || statusLabel(latest.status)}
                              </div>
                            )}
                            <div className="mt-2 flex items-center justify-between text-[10px] text-[#8a9588]">
                              <span>{task.progressPercent ?? 0}%</span>
                              <span>{task.artifactIds.length + task.artifacts.length} 产物</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </main>

          <aside className="min-h-0 overflow-y-auto rounded-[24px] border border-[#dfe9dc] bg-white px-4 py-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">成员</div>
                <div className="mt-0.5 text-[11px] text-[#748070]">状态、当前任务和最新汇报</div>
              </div>
            </div>
            {snapshot?.session?.id && (
              <div className="mt-3 flex gap-1.5">
                <input
                  value={draftMember}
                  onChange={(event) => setDraftMember(event.currentTarget.value)}
                  placeholder="添加成员"
                  className="min-w-0 flex-1 rounded-full border border-[#dde7da] px-3 py-1.5 text-[12px] outline-none"
                />
                <button onClick={() => void addMember()} disabled={busy === 'add-member'} className="rounded-full bg-[#24412c] px-3 py-1.5 text-[12px] text-white">
                  添加
                </button>
              </div>
            )}

            <div className="mt-3 space-y-2.5">
              {members.map((member) => {
                const currentTask = member.currentTaskId ? tasks.find((task) => task.id === member.currentTaskId) : null;
                const latest = latestReportForMember(reports, member.id);
                return (
                  <div key={member.id} className="rounded-[18px] border border-[#e4ece1] bg-[#fbfdfb] px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[12px] font-semibold">{member.displayName}</div>
                        <div className="mt-0.5 text-[10px] text-[#748070]">{member.roleId} · {member.sourceKind}</div>
                      </div>
                      <button onClick={() => void requestReport(member)} className="rounded-full border border-[#dce6da] bg-white px-2 py-1 text-[10px] text-[#607166]">
                        <Send className="inline h-3 w-3" /> 汇报
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded-full bg-[#edf6ee] px-2 py-0.5 text-[#4f7358]">{statusLabel(member.status)}</span>
                      <span className="rounded-full bg-[#f1f5f0] px-2 py-0.5 text-[#6f7d70]">{currentTask?.title || '无当前任务'}</span>
                    </div>
                    {latest && (
                      <div className="mt-2 rounded-[14px] bg-white px-2.5 py-2 text-[11px] leading-5 text-[#526456]">
                        <div className="mb-1 flex items-center gap-1 text-[10px] text-[#879184]">
                          <Clock3 className="h-3 w-3" />
                          {formatTs(latest.createdAt)}
                        </div>
                        {latest.summary || statusLabel(latest.status)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {selectedTask && (
              <section className="mt-4 rounded-[20px] border border-[#e4ece1] bg-[#fbfdfb] px-3 py-3">
                <div className="text-[13px] font-medium">任务详情</div>
                <div className="mt-2 text-[12px] font-semibold">{selectedTask.title}</div>
                <div className="mt-1 text-[12px] leading-5 text-[#607166]">{selectedTask.description || selectedTask.objective}</div>
                <label className="mt-3 block text-[10px] uppercase tracking-[0.14em] text-[#879184]">
                  Owner
                </label>
                <select
                  value={selectedTask.memberId || ''}
                  onChange={(event) => void assignTaskOwner(selectedTask, event.currentTarget.value)}
                  className="mt-1 w-full rounded-full border border-[#dce6da] bg-white px-3 py-1.5 text-[12px] text-[#405246] outline-none"
                >
                  <option value="">未分配</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>{member.displayName}</option>
                  ))}
                </select>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {boardColumns.map((column) => (
                    <button
                      key={column.key}
                      onClick={() => void moveTask(selectedTask, column.key)}
                      className="rounded-full border border-[#dce6da] bg-white px-2 py-1 text-[10px] text-[#607166]"
                    >
                      {column.label}
                    </button>
                  ))}
                  {selectedTask.memberId && memberById.get(selectedTask.memberId) && (
                    <button
                      onClick={() => void requestReport(memberById.get(selectedTask.memberId) as CollabMemberRecord)}
                      className="rounded-full border border-[#b8d2b8] bg-[#eef7ef] px-2 py-1 text-[10px] text-[#37563d]"
                    >
                      请求负责人汇报
                    </button>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  {reports.filter((report) => report.taskId === selectedTask.id).slice(-4).map((report) => (
                    <div key={report.id} className="rounded-[14px] bg-white px-2.5 py-2 text-[11px] leading-5">
                      <div className="mb-1 flex items-center gap-1 text-[10px] text-[#879184]">
                        <MessageSquare className="h-3 w-3" />
                        {statusLabel(report.status)} · {formatTs(report.createdAt)}
                      </div>
                      {report.summary}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
