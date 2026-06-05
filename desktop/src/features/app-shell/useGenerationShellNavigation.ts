import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { uiTraceInteraction } from '../../utils/uiDebug';
import type { GenerationIntent, ViewType } from './types';

interface UseGenerationShellNavigationParams {
  setCurrentView: Dispatch<SetStateAction<ViewType>>;
}

export function useGenerationShellNavigation({
  setCurrentView,
}: UseGenerationShellNavigationParams) {
  const [pendingGenerationIntent, setPendingGenerationIntent] = useState<GenerationIntent | null>(null);

  const navigateToGenerationStudio = useCallback((intent: GenerationIntent) => {
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

  const returnToFreeCreation = useCallback(() => {
    setCurrentView('generation-studio');
  }, [setCurrentView]);

  return {
    pendingGenerationIntent,
    setPendingGenerationIntent,
    navigateToGenerationStudio,
    clearPendingGenerationIntent,
    returnToFreeCreation,
  };
}
