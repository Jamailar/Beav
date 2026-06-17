import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, Plus, Users } from 'lucide-react';
import { clsx } from 'clsx';
import { Advisors, type AdvisorCreateMode, type AdvisorProfile } from './Advisors';
import type { TeamSection } from '../features/app-shell/types';
import { hasRenderableAssetUrl, resolveAssetUrl } from '../utils/pathManager';
import { appAlert } from '../utils/appDialogs';
import { TeamWorkbench } from './team-workbench/TeamWorkbench';
import type { TeamWorkbenchSession } from './team-workbench/teamWorkbenchTypes';

interface TeamProps {
  isActive?: boolean;
  onExecutionStateChange?: (active: boolean) => void;
}

const TEAM_SECTION_STORAGE_KEY = 'redbox:team-section:v1';

function readInitialTeamSection(): TeamSection {
  if (typeof window === 'undefined') return 'team-workbench';
  const saved = String(window.localStorage.getItem(TEAM_SECTION_STORAGE_KEY) || '').trim();
  if (saved === 'team-workbench') return 'team-workbench';
  return saved === 'members' ? 'members' : 'team-workbench';
}

function visibleCollabSessions(sessions: TeamWorkbenchSession[]): TeamWorkbenchSession[] {
  return sessions.filter((session) => !['archived', 'completed'].includes(String(session.status || '').toLowerCase()));
}

function renderAdvisorAvatarPreview(advisor: AdvisorProfile, compact = false) {
  if (hasRenderableAssetUrl(advisor.avatar)) {
    return (
      <img
        src={resolveAssetUrl(advisor.avatar)}
        alt={advisor.name}
        className="h-full w-full object-contain"
      />
    );
  }

  return (
    <span className={clsx('leading-none text-center', compact ? 'text-[8px]' : 'text-[10px]')}>
      {String(advisor.avatar || advisor.name || '?').trim().slice(0, 2)}
    </span>
  );
}

