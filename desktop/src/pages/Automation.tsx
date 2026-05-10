import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Clock3, Loader2, MoreHorizontal, PauseCircle, Pencil, Play, PlayCircle, Plus, Trash2 } from 'lucide-react';
import { appAlert, appConfirm } from '../utils/appDialogs';

type TaskListResponse = Awaited<ReturnType<typeof window.ipcRenderer.redclawRunner.taskList>>;
type TaskListItem = NonNullable<TaskListResponse['items']>[number];

interface AutomationProps {
  isActive?: boolean;
  onOpenRedClawSession?: (sessionId: string) => void;
}

interface AutomationDraft {
  name: string;
  scheduleMode: ScheduleMode;
  weekday: number;
  time: string;
  prompt: string;
}

type ScheduleMode = 'hourly' | 'daily' | 'workday' | 'weekly';
type SchedulePanel = 'mode' | 'weekday' | 'time' | null;

const WEEKDAY_OPTIONS = [
  { value: 1, label: '星期一' },
  { value: 2, label: '星期二' },
  { value: 3, label: '星期三' },
  { value: 4, label: '星期四' },
  { value: 5, label: '星期五' },
  { value: 6, label: '星期六' },
  { value: 0, label: '星期日' },
];

const TIME_OPTIONS = Array.from({ length: 24 * 4 }, (_, index) => {
  const totalMinutes = index * 15;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
});

const defaultDraft: AutomationDraft = {
  name: '',
  scheduleMode: 'daily',
  weekday: 1,
  time: '09:00',
  prompt: '',
};

function draftFromItem(item: TaskListItem): AutomationDraft {
  const weekdays = Array.isArray(item.weekdays) ? item.weekdays.join(',') : '';
  const scheduleMode: ScheduleMode = item.triggerKind === 'interval'
    ? 'hourly'
    : item.triggerKind === 'weekly' && weekdays === '1,2,3,4,5'
      ? 'workday'
      : item.triggerKind === 'weekly'
        ? 'weekly'
        : 'daily';
  return {
    name: item.title || '',
    scheduleMode,
    weekday: Array.isArray(item.weekdays) && item.weekdays.length > 0 ? Number(item.weekdays[0]) : 1,
    time: String(item.time || '09:00').slice(0, 5),
    prompt: item.prompt || item.goal || '',
  };
}

function scheduleModeLabel(mode: ScheduleMode): string {
  switch (mode) {
    case 'hourly':
      return '每小时';
    case 'workday':
      return '工作日';
    case 'weekly':
      return '每周';
    case 'daily':
    default:
      return '每天';
  }
}

function weekdayLabel(value: number): string {
  return WEEKDAY_OPTIONS.find((item) => item.value === value)?.label || '星期一';
}

function scheduleButtonLabel(draft: AutomationDraft): string {
  if (draft.scheduleMode === 'hourly') return '每小时';
  if (draft.scheduleMode === 'weekly') return `${weekdayLabel(draft.weekday)} ${draft.time}`;
  return `${scheduleModeLabel(draft.scheduleMode)} ${draft.time}`;
}

function isAutomationTask(item: TaskListItem): boolean {
  return item.kind === 'scheduled' || item.kind === 'scheduled_draft' || item.sourceKind === 'scheduled';
}

function scheduledPayloadFromDraft(draft: AutomationDraft, name: string, prompt: string): Record<string, unknown> {
  const base = {
    name,
    prompt,
    actionType: 'redclaw_prompt',
    ownerScope: 'manual:redclaw',
    timezone: 'local',
    missedRunPolicy: 'single',
    enabled: true,
  };
  if (draft.scheduleMode === 'hourly') {
    return { ...base, mode: 'interval', intervalMinutes: 60 };
  }
  if (draft.scheduleMode === 'daily') {
    return { ...base, mode: 'daily', time: draft.time };
  }
  if (draft.scheduleMode === 'workday') {
    return { ...base, mode: 'weekly', time: draft.time, weekdays: [1, 2, 3, 4, 5] };
  }
  if (draft.scheduleMode === 'weekly') {
    return { ...base, mode: 'weekly', time: draft.time, weekdays: [draft.weekday] };
  }
  return { ...base, mode: 'daily', time: draft.time };
}

