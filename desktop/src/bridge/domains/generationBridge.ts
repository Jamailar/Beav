import { preflightGenerationMediaPayload } from '../../utils/mediaReferencePreflight';
import type { BridgeCore, Listener } from '../types';

export function createGenerationBridge(core: BridgeCore) {
  return {
    generation: {
      submitImage: async (payload: Record<string, unknown>) =>
        core.invokeChannel('generation:submit-image', await preflightGenerationMediaPayload(payload)),
      submitVideo: async (payload: Record<string, unknown>) =>
        core.invokeChannel('generation:submit-video', await preflightGenerationMediaPayload(payload)),
      submitAudio: (payload: Record<string, unknown>) => core.invokeChannel('generation:submit-audio', payload),
      submitVoiceClone: (payload: Record<string, unknown>) => core.invokeChannel('generation:submit-voice-clone', payload),
      prepareVideoRetalkSource: (payload: Record<string, unknown>) => core.invokeChannel('generation:prepare-video-retalk-source', payload),
      uploadTempFile: (payload: Record<string, unknown>) => core.invokeChannel('generation:upload-temp-file', payload),
      listJobSummaries: (payload?: Record<string, unknown>) => core.invokeChannel('generation:list-job-summaries', payload || {}),
      listJobs: (payload?: Record<string, unknown>) => core.invokeChannel('generation:list-jobs', payload || {}),
      getJob: (jobId: string) => core.invokeChannel('generation:get-job', { jobId }),
      getJobArtifacts: (jobId: string) => core.invokeChannel('generation:get-job-artifacts', { jobId }),
      awaitJob: (payload: { jobId: string; timeoutMs?: number }) => core.invokeChannel('generation:await-job', payload),
      cancelJob: (jobId: string) => core.invokeChannel('generation:cancel-job', { jobId }),
      retryJob: (jobId: string) => core.invokeChannel('generation:retry-job', { jobId }),
      getRuntimeStatus: () => core.invokeChannel('generation:get-runtime-status'),
      onJobUpdated: (listener: Listener) => core.on('generation:job-updated', listener),
      offJobUpdated: (listener: Listener) => core.off('generation:job-updated', listener),
      onJobLog: (listener: Listener) => core.on('generation:job-log', listener),
      offJobLog: (listener: Listener) => core.off('generation:job-log', listener),
    },
  };
}
