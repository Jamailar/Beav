import { preflightGenerationMediaPayload } from '../../utils/mediaReferencePreflight';
import type { BridgeCore, Listener } from '../types';

function stringProperty(payload: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, 80);
    }
  }
  return fallback;
}

function numberProperty(payload: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return null;
}

function mediaReferenceCount(payload: Record<string, unknown>): number {
  const candidates = [
    payload.references,
    payload.referenceImages,
    payload.reference_images,
    payload.assets,
    payload.mediaAssets,
    payload.media_assets,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.length;
  }
  const singleReferenceKeys = ['referenceImage', 'reference_image', 'sourceImage', 'source_image', 'sourceVideo', 'source_video'];
  return singleReferenceKeys.some((key) => Boolean(payload[key])) ? 1 : 0;
}

function trackMediaGenerationRequested(
  core: BridgeCore,
  mediaKind: 'image' | 'video' | 'audio',
  payload: Record<string, unknown>,
) {
  const referenceCount = mediaReferenceCount(payload);
  const properties: Record<string, string | number | boolean> = {
    mediaKind,
    sourceSurface: stringProperty(payload, ['sourceSurface', 'surface', 'channel'], 'generation'),
    inputKind: referenceCount > 0 ? 'mixed' : 'text',
    hasReference: referenceCount > 0,
    referenceCount,
    hasInput: Boolean(stringProperty(payload, ['prompt', 'description', 'text'])),
  };
  const provider = stringProperty(payload, ['provider', 'providerId']);
  const model = stringProperty(payload, ['model', 'modelName']);
  const generationMode = stringProperty(payload, ['generationMode', 'mode']);
  const durationSeconds = numberProperty(payload, ['durationSeconds', 'duration', 'seconds']);
  if (provider) properties.provider = provider;
  if (model) properties.model = model;
  if (generationMode) properties.generationMode = generationMode;
  if (durationSeconds !== null) properties.durationSeconds = durationSeconds;

  void core.invokeChannelGuarded('analytics:track', {
    event: 'media_generation_requested',
    surface: 'media-generation',
    origin: 'renderer',
    properties,
  }, {
    fallback: { success: true, queued: false, skipped: 'unavailable' },
  });
}

export function createGenerationBridge(core: BridgeCore) {
  return {
    generation: {
      submitImage: async (payload: Record<string, unknown>) => {
        trackMediaGenerationRequested(core, 'image', payload);
        return core.invokeChannel('generation:submit-image', await preflightGenerationMediaPayload(payload));
      },
      submitVideo: async (payload: Record<string, unknown>) => {
        trackMediaGenerationRequested(core, 'video', payload);
        return core.invokeChannel('generation:submit-video', await preflightGenerationMediaPayload(payload));
      },
      submitAudio: (payload: Record<string, unknown>) => {
        trackMediaGenerationRequested(core, 'audio', payload);
        return core.invokeChannel('generation:submit-audio', payload);
      },
      submitVoiceClone: (payload: Record<string, unknown>) => core.invokeChannel('generation:submit-voice-clone', payload),
      prepareVideoRetalkSource: (payload: Record<string, unknown>) => core.invokeChannel('generation:prepare-video-retalk-source', payload),
      uploadTempFile: (payload: Record<string, unknown>) => core.invokeChannel('generation:upload-temp-file', payload),
      listJobSummaries: (payload?: Record<string, unknown>) => core.invokeChannel('generation:list-job-summaries', payload || {}),
      listJobs: (payload?: Record<string, unknown>) => core.invokeChannel('generation:list-jobs', payload || {}),
      getJob: (jobId: string) => core.invokeChannel('generation:get-job', { jobId }),
      getJobArtifacts: (jobId: string) => core.invokeChannel('generation:get-job-artifacts', { jobId }),
      awaitJob: (payload: { jobId: string; timeoutMs?: number }) => core.invokeChannel('generation:await-job', payload),
      cancelJob: (jobId: string) => core.invokeChannel('generation:cancel-job', { jobId }),
      deleteJob: (jobId: string) => core.invokeChannel('generation:delete-job', { jobId }),
      retryJob: (jobId: string) => core.invokeChannel('generation:retry-job', { jobId }),
      getRuntimeStatus: () => core.invokeChannel('generation:get-runtime-status'),
      onJobUpdated: (listener: Listener) => core.on('generation:job-updated', listener),
      offJobUpdated: (listener: Listener) => core.off('generation:job-updated', listener),
      onJobLog: (listener: Listener) => core.on('generation:job-log', listener),
      offJobLog: (listener: Listener) => core.off('generation:job-log', listener),
    },
  };
}