function formatSchedule(item: TaskListItem): string {
  if (item.triggerKind === 'daily') {
    return `每天 ${String(item.time || '09:00').slice(0, 5)}`;
  }
  if (item.triggerKind === 'weekly') {
    const weekday = Array.isArray(item.weekdays) && item.weekdays.length > 0
      ? weekdayLabel(Number(item.weekdays[0]))
      : '每周';
    return `${weekday} ${String(item.time || '09:00').slice(0, 5)}`;
  }
  if (item.triggerKind === 'interval') {
    return `每 ${Number(item.intervalMinutes || 60)} 分钟`;
  }
  if (item.triggerKind === 'once' && item.runAt) {
    const ts = Date.parse(item.runAt);
    if (Number.isFinite(ts)) {
      return new Date(ts).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
  }
  return '待定';
}

function formatSidebarTime(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const diffMs = Date.now() - date.getTime();
  const absDiff = Math.abs(diffMs);
  if (absDiff < 60_000) return '刚刚';
  if (absDiff < 60 * 60_000) return `${Math.max(1, Math.round(absDiff / 60_000))} 分钟${diffMs >= 0 ? '前' : '后'}`;
  if (absDiff < 24 * 60 * 60_000) return `${Math.max(1, Math.round(absDiff / (60 * 60_000)))} 小时${diffMs >= 0 ? '前' : '后'}`;
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function latestExecutionRecord(item: TaskListItem | null): Record<string, unknown> | null {
  if (!item) return null;
  const latest = recordFromUnknown(item).latestExecution;
  return Object.keys(recordFromUnknown(latest)).length > 0 ? recordFromUnknown(latest) : null;
}

function executionStatusLabel(status: unknown): string {
  if (status === 'succeeded') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'running') return '运行中';
  if (status === 'queued') return '排队中';
  return '已处理';
}

function sortAutomationItems(items: TaskListItem[]): TaskListItem[] {
  return [...items].sort((left, right) => {
    const leftDueAt = Date.parse(left.nextDueAt || '') || Number.MAX_SAFE_INTEGER;
    const rightDueAt = Date.parse(right.nextDueAt || '') || Number.MAX_SAFE_INTEGER;
    if (leftDueAt !== rightDueAt) return leftDueAt - rightDueAt;
    return Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || '');
  });
}

