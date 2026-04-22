import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, MessageSquarePlus, Plus, Users } from 'lucide-react';
import { clsx } from 'clsx';
import { CreativeChat, type CreativeChatRoom } from './CreativeChat';
import { Advisors, type AdvisorCreateMode, type AdvisorProfile } from './Advisors';
import type { TeamSection } from '../App';
import { hasRenderableAssetUrl, resolveAssetUrl } from '../utils/pathManager';

interface TeamProps {
  isActive?: boolean;
  onExecutionStateChange?: (active: boolean) => void;
}

const TEAM_SECTION_STORAGE_KEY = 'redbox:team-section:v1';

function readInitialTeamSection(): TeamSection {
  if (typeof window === 'undefined') return 'group-chat';
  const saved = String(window.localStorage.getItem(TEAM_SECTION_STORAGE_KEY) || '').trim();
  return saved === 'members' ? 'members' : 'group-chat';
}

function getRoomAvatarMembers(room: CreativeChatRoom, advisors: AdvisorProfile[]): AdvisorProfile[] {
  const advisorIds = Array.isArray(room.advisorIds) ? room.advisorIds : [];
  const normalizedIds = advisorIds.map((id) => String(id || '').trim()).filter(Boolean);
  return advisors.filter((advisor) => normalizedIds.includes(advisor.id)).slice(0, 9);
}

