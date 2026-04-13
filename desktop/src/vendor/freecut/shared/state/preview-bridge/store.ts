import { create } from 'zustand';
import type { PreviewBridgeActions, PreviewBridgeState } from './types';

function normalizeFrame(frame: number | null): number | null {
  if (frame == null) return null;
  if (!Number.isFinite(frame)) {
    if (import.meta.env.DEV) {
      console.warn('[PreviewBridge] normalizeFrame received non-finite value:', frame);
    }
    return 0;
  }
  return Math.max(0, Math.round(frame));
}

export const usePreviewBridgeStore = create<PreviewBridgeState & PreviewBridgeActions>()((set) => ({
  displayedFrame: null,
  captureFrame: null,
  captureFrameImageData: null,
  captureCanvasSource: null,

  setDisplayedFrame: (frame) =>
    set((state) => {
      const nextFrame = normalizeFrame(frame);
      if (state.displayedFrame === nextFrame) return state;
      return { displayedFrame: nextFrame };
    }),
  setCaptureFrame: (fn) => set({ captureFrame: fn }),
  setCaptureFrameImageData: (fn) => set({ captureFrameImageData: fn }),
  setCaptureCanvasSource: (fn) => set({ captureCanvasSource: fn }),
}));
