import type { BridgeCore } from '../types';

export function createAudioVoiceBridge(core: BridgeCore) {
  return {
    voice: {
      list: (payload?: Record<string, unknown>) => core.invokeChannel('voice:list', payload || {}),
      get: (payload: { voiceId: string }) => core.invokeChannel('voice:get', payload),
      clone: (payload: Record<string, unknown>) => core.invokeChannel('voice:clone', payload),
      bindAsset: (payload: Record<string, unknown>) => core.invokeChannel('voice:bind-asset', payload),
      speech: (payload: Record<string, unknown>) => core.invokeChannel('voice:speech', payload),
      delete: (payload: { voiceId: string }) => core.invokeChannel('voice:delete', payload),
    },
    audio: {
      getCaptureCapability: () => core.invokeChannel('audio:get-capture-capability'),
      startRecording: () => core.invokeChannel('audio:start-recording'),
      stopRecording: () => core.invokeChannel('audio:stop-recording'),
      cancelRecording: () => core.invokeChannel('audio:cancel-recording'),
      openMicrophoneSettings: () => core.invokeChannel('audio:open-microphone-settings'),
    },
  };
}
