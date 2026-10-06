import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { appAlert, appConfirm } from '../../utils/appDialogs';
import { uiMeasure } from '../../utils/uiDebug';

export interface WorkspaceSpace {
  id: string;
  name: string;
}

type SpaceDialogMode = 'create' | 'rename';

type UseLayoutSpacesOptions = {
  canCreateSpace?: boolean;
  openMembershipModal?: () => void;
};

export function useLayoutSpaces(sidebarVisualCollapsed: boolean, options: UseLayoutSpacesOptions = {}) {
  const { t } = useI18n();
  const { canCreateSpace = false, openMembershipModal } = options;
  const [spaces, setSpaces] = useState<WorkspaceSpace[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string>('');
  const [isSwitchingSpace, setIsSwitchingSpace] = useState(false);
  const [isSpaceMenuOpen, setIsSpaceMenuOpen] = useState(false);
  const [hoveredSpaceId, setHoveredSpaceId] = useState<string | null>(null);
  const [isSpaceDialogOpen, setIsSpaceDialogOpen] = useState(false);
  const [spaceDialogMode, setSpaceDialogMode] = useState<SpaceDialogMode>('rename');
  const [spaceDialogName, setSpaceDialogName] = useState('');
  const [spaceDialogTargetId, setSpaceDialogTargetId] = useState<string | null>(null);
  const [isSpaceDialogSubmitting, setIsSpaceDialogSubmitting] = useState(false);
  const [deletingSpaceId, setDeletingSpaceId] = useState<string | null>(null);
  const spaceMenuRef = useRef<HTMLDivElement | null>(null);
  const activeSpaceName = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId)?.name || t('layout.defaultSpaceName'),
    [activeSpaceId, spaces, t],
  );

  const loadSpaces = useCallback(async () => {
    try {
      const result = await uiMeasure('layout', 'load_spaces', async () => (
        window.ipcRenderer.spaces.list() as Promise<{ spaces?: WorkspaceSpace[]; activeSpaceId?: string } | null>
      )) as { spaces?: WorkspaceSpace[]; activeSpaceId?: string } | null;
      if (Array.isArray(result?.spaces)) {
        setSpaces(result.spaces);
      }
      if (typeof result?.activeSpaceId === 'string' && result.activeSpaceId.trim()) {
        setActiveSpaceId(result.activeSpaceId);
      }
    } catch (error) {
      console.error('Failed to load spaces:', error);
    }
  }, []);

  useEffect(() => {
    void loadSpaces();

    const handleSpaceChanged = () => {
      void loadSpaces();
    };
    window.ipcRenderer.spaces.onChanged(handleSpaceChanged);
    return () => {
      window.ipcRenderer.spaces.offChanged(handleSpaceChanged);
    };
  }, [loadSpaces]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!spaceMenuRef.current) return;
      if (!spaceMenuRef.current.contains(event.target as Node)) {
        setIsSpaceMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!isSpaceMenuOpen) {
      setHoveredSpaceId(null);
    }
  }, [isSpaceMenuOpen]);

  useEffect(() => {
    if (sidebarVisualCollapsed) {
      setIsSpaceMenuOpen(false);
    }
  }, [sidebarVisualCollapsed]);

  const closeSpaceMenu = useCallback(() => {
    setIsSpaceMenuOpen(false);
  }, []);

  const handleSwitchSpace = useCallback(async (nextSpaceId: string) => {
    if (!nextSpaceId) return;
    setIsSwitchingSpace(true);
    try {
      const result = await window.ipcRenderer.spaces.switch(nextSpaceId) as { success?: boolean; activeSpaceId?: string; error?: string } | null;
      if (!result?.success) {
        void appAlert(result?.error || t('layout.switchSpaceFailed'));
        return;
      }
      setActiveSpaceId(result.activeSpaceId || nextSpaceId);
      setIsSpaceMenuOpen(false);
      window.location.reload();
    } catch (error) {
      console.error('Failed to switch space:', error);
      void appAlert(t('layout.switchSpaceFailedRetry'));
    } finally {
      setIsSwitchingSpace(false);
    }
  }, [t]);

  const openRenameSpaceDialog = useCallback((space: WorkspaceSpace) => {
    setIsSpaceMenuOpen(false);
    setSpaceDialogMode('rename');
    setSpaceDialogTargetId(space.id);
    setSpaceDialogName(space.name);
    setIsSpaceDialogOpen(true);
  }, []);

  const openCreateSpaceDialog = useCallback(() => {
    setIsSpaceMenuOpen(false);
    if (!canCreateSpace) {
      openMembershipModal?.();
      return;
    }
    setSpaceDialogMode('create');
    setSpaceDialogTargetId(null);
    setSpaceDialogName('');
    setIsSpaceDialogOpen(true);
  }, [canCreateSpace, openMembershipModal]);

  const handleDeleteSpace = useCallback(async (space: WorkspaceSpace) => {
    if (!space.id || space.id === 'default' || deletingSpaceId) return;
    const confirmed = await appConfirm(t('layout.deleteSpaceConfirm', { name: space.name || space.id }), {
      title: t('layout.deleteSpace'),
      confirmLabel: t('layout.deleteSpace'),
      tone: 'danger',
    });
    if (!confirmed) return;

    setDeletingSpaceId(space.id);
    try {
      const result = await window.ipcRenderer.spaces.delete(space.id) as {
        success?: boolean;
        activeSpaceId?: string;
        deletedActiveSpace?: boolean;
        error?: string;
      } | null;
      if (!result?.success) {
        void appAlert(result?.error || t('layout.deleteSpaceFailed'));
        return;
      }
      setIsSpaceMenuOpen(false);
      await loadSpaces();
      if (result.deletedActiveSpace) {
        window.location.reload();
      }
    } catch (error) {
      console.error('Failed to delete space:', error);
      void appAlert(t('layout.deleteSpaceFailedRetry'));
    } finally {
      setDeletingSpaceId(null);
    }
  }, [deletingSpaceId, loadSpaces, t]);

  const closeSpaceDialog = useCallback(() => {
    if (isSpaceDialogSubmitting) return;
    setIsSpaceDialogOpen(false);
    setSpaceDialogMode('rename');
    setSpaceDialogName('');
    setSpaceDialogTargetId(null);
  }, [isSpaceDialogSubmitting]);

  const submitSpaceDialog = useCallback(async () => {
    const trimmedName = spaceDialogName.trim();
    if (!trimmedName) {
      void appAlert(t('layout.spaceNameRequired'));
      return;
    }

    setIsSpaceDialogSubmitting(true);
    try {
      if (!spaceDialogTargetId) {
        if (spaceDialogMode !== 'create') {
          void appAlert(t('layout.renameSpaceMissing'));
          return;
        }

        const result = await window.ipcRenderer.spaces.create({ name: trimmedName }) as {
          success?: boolean;
          activeSpaceId?: string;
          error?: string;
        } | null;
        if (!result?.success) {
          void appAlert(result?.error || t('layout.createSpaceFailed'));
          return;
        }

        setIsSpaceDialogOpen(false);
        setSpaceDialogMode('rename');
        setSpaceDialogName('');
        await loadSpaces();
        window.location.reload();
        return;
      }

      const result = await window.ipcRenderer.spaces.rename({ id: spaceDialogTargetId, name: trimmedName }) as { success?: boolean; error?: string } | null;
      if (!result?.success) {
        void appAlert(result?.error || t('layout.renameSpaceFailed'));
        return;
      }

      setIsSpaceDialogOpen(false);
      setSpaceDialogMode('rename');
      setSpaceDialogName('');
      setSpaceDialogTargetId(null);
      await loadSpaces();
    } catch (error) {
      console.error('Failed to submit space dialog:', error);
      void appAlert(spaceDialogMode === 'create' ? t('layout.createSpaceFailedRetry') : t('layout.renameSpaceFailedRetry'));
    } finally {
      setIsSpaceDialogSubmitting(false);
    }
  }, [loadSpaces, spaceDialogMode, spaceDialogName, spaceDialogTargetId, t]);

  return {
    spaces,
    activeSpaceId,
    activeSpaceName,
    isSwitchingSpace,
    isSpaceMenuOpen,
    setIsSpaceMenuOpen,
    hoveredSpaceId,
    setHoveredSpaceId,
    isSpaceDialogOpen,
    spaceDialogMode,
    spaceDialogName,
    setSpaceDialogName,
    isSpaceDialogSubmitting,
    deletingSpaceId,
    spaceMenuRef,
    closeSpaceMenu,
    handleSwitchSpace,
    openCreateSpaceDialog,
    openRenameSpaceDialog,
    handleDeleteSpace,
    closeSpaceDialog,
    submitSpaceDialog,
  };
}
