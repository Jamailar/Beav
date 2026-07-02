import type { BridgeCore } from '../types';

export function createVideoEditorBridge(core: BridgeCore) {
  return {
    videoEditorV2: {
      getOrCreateForManuscript: (payload: { manuscriptPath: string; title?: string }) =>
        core.invokeChannel('videoEditorV2:get-or-create-for-manuscript', payload),
      createProject: (payload?: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:create-project', payload || {}),
      getProject: (payload: { projectId: string }) => core.invokeChannel('videoEditorV2:get-project', payload),
      importAssets: (payload: { projectId: string; sourcePaths?: string[] }) =>
        core.invokeChannel('videoEditorV2:import-assets', payload),
      importSrt: (payload: { projectId: string; assetId?: string; srtPath?: string; srtContent?: string; language?: string }) =>
        core.invokeChannel('videoEditorV2:import-srt', payload),
      runAsr: (payload: { projectId: string; assetId: string; language?: string }) =>
        core.invokeChannel('videoEditorV2:run-asr', payload),
      updateSrtSegment: (payload: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:update-srt-segment', payload),
      mergeSrtSegments: (payload: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:merge-srt-segments', payload),
      splitSrtSegment: (payload: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:split-srt-segment', payload),
      setTimelineClipDisabled: (payload: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:set-timeline-clip-disabled', payload),
      trimTimelineClip: (payload: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:trim-timeline-clip', payload),
      splitTimelineClip: (payload: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:split-timeline-clip', payload),
      reorderTimelineClip: (payload: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:reorder-timeline-clip', payload),
      undoTimeline: (payload: Record<string, unknown>) => core.invokeChannel('videoEditorV2:undo-timeline', payload),
      generateAutoEdit: (payload: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:generate-auto-edit', payload),
      applyAutoEdit: (payload: Record<string, unknown>) =>
        core.invokeChannel('videoEditorV2:apply-auto-edit', payload),
      render: (payload: Record<string, unknown>) => core.invokeChannel('videoEditorV2:render', payload),
    },
  };
}
