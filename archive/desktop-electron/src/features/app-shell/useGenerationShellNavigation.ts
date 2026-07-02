import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { uiTraceInteraction } from '../../utils/uiDebug';
import type { GenerationIntent, ViewType } from './types';

type UseGenerationShellNavigationParams = {
  setCurrentView: Dispatch<SetStateAction<ViewType>>;
};

export function useGenerationShellNavigation({
  setCurrentView,
}: UseGenerationShellNavigationParams) {
  const [pendingGenerationIntent, setPendingGenerationIntent] = useState<GenerationIntent | null>(null);

  const navigateToGenerationStudio = useCallback((intent: GenerationIntent) => {
    if (intent.mode === 'cover') {
      uiTraceInteraction('app', 'nav_to_cover_studio', {
        to: 'cover-studio',
        mode: intent.mode,
        source: intent.source,
      });
      setPendingGenerationIntent(null);
      setCurrentView('cover-studio');
      return;
    }

    uiTraceInteraction('app', 'nav_to_generation_studio', {
      to: 'generation-studio',
      mode: intent.mode,
      source: intent.source,
    });
    setPendingGenerationIntent(intent);
    setCurrentView('generation-studio');
  }, [setCurrentView]);

  const clearPendingGenerationIntent = useCallback(() => {
    setPendingGenerationIntent(null);
  }, []);

  const openCoverStudio = useCallback(() => {
    setCurrentView('cover-studio');
  }, [setCurrentView]);

  const returnToFreeCreation = useCallback(() => {
    setCurrentView('generation-studio');
  }, [setCurrentView]);

  return {
    pendingGenerationIntent,
    setPendingGenerationIntent,
    navigateToGenerationStudio,
    clearPendingGenerationIntent,
    openCoverStudio,
    returnToFreeCreation,
  };
}
