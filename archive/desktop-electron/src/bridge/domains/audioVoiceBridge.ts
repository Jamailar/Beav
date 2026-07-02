import type { BridgeCore } from '../types';

const voiceUnavailable = {
  success: false,
  status: 'unavailable',
  error: 'Voice generation is unavailable in the Electron archive',
};

export function createAudioVoiceBridge(core: BridgeCore) {
  return {
    voice: {
      list: (payload?: Record<string, unknown>) => core.invokeChannelGuarded(
        'voice:list',
        payload || {},
        { fallback: { success: true, voices: [], items: [] } },
      ),
      get: (payload: { voiceId: string }) => core.invokeChannelGuarded(
        'voice:get',
        payload,
        { fallback: { ...voiceUnavailable, voice: null } },
      ),
      clone: (payload: Record<string, unknown>) => core.invokeChannelGuarded(
        'voice:clone',
        payload,
        { fallback: voiceUnavailable },
      ),
      bindAsset: (payload: Record<string, unknown>) => core.invokeChannelGuarded(
        'voice:bind-asset',
        payload,
        { fallback: voiceUnavailable },
      ),
      speech: (payload: Record<string, unknown>) => core.invokeChannelGuarded(
        'voice:speech',
        payload,
        { fallback: voiceUnavailable },
      ),
      delete: (payload: { voiceId: string }) => core.invokeChannelGuarded(
        'voice:delete',
        payload,
        { fallback: voiceUnavailable },
      ),
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
