import type { BridgeCore } from '../types';

type YoutubeNotePayload = {
  videoId: string;
  videoUrl: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
};

export function createCaptureBridge(core: BridgeCore) {
  return {
    capture: {
      saveYoutubeNote: (payload: YoutubeNotePayload) => core.invokeChannel('youtube:save-note', payload),
      createServerJob: (payload: Record<string, unknown>) => core.invokeChannel('capture:create-server-job', payload),
      getServerJob: (payload: { jobId: string }) => core.invokeChannel('capture:get-server-job', payload),
      listServerJobs: (payload?: { limit?: number }) => core.invokeChannel('capture:list-server-jobs', payload || {}),
    },
  };
}
