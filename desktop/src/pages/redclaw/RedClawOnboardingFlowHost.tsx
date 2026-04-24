import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RedClawOnboardingFlow } from './RedClawOnboardingFlow';
import { readRedClawOnboardingDraft } from './onboardingState';
import type { RedClawOnboardingAnswers } from './onboardingMvp';

interface RedClawOnboardingFlowHostProps {
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
}

export function RedClawOnboardingFlowHost({
  open,
  onClose,
  onCompleted,
}: RedClawOnboardingFlowHostProps) {
  const [activeSpaceName, setActiveSpaceName] = useState('当前空间');
  const [onboardingState, setOnboardingState] = useState<Record<string, unknown> | null>(null);

  const loadBundle = useCallback(async () => {
    const [bundle, spacesPayload] = await Promise.all([
      window.ipcRenderer.redclawProfile.getBundle(),
      window.ipcRenderer.spaces.list(),
    ]);
    const activeSpaceId = String(
      bundle?.activeSpaceId
      || spacesPayload?.activeSpaceId
      || 'default'
    ).trim() || 'default';
    const spaces = Array.isArray(spacesPayload?.spaces) ? spacesPayload.spaces : [];
    const activeSpace = spaces.find((space) => String(space?.id || '').trim() === activeSpaceId);
    setActiveSpaceName(String(activeSpace?.name || activeSpaceId || '当前空间').trim() || '当前空间');
    setOnboardingState(
      bundle?.onboardingState && typeof bundle.onboardingState === 'object'
        ? bundle.onboardingState as Record<string, unknown>
        : null
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadBundle();
  }, [loadBundle, open]);

  useEffect(() => {
    if (!open) return;
    const handleSpaceChanged = () => {
      void loadBundle();
    };
    window.ipcRenderer.on('space:changed', handleSpaceChanged);
    return () => {
      window.ipcRenderer.off('space:changed', handleSpaceChanged);
    };
  }, [loadBundle, open]);

  const saveOnboardingProgress = useCallback(async (payload: {
    stepIndex: number;
    answers: RedClawOnboardingAnswers;
  }) => {
    const result = await window.ipcRenderer.redclawProfile.saveInitializationProgress({
      stepIndex: payload.stepIndex,
      answers: { ...payload.answers },
    });
    if (result?.state && typeof result.state === 'object') {
      setOnboardingState(result.state);
    }
  }, []);

  const completeOnboarding = useCallback(async (answers: RedClawOnboardingAnswers) => {
    const result = await window.ipcRenderer.redclawProfile.completeInitialization({
      answers: { ...answers },
    });
    if (!result?.success) {
      throw new Error('初始化保存失败');
    }
    setOnboardingState(
      result.onboardingState && typeof result.onboardingState === 'object'
        ? result.onboardingState as Record<string, unknown>
        : null
    );
    toast.success('已完成这个空间的风格定义');
    onCompleted();
  }, [onCompleted]);

  const onboardingDraft = readRedClawOnboardingDraft(onboardingState);

  return (
    <RedClawOnboardingFlow
      open={open}
      activeSpaceName={activeSpaceName}
      initialStepIndex={onboardingDraft.stepIndex}
      initialAnswers={{ ...onboardingDraft.answers }}
      onClose={onClose}
      onSaveProgress={saveOnboardingProgress}
      onComplete={completeOnboarding}
    />
  );
}