export function Team({ isActive = true, onExecutionStateChange }: TeamProps) {
  const [activeSection, setActiveSection] = useState<TeamSection>(readInitialTeamSection);
  const [mountedSections, setMountedSections] = useState<TeamSection[]>(() => [readInitialTeamSection()]);
  const [advisors, setAdvisors] = useState<AdvisorProfile[]>([]);
  const [collabSessions, setCollabSessions] = useState<TeamWorkbenchSession[]>([]);
  const [selectedAdvisorId, setSelectedAdvisorId] = useState<string | null>(null);
  const [selectedCollabSessionId, setSelectedCollabSessionId] = useState<string | null>(null);
  const [advisorCreateRequestKey, setAdvisorCreateRequestKey] = useState(0);
  const [advisorCreateMode, setAdvisorCreateMode] = useState<AdvisorCreateMode>('manual');
  const [isCreatePickerOpen, setIsCreatePickerOpen] = useState(false);
  const [isAdvisorsSectionOpen, setIsAdvisorsSectionOpen] = useState(true);
  const createMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadSidebarData = async () => {
      try {
        const [advisorList, collabList] = await Promise.all([
          window.ipcRenderer.advisors.list<AdvisorProfile>(),
          window.ipcRenderer.teamRuntime.listSessions(),
        ]);
        if (cancelled) return;
        setAdvisors(Array.isArray(advisorList) ? advisorList : []);
        setCollabSessions(Array.isArray(collabList) ? visibleCollabSessions(collabList as TeamWorkbenchSession[]) : []);
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to load team sidebar data:', error);
      }
    };

    void loadSidebarData();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleRuntimeEvent = (_event: unknown, envelope?: { eventType?: string }) => {
      const event = envelope || {};
      if (!String(event?.eventType || '').startsWith('runtime:collab-')) return;
      window.ipcRenderer.teamRuntime.listSessions()
        .then((sessions) => setCollabSessions(Array.isArray(sessions) ? visibleCollabSessions(sessions as TeamWorkbenchSession[]) : []))
        .catch((error) => console.error('Failed to refresh collaboration sessions:', error));
    };

    window.ipcRenderer.teamRuntime.onEvent(handleRuntimeEvent);
    return () => {
      window.ipcRenderer.teamRuntime.offEvent(handleRuntimeEvent);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(TEAM_SECTION_STORAGE_KEY, activeSection);
    setMountedSections((prev) => (
      prev.includes(activeSection) ? prev : [...prev, activeSection]
    ));
  }, [activeSection]);

  useEffect(() => {
    return () => {
      onExecutionStateChange?.(false);
    };
  }, [onExecutionStateChange]);

  useEffect(() => {
    if (!isCreatePickerOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!createMenuRef.current) return;
      if (!createMenuRef.current.contains(event.target as Node)) {
        setIsCreatePickerOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsCreatePickerOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isCreatePickerOpen]);

  useEffect(() => {
    if (collabSessions.length === 0) {
      setSelectedCollabSessionId(null);
      return;
    }
    if (!selectedCollabSessionId || !collabSessions.some((session) => session.id === selectedCollabSessionId)) {
      setSelectedCollabSessionId(collabSessions[0].id);
    }
  }, [collabSessions, selectedCollabSessionId]);

  useEffect(() => {
    if (advisors.length === 0) {
      setSelectedAdvisorId(null);
      return;
    }
    if (!selectedAdvisorId || !advisors.some((advisor) => advisor.id === selectedAdvisorId)) {
      setSelectedAdvisorId(advisors[0].id);
    }
  }, [advisors, selectedAdvisorId]);

  const selectedAdvisor = useMemo(
    () => advisors.find((advisor) => advisor.id === selectedAdvisorId) || null,
    [advisors, selectedAdvisorId],
  );
  const selectedCollabSession = useMemo(
    () => collabSessions.find((session) => session.id === selectedCollabSessionId) || null,
    [collabSessions, selectedCollabSessionId],
  );
  const openAdvisorCreate = (mode: AdvisorCreateMode = 'manual') => {
    setActiveSection('members');
    setAdvisorCreateMode(mode);
    setAdvisorCreateRequestKey((value) => value + 1);
    setIsCreatePickerOpen(false);
  };

  const createCollabSession = async () => {
    setIsCreatePickerOpen(false);
    let createdSession: TeamWorkbenchSession | null = null;
    try {
      const session = await window.ipcRenderer.teamRuntime.createSession({
        title: `团队 ${collabSessions.length + 1}`,
        objective: '请在 team 模式中拆解、执行并汇总这个任务。',
        source: 'team-workbench',
        runtimeMode: 'team',
      }) as TeamWorkbenchSession;
      createdSession = session;
      const nextSessions = await window.ipcRenderer.teamRuntime.listSessions() as TeamWorkbenchSession[];
      setCollabSessions(Array.isArray(nextSessions) ? visibleCollabSessions(nextSessions) : [session]);
      setSelectedCollabSessionId(session.id);
      setActiveSection('team-workbench');
    } catch (error) {
      console.error('Failed to create collaboration session:', error);
      if (createdSession?.id) {
        await window.ipcRenderer.teamRuntime.archiveSession({ sessionId: createdSession.id }).catch(() => {});
        const nextSessions = await window.ipcRenderer.teamRuntime.listSessions().catch(() => []) as TeamWorkbenchSession[];
        setCollabSessions(Array.isArray(nextSessions) ? visibleCollabSessions(nextSessions) : []);
      }
      void appAlert('团队创建失败，已清理未完成的数据。', {
        title: '创建团队失败',
        tone: 'danger',
      });
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[17.5rem] shrink-0 border-r border-border bg-surface-secondary/25 flex flex-col">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-base font-semibold text-text-primary">团队</div>
            </div>
            <div ref={createMenuRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => setIsCreatePickerOpen((prev) => !prev)}
                className="h-9 w-9 rounded-full border border-border bg-surface-primary text-text-tertiary hover:text-accent-primary hover:bg-surface-primary/80 transition-colors inline-flex items-center justify-center"
                title="新建"
                aria-label="新建"
              >
                <Plus className="w-4 h-4" />
              </button>

              {isCreatePickerOpen && (
                <div className="absolute right-0 top-[calc(100%+8px)] z-30 w-48 overflow-hidden rounded-xl border border-border bg-surface-primary shadow-lg">
                  <div className="py-1.5">
                    <button
                      type="button"
                      onClick={() => void createCollabSession()}
                      className="flex h-10 w-full items-center gap-2.5 px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-secondary"
                    >
                      <Bot className="h-4 w-4 shrink-0 text-text-tertiary" />
                      <div className="font-medium">创建团队</div>
                    </button>

                    <div className="mx-3 h-px bg-border" />

                    <button
                      type="button"
                      onClick={() => openAdvisorCreate('manual')}
                      className="flex h-10 w-full items-center gap-2.5 px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-secondary"
                    >
                      <Users className="h-4 w-4 shrink-0 text-text-tertiary" />
                      <div className="font-medium">添加成员</div>
                    </button>

                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-3 py-3 space-y-4">
          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setActiveSection('team-workbench')}
              className="flex w-full items-center justify-between rounded-xl px-1 py-1 text-left text-xs font-medium tracking-[0.04em] text-text-tertiary transition-colors hover:text-text-primary"
            >
              <span>团队</span>
              <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
            </button>

            {collabSessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-xs text-text-tertiary">
                暂无团队
              </div>
            ) : (
              <div className="space-y-1.5">
                {collabSessions.map((session) => {
                  const isSelected = activeSection === 'team-workbench' && selectedCollabSessionId === session.id;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => {
                        setActiveSection('team-workbench');
                        setSelectedCollabSessionId(session.id);
                      }}
                      className={clsx(
                        'w-full rounded-2xl border px-3 py-3 text-left transition-all',
                        isSelected
                          ? 'border-accent-primary/30 bg-accent-primary/10 shadow-sm'
                          : 'border-transparent hover:border-border hover:bg-surface-primary/70',
                      )}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-primary text-accent-primary">
                          <Bot className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-text-primary">{session.title}</div>
                          <div className="truncate text-xs text-text-tertiary">{session.status}</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setIsAdvisorsSectionOpen((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-xl px-1 py-1 text-left text-xs font-medium tracking-[0.04em] text-text-tertiary transition-colors hover:text-text-primary"
            >
              <span>成员</span>
              <ChevronDown
                className={clsx('h-4 w-4 transition-transform', isAdvisorsSectionOpen ? 'rotate-0' : '-rotate-90')}
                strokeWidth={1.75}
              />
            </button>

            {isAdvisorsSectionOpen && (
              advisors.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-xs text-text-tertiary">
                  暂无成员
                </div>
              ) : (
                <div className="space-y-1.5">
                  {advisors.map((advisor) => {
                    const isSelected = activeSection === 'members' && selectedAdvisorId === advisor.id;
                    return (
                      <button
                        key={advisor.id}
                        type="button"
                        onClick={() => {
                          setActiveSection('members');
                          setSelectedAdvisorId(advisor.id);
                        }}
                        className={clsx(
                          'w-full rounded-2xl border px-3 py-3 text-left transition-all',
                          isSelected
                            ? 'border-accent-primary/30 bg-accent-primary/10 shadow-sm'
                            : 'border-transparent hover:border-border hover:bg-surface-primary/70',
                        )}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-primary border border-border text-base">
                            {hasRenderableAssetUrl(advisor.avatar)
                              ? <img src={resolveAssetUrl(advisor.avatar)} alt={advisor.name} className="h-full w-full object-cover" />
                              : advisor.avatar}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-text-primary">{advisor.name}</div>
                            <div className="truncate text-xs text-text-tertiary">{advisor.personality}</div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )
            )}
          </section>
        </div>
      </aside>

      <div className="flex-1 min-w-0 min-h-0">
        {mountedSections.includes('team-workbench') && (
          <div className={activeSection === 'team-workbench' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            {selectedCollabSession ? (
              <TeamWorkbench
                session={selectedCollabSession}
                isActive={isActive && activeSection === 'team-workbench'}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
                请选择或创建团队
              </div>
            )}
          </div>
        )}

        {mountedSections.includes('members') && (
          <div className={activeSection === 'members' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <Advisors
              isActive={isActive && activeSection === 'members'}
              hideAdvisorList
              selectedAdvisorId={selectedAdvisor?.id || null}
              onSelectedAdvisorIdChange={setSelectedAdvisorId}
              onAdvisorsChange={setAdvisors}
              createRequestKey={advisorCreateRequestKey}
              createRequestMode={advisorCreateMode}
            />
          </div>
        )}
      </div>

    </div>
  );
}
