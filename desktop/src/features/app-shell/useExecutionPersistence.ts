import { useCallback } from 'react';
import type { ViewType } from './types';

export function useExecutionPersistence(setViewPersistent: (view: ViewType, persistent: boolean) => void) {
  const handleWanderExecutionStateChange = useCallback((active: boolean) => {
    setViewPersistent('wander', active);
  }, [setViewPersistent]);

  const handleRedClawExecutionStateChange = useCallback((active: boolean) => {
    setViewPersistent('redclaw', active);
  }, [setViewPersistent]);

  const handleGenerationStudioExecutionStateChange = useCallback((active: boolean) => {
    setViewPersistent('generation-studio', active);
  }, [setViewPersistent]);

  const handleCoverStudioExecutionStateChange = useCallback((active: boolean) => {
    setViewPersistent('cover-studio', active);
  }, [setViewPersistent]);

  return {
    handleWanderExecutionStateChange,
    handleRedClawExecutionStateChange,
    handleGenerationStudioExecutionStateChange,
    handleCoverStudioExecutionStateChange,
  };
}