function getRoomAvatarGridSpec(count: number): { columns: number; rows: number } {
  if (count <= 1) {
    return { columns: 1, rows: 1 };
  }
  if (count <= 4) {
    return { columns: 2, rows: Math.ceil(count / 2) };
  }
  return { columns: 3, rows: Math.ceil(count / 3) };
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
  const [rooms, setRooms] = useState<CreativeChatRoom[]>([]);
  const [advisors, setAdvisors] = useState<AdvisorProfile[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedAdvisorId, setSelectedAdvisorId] = useState<string | null>(null);
  const [roomCreateRequestKey, setRoomCreateRequestKey] = useState(0);
  const [advisorCreateRequestKey, setAdvisorCreateRequestKey] = useState(0);
  const [advisorCreateMode, setAdvisorCreateMode] = useState<AdvisorCreateMode>('manual');
  const [isCreativeChatExecuting, setIsCreativeChatExecuting] = useState(false);
  const [isCreatePickerOpen, setIsCreatePickerOpen] = useState(false);
  const [isRoomsSectionOpen, setIsRoomsSectionOpen] = useState(true);
  const [isAdvisorsSectionOpen, setIsAdvisorsSectionOpen] = useState(true);
  const createMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

        const loadSidebarData = async () => {
      try {
        const [roomList, advisorList] = await Promise.all([
          window.ipcRenderer.invoke('chatrooms:list') as Promise<CreativeChatRoom[]>,
          window.ipcRenderer.advisors.list<AdvisorProfile>(),
        ]);
        if (cancelled) return;
        setRooms(Array.isArray(roomList) ? roomList : []);
        setAdvisors(Array.isArray(advisorList) ? advisorList : []);
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
    window.localStorage.setItem(TEAM_SECTION_STORAGE_KEY, activeSection);
    setMountedSections((prev) => (
      prev.includes(activeSection) ? prev : [...prev, activeSection]
    ));
  }, [activeSection]);

  useEffect(() => {
    onExecutionStateChange?.(isCreativeChatExecuting);
  }, [isCreativeChatExecuting, onExecutionStateChange]);

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
    if (rooms.length === 0) {
      setSelectedRoomId(null);
      return;
    }
    if (!selectedRoomId || !rooms.some((room) => room.id === selectedRoomId)) {
      setSelectedRoomId(rooms[0].id);
    }
  }, [rooms, selectedRoomId]);

  useEffect(() => {
    if (advisors.length === 0) {
      setSelectedAdvisorId(null);
      return;
    }
    if (!selectedAdvisorId || !advisors.some((advisor) => advisor.id === selectedAdvisorId)) {
      setSelectedAdvisorId(advisors[0].id);
    }
  }, [advisors, selectedAdvisorId]);

  const selectedRoom = useMemo(
    () => rooms.find((room) => room.id === selectedRoomId) || null,
    [rooms, selectedRoomId],
  );
  const selectedAdvisor = useMemo(
    () => advisors.find((advisor) => advisor.id === selectedAdvisorId) || null,
    [advisors, selectedAdvisorId],
  );
  const shouldKeepChatActive = isCreativeChatExecuting;

  const openRoomCreate = () => {
    setActiveSection('group-chat');
    setRoomCreateRequestKey((value) => value + 1);
    setIsCreatePickerOpen(false);
  };

  const openAdvisorCreate = (mode: AdvisorCreateMode = 'manual') => {
    setActiveSection('members');
    setAdvisorCreateMode(mode);
    setAdvisorCreateRequestKey((value) => value + 1);
    setIsCreatePickerOpen(false);
  };

  return (
    <div className="flex h-full min-h-0 bg-background">
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
                      onClick={openRoomCreate}
                      className="flex h-10 w-full items-center gap-2.5 px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-secondary"
                    >
                      <MessageSquarePlus className="h-4 w-4 shrink-0 text-text-tertiary" />
                      <div className="font-medium">创建群聊</div>
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
              onClick={() => setIsRoomsSectionOpen((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-xl px-1 py-1 text-left text-xs font-medium tracking-[0.04em] text-text-tertiary transition-colors hover:text-text-primary"
            >
              <span>群聊</span>
              <ChevronDown
                className={clsx('h-4 w-4 transition-transform', isRoomsSectionOpen ? 'rotate-0' : '-rotate-90')}
                strokeWidth={1.75}
              />
            </button>

            {isRoomsSectionOpen && (
              rooms.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-xs text-text-tertiary">
                  暂无群聊
                </div>
              ) : (
                <div className="space-y-1.5">
                  {rooms.map((room) => {
                    const isSelected = activeSection === 'group-chat' && selectedRoomId === room.id;
                    const memberCount = Array.isArray(room.advisorIds) ? room.advisorIds.length : 0;
                    const roomAvatarMembers = getRoomAvatarMembers(room, advisors);
                    const avatarGridSpec = getRoomAvatarGridSpec(roomAvatarMembers.length);
                    return (
                      <button
                        key={room.id}
                        type="button"
                        onClick={() => {
                          setActiveSection('group-chat');
                          setSelectedRoomId(room.id);
                        }}
                        className={clsx(
                          'w-full rounded-2xl border px-3 py-3 text-left transition-all',
                          isSelected
                            ? 'border-accent-primary/30 bg-accent-primary/10 shadow-sm'
                            : 'border-transparent hover:border-border hover:bg-surface-primary/70',
                        )}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-surface-primary p-1">
                            {roomAvatarMembers.length > 0 ? (
                              <div
                                className="grid h-full w-full gap-[1.5px] overflow-hidden rounded-xl"
                                style={{
                                  gridTemplateColumns: `repeat(${avatarGridSpec.columns}, minmax(0, 1fr))`,
                                  gridTemplateRows: `repeat(${avatarGridSpec.rows}, minmax(0, 1fr))`,
                                }}
                              >
                                {roomAvatarMembers.map((advisor) => (
                                  <div
                                    key={`${room.id}:${advisor.id}`}
                                    className="flex items-center justify-center overflow-hidden rounded-[4px] bg-surface-secondary p-[1px] text-text-primary"
                                  >
                                    {renderAdvisorAvatarPreview(advisor, roomAvatarMembers.length >= 7)}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="flex h-full w-full items-center justify-center rounded-xl bg-surface-secondary text-text-tertiary">
                                <Users className="h-4 w-4" />
                              </div>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              {room.isSystem && (
                                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                                  🎩
                                </span>
                              )}
                              <span className="truncate text-sm font-medium text-text-primary">{room.name}</span>
                            </div>
                            <div className="mt-1 text-xs text-text-tertiary">
                              {room.isSystem ? '系统群聊' : `${memberCount} 位成员`}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )
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
        {mountedSections.includes('group-chat') && (
          <div className={activeSection === 'group-chat' ? 'h-full min-h-0 flex flex-col' : 'hidden'}>
            <CreativeChat
              isActive={(isActive && activeSection === 'group-chat') || shouldKeepChatActive}
              onExecutionStateChange={setIsCreativeChatExecuting}
              hideRoomList
              selectedRoomId={selectedRoom?.id || null}
              onSelectedRoomIdChange={setSelectedRoomId}
              onRoomsChange={setRooms}
              createRequestKey={roomCreateRequestKey}
            />
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
