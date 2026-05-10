import { useCallback, useEffect, useRef, useState } from 'react';

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
  const capabilityRef = useRef<AudioCaptureCapability | null>(null);
  const isRecordingRef = useRef(false);
  const isWorkingRef = useRef(false);
  const onCapturedRef = useRef(onCaptured);

  useEffect(() => {
    onCapturedRef.current = onCaptured;
  }, [onCaptured]);

  const setRecordingActive = useCallback((next: boolean) => {
    isRecordingRef.current = next;
    setIsRecording(next);
  }, []);

  const setWorkingActive = useCallback((next: boolean) => {
    isWorkingRef.current = next;
    setIsWorking(next);
  }, []);

  const refreshCapability = useCallback(async () => {
    const next = await getAudioCaptureCapability();
    capabilityRef.current = next;
    setCapability(next);
    if (!next?.activeRecording && isRecordingRef.current) {
      setRecordingActive(false);
    }
    return next;
  }, [setRecordingActive]);

  useEffect(() => {
    void refreshCapability();
  }, [refreshCapability]);

  useEffect(() => () => {
    if (!isRecordingRef.current && !isWorkingRef.current) return;
    void cancelHostAudioRecording().catch(() => undefined);
  }, []);

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current || isWorkingRef.current) return false;
    setWorkingActive(true);
    setError('');
    try {
      await startHostAudioRecording();
      setRecordingActive(true);
      await refreshCapability();
      return true;
    } catch (captureError) {
      const nextCapability = await refreshCapability().catch(() => capabilityRef.current);
      setError(describeAudioCaptureFailure(captureError, nextCapability));
      setRecordingActive(false);
      return false;
    } finally {
      setWorkingActive(false);
    }
  }, [refreshCapability, setRecordingActive, setWorkingActive]);

  const stopRecording = useCallback(async () => {
    if (!isRecordingRef.current || isWorkingRef.current) return null;
    setWorkingActive(true);
    try {
      const clip = await stopHostAudioRecording();
      setRecordingActive(false);
      setError('');
      await refreshCapability();
      await onCapturedRef.current(clip);
      return clip;
    } catch (captureError) {
      setError(describeAudioCaptureFailure(captureError, capabilityRef.current));
      setRecordingActive(false);
      await refreshCapability().catch(() => undefined);
      return null;
    } finally {
      setWorkingActive(false);
    }
  }, [refreshCapability, setRecordingActive, setWorkingActive]);

  const cancelRecording = useCallback(async () => {
    if (!isRecordingRef.current && !isWorkingRef.current) return false;
    setWorkingActive(true);
    try {
      await cancelHostAudioRecording();
      setRecordingActive(false);
      await refreshCapability();
      return true;
    } catch (captureError) {
      const message = describeAudioCaptureFailure(captureError, capabilityRef.current);
      if (message !== '当前没有进行中的录音') {
        setError(message);
      }
      setRecordingActive(false);
      await refreshCapability().catch(() => undefined);
      return false;
    } finally {
      setWorkingActive(false);
    }
  }, [refreshCapability, setRecordingActive, setWorkingActive]);

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