function assertActionSuccess(result: unknown, fallbackMessage: string): void {
  if (!result || typeof result !== 'object') return;
  const record = result as { success?: unknown; error?: unknown };
  if (record.success === false) {
    throw new Error(String(record.error || fallbackMessage));
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: unknown, key: string): string {
  const raw = recordFromUnknown(value)[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function extractRunSessionId(value: unknown): string {
  const root = recordFromUnknown(value);
  const directSessionId = stringField(root, 'sessionId');
  if (directSessionId) return directSessionId;
  const run = recordFromUnknown(root.run);
  const runSessionId = stringField(run, 'sessionId');
  if (runSessionId) return runSessionId;
  const result = recordFromUnknown(run.result);
  return stringField(result, 'sessionId');
}

function confirmedTaskId(value: unknown, fallbackTaskId: string): string {
  const result = recordFromUnknown(recordFromUnknown(value).result);
  const definition = recordFromUnknown(result.definition);
  return stringField(result, 'jobDefinitionId')
    || stringField(definition, 'id')
    || fallbackTaskId;
}

function scheduleToCron(draft: AutomationDraft): string {
  if (draft.scheduleMode === 'hourly') {
    return '0 * * * *';
  }
  const [hourRaw = '9', minuteRaw = '0'] = draft.time.split(':');
  const hour = Math.min(23, Math.max(0, Number(hourRaw) || 0));
  const minute = Math.min(59, Math.max(0, Number(minuteRaw) || 0));
  if (draft.scheduleMode === 'workday') {
    return `${minute} ${hour} * * 1,2,3,4,5`;
  }
  if (draft.scheduleMode === 'weekly') {
    return `${minute} ${hour} * * ${draft.weekday}`;
  }
  return `${minute} ${hour} * * *`;
}

export function Automation({ isActive = true, onOpenRedClawSession }: AutomationProps) {
  const [items, setItems] = useState<TaskListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<AutomationDraft>(defaultDraft);
  const [editingItem, setEditingItem] = useState<TaskListItem | null>(null);
  const [schedulePickerOpen, setSchedulePickerOpen] = useState(false);
  const [schedulePanel, setSchedulePanel] = useState<SchedulePanel>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyActionId, setBusyActionId] = useState('');
  const [menuOpenId, setMenuOpenId] = useState('');
  const [menuBusyId, setMenuBusyId] = useState('');
  const loadRequestRef = useRef(0);
  const scheduleControlRef = useRef<HTMLDivElement | null>(null);
  const timeMenuRef = useRef<HTMLDivElement | null>(null);
  const selectedTimeRef = useRef<HTMLButtonElement | null>(null);

  const currentItems = useMemo(
    () => sortAutomationItems(items.filter(isAutomationTask)),
    [items],
  );

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    if (items.length === 0) {
      setLoading(true);
    }
    setError('');
    try {
      const result = await window.ipcRenderer.redclawRunner.taskList({ includeDrafts: true });
      if (requestId !== loadRequestRef.current) return;
      setItems(Array.isArray(result?.items) ? result.items : []);
    } catch (loadError) {
      if (requestId !== loadRequestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
      }
    }
  }, [items.length]);

  useEffect(() => {
    if (!isActive) return;
    void load();
  }, [isActive, load]);

  useEffect(() => {
    if (!isActive) return;
    const listener = () => {
      void load();
    };
    window.ipcRenderer.on('redclaw:runner-status', listener);
    return () => window.ipcRenderer.off('redclaw:runner-status', listener);
  }, [isActive, load]);

  const openDialog = useCallback(() => {
    setDraft(defaultDraft);
    setEditingItem(null);
    setSchedulePickerOpen(false);
    setSchedulePanel(null);
    setDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((item: TaskListItem) => {
    setDraft(draftFromItem(item));
    setEditingItem(item);
    setSchedulePickerOpen(false);
    setSchedulePanel(null);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    if (submitting) return;
    setDialogOpen(false);
    setSchedulePickerOpen(false);
    setSchedulePanel(null);
  }, [submitting]);

  useEffect(() => {
    if (!schedulePickerOpen || schedulePanel !== 'time') return;
    window.requestAnimationFrame(() => {
      const menu = timeMenuRef.current;
      const selected = selectedTimeRef.current;
      if (!menu || !selected) return;
      menu.scrollTop = Math.max(0, selected.offsetTop - (menu.clientHeight - selected.offsetHeight) / 2);
    });
  }, [draft.time, schedulePanel, schedulePickerOpen]);

  useEffect(() => {
    if (!schedulePickerOpen) return;

    const closeSchedulePicker = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && scheduleControlRef.current?.contains(target)) return;
      setSchedulePickerOpen(false);
      setSchedulePanel(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSchedulePickerOpen(false);
      setSchedulePanel(null);
    };

    document.addEventListener('mousedown', closeSchedulePicker);
    document.addEventListener('touchstart', closeSchedulePicker);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeSchedulePicker);
      document.removeEventListener('touchstart', closeSchedulePicker);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [schedulePickerOpen]);

  useEffect(() => {
    if (!menuOpenId) return;

    const closeMenu = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('[data-automation-row-menu]')) return;
      setMenuOpenId('');
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpenId('');
    };

    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('touchstart', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('touchstart', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpenId]);

  const submit = useCallback(async () => {
    const name = draft.name.trim();
    const prompt = draft.prompt.trim();
    if (!name) {
      void appAlert('请填写自动化名称。');
      return;
    }
    if (!prompt) {
      void appAlert('请填写执行内容。');
      return;
    }
    setSubmitting(true);
    try {
      const directScheduledPayload = scheduledPayloadFromDraft(draft, name, prompt);
      if (!editingItem) {
        const created = await window.ipcRenderer.redclawRunner.addScheduled(directScheduledPayload);
        if (!created?.success) {
          throw new Error(created?.error || '创建定时任务失败。');
        }
        setDialogOpen(false);
        setEditingItem(null);
        await load();
        return;
      }

      const intent = {
        kind: 'scheduled',
        name,
        cron: scheduleToCron(draft),
        prompt,
        goal: prompt,
        actionType: 'redclaw_prompt',
        ownerScope: 'manual:redclaw',
        timezone: 'local',
        missedRunPolicy: 'single',
        creatorMode: 'ui-manual',
        createdBy: 'automation-page',
      };

      if (editingItem) {
        await window.ipcRenderer.redclawRunner.taskUpdate({
          jobDefinitionId: editingItem.definitionId,
          patch: intent,
          reason: '用户从自动化页面更新任务',
        });
      }

      setDialogOpen(false);
      setEditingItem(null);
      await load();
    } catch (submitError) {
      void appAlert(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  }, [draft, editingItem, load]);

  const runNow = useCallback(async (item: TaskListItem) => {
    const sourceTaskId = String(item.sourceTaskId || '').trim();
    const definitionId = String(item.definitionId || '').trim();
    let taskId = sourceTaskId || definitionId;
    if (!taskId) {
      void appAlert('未找到定时任务源记录。');
      return;
    }
    setBusyActionId(item.definitionId);
    try {
      if (item.requiresConfirmation) {
        const confirmed = await window.ipcRenderer.redclawRunner.taskConfirm({
          draftId: definitionId,
          confirm: true,
        });
        assertActionSuccess(confirmed, '确认自动化任务失败。');
        taskId = confirmedTaskId(confirmed, taskId);
      }
      const runResult = await window.ipcRenderer.redclawRunner.runScheduledNow({ taskId });
      assertActionSuccess(runResult, '立即执行定时任务失败。');
      const sessionId = extractRunSessionId(runResult);
      await load();
      if (sessionId) {
        onOpenRedClawSession?.(sessionId);
      }
    } catch (runError) {
      void appAlert(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusyActionId('');
    }
  }, [load, onOpenRedClawSession]);

  const toggleTaskEnabled = useCallback(async (item: TaskListItem) => {
    const sourceTaskId = String(item.sourceTaskId || '');
    if (!sourceTaskId) {
      void appAlert('未找到定时任务源记录。');
      return;
    }
    setMenuBusyId(item.definitionId);
    try {
      assertActionSuccess(
        await window.ipcRenderer.redclawRunner.setScheduledEnabled({
          taskId: sourceTaskId,
          enabled: !item.enabled,
        }),
        item.enabled ? '暂停定时任务失败。' : '恢复定时任务失败。',
      );
      setMenuOpenId('');
      await load();
    } catch (toggleError) {
      void appAlert(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setMenuBusyId('');
    }
  }, [load]);

  const deleteTask = useCallback(async (item: TaskListItem) => {
    const confirmed = await appConfirm(`确定删除自动化“${item.title || '未命名自动化'}”吗？`, {
      title: '删除自动化',
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!confirmed) return;

    setMenuBusyId(item.definitionId);
    try {
      const sourceTaskId = String(item.sourceTaskId || '');
      if (sourceTaskId && !item.requiresConfirmation) {
        assertActionSuccess(
          await window.ipcRenderer.redclawRunner.removeScheduled({ taskId: sourceTaskId }),
          '删除定时任务失败。',
        );
      } else {
        assertActionSuccess(
          await window.ipcRenderer.redclawRunner.taskCancel({
            jobDefinitionId: item.definitionId,
            reason: '用户从自动化页面删除任务',
            deleteSource: true,
          }),
          '删除自动化失败。',
        );
      }
      setMenuOpenId('');
      await load();
    } catch (deleteError) {
      void appAlert(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setMenuBusyId('');
    }
  }, [load]);

  const deleteEditingTask = useCallback(async () => {
    if (!editingItem) return;
    await deleteTask(editingItem);
    setDialogOpen(false);
    setEditingItem(null);
  }, [deleteTask, editingItem]);

  const toggleEditingTaskEnabled = useCallback(async () => {
    if (!editingItem) return;
    const sourceTaskId = String(editingItem.sourceTaskId || '');
    if (!sourceTaskId) {
      void appAlert('未找到定时任务源记录。');
      return;
    }
    if (editingItem.requiresConfirmation) {
      void appAlert('任务需要先确认后才能启用或暂停。');
      return;
    }
    setMenuBusyId(editingItem.definitionId);
    try {
      const nextEnabled = !editingItem.enabled;
      assertActionSuccess(
        await window.ipcRenderer.redclawRunner.setScheduledEnabled({
          taskId: sourceTaskId,
          enabled: nextEnabled,
        }),
        editingItem.enabled ? '暂停定时任务失败。' : '恢复定时任务失败。',
      );
      setEditingItem((current) => current && current.definitionId === editingItem.definitionId
        ? { ...current, enabled: nextEnabled }
        : current);
      await load();
    } catch (toggleError) {
      void appAlert(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setMenuBusyId('');
    }
  }, [editingItem, load]);

  if (dialogOpen) {
    const latestExecution = latestExecutionRecord(editingItem);
    const statusText = editingItem ? (editingItem.enabled ? '运行中' : '已暂停') : '草稿';
    const latestStatus = executionStatusLabel(latestExecution?.status);

    return (
      <div className="automation-page automation-editor-page h-full min-h-0 overflow-auto">
        <div className="automation-editor-shell">
          <header className="automation-editor-topbar">
            <div className="automation-editor-breadcrumb">
              <button type="button" className="automation-breadcrumb-button" onClick={closeDialog}>
                <ArrowLeft className="h-4 w-4" strokeWidth={1.7} />
                自动化功能
              </button>
              <span className="automation-breadcrumb-separator">›</span>
              <span className="automation-breadcrumb-title">{draft.name.trim() || (editingItem ? editingItem.title : '新建自动化功能')}</span>
            </div>
            <div className="automation-editor-top-actions">
              {editingItem && (
                <>
                  <button type="button" className="automation-editor-icon-button" onClick={() => void runNow(editingItem)} title="立即运行" aria-label="立即运行">
                    <PlayCircle className="h-[18px] w-[18px]" strokeWidth={1.75} />
                  </button>
                  <button type="button" className="automation-editor-icon-button" onClick={() => void deleteEditingTask()} title="删除" aria-label="删除">
                    <Trash2 className="h-[18px] w-[18px]" strokeWidth={1.75} />
                  </button>
                </>
              )}
              <button type="button" className="automation-editor-secondary-button" onClick={closeDialog} disabled={submitting}>
                取消
              </button>
              <button type="button" className="automation-editor-primary-button" onClick={() => void submit()} disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                保存
              </button>
            </div>
          </header>

          <div className="automation-editor-layout">
            <main className="automation-editor-main">
              <input
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                className="automation-editor-title-input"
                placeholder="自动化功能标题"
              />
              <textarea
                value={draft.prompt}
                onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
                className="automation-editor-prompt"
                placeholder="添加提示词，例如：在 $sentry 中查找崩溃"
              />
            </main>

            <aside className="automation-editor-sidebar">
              <section className="automation-side-section">
                <div className="automation-side-heading">状态</div>
                <div className="automation-side-row">
                  <span className="automation-side-label">状态</span>
                  <span className={`automation-status-pill ${editingItem?.enabled ? 'is-active' : 'is-paused'}`}>
                    <span />
                    {statusText}
                  </span>
                </div>
                <div className="automation-side-row">
                  <span className="automation-side-label">下次运行</span>
                  <span className="automation-side-value">{formatSidebarTime(editingItem?.nextDueAt)}</span>
                </div>
                <div className="automation-side-row">
                  <span className="automation-side-label">上次运行时间</span>
                  <span className="automation-side-value">{formatSidebarTime(latestExecution?.updatedAt)}</span>
                </div>
              </section>

              <section className="automation-side-section">
                <div className="automation-side-heading">设置</div>
                <div className="automation-side-row automation-side-control-row">
                  <span className="automation-side-label">启用状态</span>
                  <button
                    type="button"
                    className={`automation-status-pill automation-status-button ${editingItem?.enabled ? 'is-active' : 'is-paused'}`}
                    onClick={() => void toggleEditingTaskEnabled()}
                    disabled={!editingItem || menuBusyId === editingItem.definitionId || editingItem.requiresConfirmation}
                  >
                    <span />
                    {menuBusyId === editingItem?.definitionId ? '处理中' : statusText}
                  </button>
                </div>
                <div className="automation-side-row automation-side-control-row">
                  <span className="automation-side-label">重复周期</span>
                  <div className="automation-schedule-control automation-schedule-control--side" ref={scheduleControlRef}>
                    <button
                      type="button"
                      className="automation-schedule-button"
                      onClick={() => {
                        setSchedulePickerOpen((open) => !open);
                        setSchedulePanel(null);
                      }}
                    >
                      <span>{scheduleButtonLabel(draft)}</span>
                      <ChevronDown className="h-[15px] w-[15px]" strokeWidth={1.65} />
                    </button>
                    {schedulePickerOpen && (
                      <div className="automation-schedule-popover">
                        <div className="automation-schedule-title">计划</div>
                        <button type="button" className={schedulePanel === 'mode' ? 'automation-schedule-select automation-schedule-select--open' : 'automation-schedule-select'} onClick={() => setSchedulePanel((current) => current === 'mode' ? null : 'mode')}>
                          <span>{scheduleModeLabel(draft.scheduleMode)}</span>
                          <ChevronDown className="h-[17px] w-[17px]" strokeWidth={1.65} />
                        </button>
                        {schedulePanel === 'mode' && (
                          <div className="automation-schedule-menu">
                            {(['hourly', 'daily', 'workday', 'weekly'] as ScheduleMode[]).map((mode) => (
                              <button key={mode} type="button" onClick={() => { setDraft((current) => ({ ...current, scheduleMode: mode })); setSchedulePanel(null); }} className="automation-schedule-option">
                                <span>{scheduleModeLabel(mode)}</span>
                                {draft.scheduleMode === mode && <Check className="h-[18px] w-[18px]" strokeWidth={1.7} />}
                              </button>
                            ))}
                          </div>
                        )}
                        {draft.scheduleMode === 'weekly' && (
                          <>
                            <button type="button" className={schedulePanel === 'weekday' ? 'automation-schedule-select automation-schedule-select--open automation-schedule-subselect' : 'automation-schedule-select automation-schedule-subselect'} onClick={() => setSchedulePanel((current) => current === 'weekday' ? null : 'weekday')}>
                              <span>{weekdayLabel(draft.weekday)}</span>
                              <ChevronDown className="h-[17px] w-[17px]" strokeWidth={1.65} />
                            </button>
                            {schedulePanel === 'weekday' && (
                              <div className="automation-schedule-menu">
                                {WEEKDAY_OPTIONS.map((option) => (
                                  <button key={option.value} type="button" onClick={() => { setDraft((current) => ({ ...current, weekday: option.value })); setSchedulePanel(null); }} className="automation-schedule-option">
                                    <span>{option.label}</span>
                                    {draft.weekday === option.value && <Check className="h-[18px] w-[18px]" strokeWidth={1.7} />}
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                        {draft.scheduleMode === 'hourly' ? (
                          <div className="automation-schedule-hint">每小时整点执行</div>
                        ) : (
                          <div className="automation-time-picker">
                            <button type="button" className={schedulePanel === 'time' ? 'automation-schedule-select automation-schedule-select--open automation-schedule-subselect' : 'automation-schedule-select automation-schedule-subselect'} onClick={() => setSchedulePanel((current) => current === 'time' ? null : 'time')}>
                              <span>{draft.time}</span>
                              <Clock3 className="h-[17px] w-[17px]" strokeWidth={1.65} />
                            </button>
                            {schedulePanel === 'time' && (
                              <div className="automation-time-menu" ref={timeMenuRef}>
                                {TIME_OPTIONS.map((time) => (
                                  <button key={time} ref={time === draft.time ? selectedTimeRef : null} type="button" className={time === draft.time ? 'automation-time-option automation-time-option--selected' : 'automation-time-option'} onClick={() => { setDraft((current) => ({ ...current, time })); setSchedulePanel(null); }}>
                                    {time}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section className="automation-side-section">
                <div className="automation-side-heading">运行历史记录</div>
                {latestExecution ? (
                  <div className="automation-history-row">
                    <span className="automation-history-dot"><Check className="h-3 w-3" strokeWidth={1.8} /></span>
                    <span className="automation-history-title">{editingItem?.title || draft.name || '自动化任务'}</span>
                    <span className="automation-history-project">RedConvert</span>
                    <span className="automation-history-time">{formatSidebarTime(latestExecution.updatedAt)}</span>
                    <span className="automation-history-status">{latestStatus}</span>
                  </div>
                ) : (
                  <div className="automation-history-empty">暂无运行记录</div>
                )}
              </section>
            </aside>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="automation-page h-full min-h-0 overflow-auto">
      <button
        type="button"
        onClick={openDialog}
        className="automation-new-button"
      >
        <Plus className="h-[14px] w-[14px]" strokeWidth={1.7} />
        <span>新建自动化功能</span>
      </button>

      <main className="automation-content">
        <h1 className="automation-title">自动化</h1>

        <section className="automation-section" aria-label="当前自动化">
          <div className="automation-section-title">当前</div>
          <div className="automation-list">
            {loading && currentItems.length === 0 && (
              <div className="automation-state">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!loading && error && (
              <button type="button" onClick={() => void load()} className="automation-error">
                {error}
              </button>
            )}
            {!loading && !error && currentItems.length === 0 && (
              <div className="automation-empty">暂无自动化</div>
            )}
            {currentItems.map((item) => (
              <div
                key={item.definitionId}
                className={menuOpenId === item.definitionId ? 'automation-row automation-row--menu-open' : 'automation-row'}
              >
                <div className="automation-row-main">
                  <span className={item.enabled ? 'automation-dot' : 'automation-dot automation-dot--off'} />
                  <span className="automation-row-title">{item.title || '未命名自动化'}</span>
                  <span className="automation-row-source">{item.requiresConfirmation ? '待确认' : 'RedConvert'}</span>
                </div>
                <div className="automation-row-schedule">{formatSchedule(item)}</div>
                <div className="automation-row-actions">
                  <button
                    type="button"
                    onClick={() => void runNow(item)}
                    className="automation-row-action"
                    aria-label="立即执行"
                    title="立即执行"
                    disabled={busyActionId === item.definitionId}
                  >
                    {busyActionId === item.definitionId
                      ? <Loader2 className="h-[17px] w-[17px] animate-spin" strokeWidth={1.75} />
                      : <Play className="h-[17px] w-[17px]" strokeWidth={1.75} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditDialog(item)}
                    className="automation-row-action"
                    aria-label="编辑"
                    title="编辑"
                  >
                    <Pencil className="h-[17px] w-[17px]" strokeWidth={1.75} />
                  </button>
                  <div className="automation-row-menu-wrap" data-automation-row-menu>
                    <button
                      type="button"
                      className="automation-row-action"
                      aria-label="更多"
                      title="更多"
                      onClick={() => setMenuOpenId((current) => current === item.definitionId ? '' : item.definitionId)}
                    >
                      <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.8} />
                    </button>
                    {menuOpenId === item.definitionId && (
                      <div className="automation-row-menu">
                        <button
                          type="button"
                          className="automation-row-menu-item"
                          disabled={menuBusyId === item.definitionId || item.requiresConfirmation}
                          onClick={() => void toggleTaskEnabled(item)}
                        >
                          {menuBusyId === item.definitionId
                            ? <Loader2 className="h-[17px] w-[17px] animate-spin" strokeWidth={1.75} />
                            : item.enabled
                              ? <PauseCircle className="h-[17px] w-[17px]" strokeWidth={1.75} />
                              : <PlayCircle className="h-[17px] w-[17px]" strokeWidth={1.75} />}
                          <span>{item.enabled ? '暂停' : '恢复'}</span>
                        </button>
                        <button
                          type="button"
                          className="automation-row-menu-item"
                          disabled={menuBusyId === item.definitionId}
                          onClick={() => void deleteTask(item)}
                        >
                          <Trash2 className="h-[17px] w-[17px]" strokeWidth={1.75} />
                          <span>删除</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

    </div>
  );
}
