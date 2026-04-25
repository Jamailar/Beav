import { useCallback, useEffect, useState } from 'react';

import {
  type AudioCaptureCapability,
  type AudioRecordingClip,
  cancelHostAudioRecording,
  describeAudioCaptureFailure,
  getAudioCaptureCapability,
  startHostAudioRecording,
  stopHostAudioRecording,
} from './audioInput';

interface UseAudioRecordingOptions {
  onCaptured: (clip: AudioRecordingClip) => Promise<void> | void;
}

export function useAudioRecording({ onCaptured }: UseAudioRecordingOptions) {
  const [capability, setCapability] = useState<AudioCaptureCapability | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState('');

  const refreshCapability = useCallback(async () => {
    const next = await getAudioCaptureCapability();
    setCapability(next);
    return next;
  }, []);

  useEffect(() => {
    void refreshCapability();
  }, [refreshCapability]);

  useEffect(() => () => {
    if (!isRecording) return;
    void cancelHostAudioRecording().catch(() => undefined);
  }, [isRecording]);

  const startRecording = useCallback(async () => {
    if (isRecording || isWorking) return false;
    setIsWorking(true);
    setError('');
    try {
      await startHostAudioRecording();
      setIsRecording(true);
      await refreshCapability();
      return true;
    } catch (captureError) {
      const nextCapability = await refreshCapability().catch(() => capability);
      setError(describeAudioCaptureFailure(captureError, nextCapability));
      setIsRecording(false);
      return false;
    } finally {
      setIsWorking(false);
    }
  }, [capability, isRecording, isWorking, refreshCapability]);

  const stopRecording = useCallback(async () => {
    if (!isRecording || isWorking) return null;
    setIsWorking(true);
    try {
      const clip = await stopHostAudioRecording();
      setIsRecording(false);
      setError('');
      await refreshCapability();
      await onCaptured(clip);
      return clip;
    } catch (captureError) {
      setError(describeAudioCaptureFailure(captureError, capability));
      setIsRecording(false);
      await refreshCapability().catch(() => undefined);
      return null;
    } finally {
      setIsWorking(false);
    }
  }, [capability, isRecording, isWorking, onCaptured, refreshCapability]);

  const cancelRecording = useCallback(async () => {
    if (!isRecording && !isWorking) return false;
    setIsWorking(true);
    try {
      await cancelHostAudioRecording();
      setIsRecording(false);
      await refreshCapability();
      return true;
    } catch (captureError) {
      setError(describeAudioCaptureFailure(captureError, capability));
      setIsRecording(false);
      await refreshCapability().catch(() => undefined);
      return false;
    } finally {
      setIsWorking(false);
    }
  }, [capability, isRecording, isWorking, refreshCapability]);

  return {
    capability,
    isRecording,
    isWorking,
    error,
    setError,
    refreshCapability,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
