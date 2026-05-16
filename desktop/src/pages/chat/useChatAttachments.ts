import { getCurrentWindow, type DragDropEvent } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { ChatComposerHandle, UploadedFileAttachment } from '../../components/ChatComposer';
import { clearAttachmentDraft, loadAttachmentDraft, saveAttachmentDraft } from '../../features/chat/attachmentDraftStore';
import { resolveAssetUrl } from '../../utils/pathManager';

function logVideoThumbnailDebug(event: string, fields: Record<string, unknown>) {
  const payload = {
    level: 'debug' as const,
    category: 'chat.attachment.thumbnail',
    event,
    message: event,
    fields,
  };
  console.info('[chat-thumbnail]', event, fields);
  void window.ipcRenderer?.logs?.appendRenderer?.(payload).catch(() => undefined);
}

interface UseChatAttachmentsInput {
  allowFileUpload: boolean;
  attachmentDraftScopeId: string;
  composerRef: RefObject<ChatComposerHandle>;
  currentSessionId: string | null;
  isActive: boolean;
  isProcessing: boolean;
  setErrorNotice: (notice: string | null) => void;
}

function dragEventHasFiles(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function droppedFiles(fileList: FileList | null | undefined): File[] {
  if (!fileList || fileList.length === 0) return [];
  return Array.from(fileList).filter((file) => file && file.name);
}

function droppedPaths(paths: string[] | null | undefined): string[] {
  return Array.from(new Set((paths || [])
    .map((path) => String(path || '').trim())
    .filter(Boolean)));
}

function pickFilesFromBrowserInput(): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '0';
    input.style.opacity = '0';

    let settled = false;
    const cleanup = () => {
      input.removeEventListener('change', handleChange);
      window.removeEventListener('focus', handleFocus);
      input.remove();
    };
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(focusTimerId);
      cleanup();
      resolve(files);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(focusTimerId);
      cleanup();
      reject(error);
    };
    function handleChange() {
      finish(droppedFiles(input.files));
    }
    function handleFocus() {
      window.clearTimeout(focusTimerId);
      focusTimerId = window.setTimeout(() => finish(droppedFiles(input.files)), 250);
    }

    let focusTimerId = window.setTimeout(() => undefined, 0);
    input.addEventListener('change', handleChange);
    window.addEventListener('focus', handleFocus);
    document.body.appendChild(input);
    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const tauriWindow = window as unknown as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(tauriWindow.__TAURI_INTERNALS__ || tauriWindow.__TAURI__);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reader.abort();
      reject(new Error('文件读取超时，请改用桌面端文件选择器或拖拽真实文件路径。'));
    }, 120000);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      callback();
    };
    reader.onload = () => finish(() => resolve(String(reader.result || '')));
    reader.onerror = () => finish(() => reject(reader.error || new Error('读取文件失败')));
    reader.onabort = () => finish(() => reject(new Error('文件读取已取消')));
    reader.readAsDataURL(file);
  });
}

function isVideoAttachment(attachment: UploadedFileAttachment | null | undefined): boolean {
  if (!attachment) return false;
  const kind = String(attachment.kind || '').trim().toLowerCase();
  const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
  const ext = String(attachment.ext || '').trim().replace(/^\./, '').toLowerCase();
  return kind === 'video' || mimeType.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'].includes(ext);
}

function attachmentIdentity(attachment: UploadedFileAttachment): string {
  return String(
    attachment.attachmentId
    || attachment.workspaceRelativePath
    || attachment.toolPath
    || attachment.absolutePath
    || attachment.originalAbsolutePath
    || attachment.inlineDataUrl
    || attachment.name
  ).trim();
}

function createVideoThumbnailDataUrl(source: string): Promise<string | null> {
  const normalizedSource = String(source || '').trim();
  if (!normalizedSource || typeof document === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    let settled = false;
    const cleanup = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      cleanup();
      resolve(value);
    };
    const timeoutId = window.setTimeout(() => finish(null), 5000);

    video.muted = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const seekTarget = Math.min(0.1, Math.max(0, (Number.isFinite(video.duration) ? video.duration : 0) / 2));
      if (Math.abs((video.currentTime || 0) - seekTarget) < 0.01) {
        video.dispatchEvent(new Event('seeked'));
      } else {
        video.currentTime = seekTarget;
      }
    };
    video.onseeked = () => {
      const width = video.videoWidth || 320;
      const height = video.videoHeight || 180;
      const maxSide = 360;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        finish(null);
        return;
      }
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.78));
      } catch {
        finish(null);
      }
    };
    video.src = normalizedSource;
    video.load();
  });
}

async function withVideoThumbnail(
  attachment: UploadedFileAttachment,
  preferredSource?: string,
  sessionId?: string | null,
): Promise<UploadedFileAttachment> {
  if (!isVideoAttachment(attachment)) {
    return attachment;
  }
  if (attachment.thumbnailDataUrl || attachment.thumbnailUrl) {
    logVideoThumbnailDebug('attachment.thumbnail.already-present', {
      name: attachment.name,
      thumbnailDataUrl: attachment.thumbnailDataUrl,
      thumbnailUrl: attachment.thumbnailUrl,
      localUrl: attachment.localUrl,
      absolutePath: attachment.absolutePath,
    });
    return attachment;
  }
  const source = String(
    preferredSource
    || attachment.localUrl
    || attachment.absolutePath
    || attachment.originalAbsolutePath
    || attachment.inlineDataUrl
    || '',
  ).trim();
  if (!source) {
    logVideoThumbnailDebug('attachment.thumbnail.no-source', {
      name: attachment.name,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      ext: attachment.ext,
    });
    return attachment;
  }
  const backendSource = String(
    attachment.absolutePath
    || attachment.localUrl
    || attachment.originalAbsolutePath
    || '',
  ).trim();
  logVideoThumbnailDebug('attachment.thumbnail.start', {
    name: attachment.name,
    source,
    backendSource,
    preferredSource,
    localUrl: attachment.localUrl,
    absolutePath: attachment.absolutePath,
    originalAbsolutePath: attachment.originalAbsolutePath,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    ext: attachment.ext,
  });
  if (backendSource && window.ipcRenderer?.chat?.createVideoThumbnail) {
    try {
      const result = await window.ipcRenderer.chat.createVideoThumbnail({
        source: backendSource,
        sessionId: sessionId || undefined,
      });
      logVideoThumbnailDebug('attachment.thumbnail.backend-result', {
        name: attachment.name,
        backendSource,
        result,
      });
      const thumbnailUrl = String(result?.thumbnailUrl || result?.thumbnailDataUrl || '').trim();
      if (result?.success && thumbnailUrl) {
        return { ...attachment, thumbnailDataUrl: thumbnailUrl, thumbnailUrl };
      }
    } catch (error) {
      logVideoThumbnailDebug('attachment.thumbnail.backend-error', {
        name: attachment.name,
        backendSource,
        error: error instanceof Error ? error.message : String(error),
      });
      // Browser-based extraction below is only a preview fallback.
    }
  }
  const thumbnailDataUrl = await createVideoThumbnailDataUrl(source.startsWith('blob:') || source.startsWith('data:') ? source : resolveAssetUrl(source));
  logVideoThumbnailDebug('attachment.thumbnail.browser-result', {
    name: attachment.name,
    source,
    resolvedSource: source.startsWith('blob:') || source.startsWith('data:') ? source : resolveAssetUrl(source),
    hasThumbnail: Boolean(thumbnailDataUrl),
    thumbnailLength: thumbnailDataUrl?.length || 0,
  });
  return thumbnailDataUrl ? { ...attachment, thumbnailDataUrl, thumbnailUrl: thumbnailDataUrl } : attachment;
}

function isPersistentAttachmentDraftScope(scopeId: string): boolean {
  const normalized = String(scopeId || '').trim();
  return Boolean(normalized && !normalized.startsWith('__'));
}

export function useChatAttachments({
  allowFileUpload,
  attachmentDraftScopeId,
  composerRef,
  currentSessionId,
  isActive,
  isProcessing,
  setErrorNotice,
}: UseChatAttachmentsInput) {
  const [pendingAttachments, setPendingAttachments] = useState<UploadedFileAttachment[]>([]);
  const [isAttachmentUploading, setIsAttachmentUploading] = useState(false);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const fileDragDepthRef = useRef(0);
  const repairingThumbnailKeysRef = useRef<Set<string>>(new Set());

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      composerRef.current?.syncHeight();
      composerRef.current?.focus();
    });
  }, [composerRef]);

  const appendPendingAttachment = useCallback((attachment: UploadedFileAttachment) => {
    setPendingAttachments((current) => {
      const key = attachmentIdentity(attachment);
      if (key && current.some((item) => attachmentIdentity(item) === key)) {
        return current;
      }
      return [...current, attachment];
    });
  }, []);

  const clearPendingAttachment = useCallback(() => {
    setIsAttachmentUploading(false);
    const attachments = pendingAttachments;
    setPendingAttachments([]);
    if (attachments.length > 0) {
      void window.ipcRenderer.chat.discardAttachments({ attachments });
    }
    focusComposer();
  }, [focusComposer, pendingAttachments]);

  const resetPendingAttachment = useCallback(() => {
    setIsAttachmentUploading(false);
    setPendingAttachments([]);
  }, []);

  const removePendingAttachment = useCallback((attachment: UploadedFileAttachment) => {
    const key = attachmentIdentity(attachment);
    setPendingAttachments((current) => current.filter((item) => attachmentIdentity(item) !== key));
    void window.ipcRenderer.chat.discardAttachments({ attachments: [attachment] });
    focusComposer();
  }, [focusComposer]);

  useEffect(() => {
    if (!isPersistentAttachmentDraftScope(attachmentDraftScopeId)) {
      clearAttachmentDraft('chat', attachmentDraftScopeId);
      setIsAttachmentUploading(false);
      setPendingAttachments([]);
      return;
    }
    const draft = loadAttachmentDraft('chat', attachmentDraftScopeId);
    setPendingAttachments(draft ? [draft] : []);
  }, [attachmentDraftScopeId]);

  useEffect(() => {
    if (!isPersistentAttachmentDraftScope(attachmentDraftScopeId)) return;
    saveAttachmentDraft('chat', attachmentDraftScopeId, pendingAttachments[0] || null);
  }, [attachmentDraftScopeId, pendingAttachments]);

  useEffect(() => {
    const missing = pendingAttachments.find((attachment) => (
      isVideoAttachment(attachment)
      && !attachment.thumbnailDataUrl
      && !attachment.thumbnailUrl
      && !repairingThumbnailKeysRef.current.has(attachmentIdentity(attachment))
    ));
    if (!missing) return;
    const key = attachmentIdentity(missing);
    if (!key) return;
    repairingThumbnailKeysRef.current.add(key);
    logVideoThumbnailDebug('attachment.thumbnail.repair-start', {
      key,
      name: missing.name,
      localUrl: missing.localUrl,
      absolutePath: missing.absolutePath,
      originalAbsolutePath: missing.originalAbsolutePath,
    });
    void withVideoThumbnail(missing, undefined, currentSessionId).then((repaired) => {
      if (!repaired.thumbnailDataUrl && !repaired.thumbnailUrl) return;
      setPendingAttachments((current) => current.map((item) => (
        attachmentIdentity(item) === key ? { ...item, ...repaired } : item
      )));
      logVideoThumbnailDebug('attachment.thumbnail.repair-success', {
        key,
        name: repaired.name,
        thumbnailDataUrl: repaired.thumbnailDataUrl,
        thumbnailUrl: repaired.thumbnailUrl,
      });
    }).catch((error) => {
      logVideoThumbnailDebug('attachment.thumbnail.repair-error', {
        key,
        name: missing.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      repairingThumbnailKeysRef.current.delete(key);
    });
  }, [currentSessionId, pendingAttachments]);

  const attachFile = useCallback(async (file: File) => {
    if (!allowFileUpload || isProcessing) return;
    setIsAttachmentUploading(true);
    setErrorNotice(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl.startsWith('data:')) {
        throw new Error('文件读取失败');
      }
      const result = await window.ipcRenderer.chat.createInlineAttachment({
        dataUrl,
        fileName: file.name || `attachment-${Date.now()}`,
        sessionId: currentSessionId || undefined,
      }) as { success?: boolean; error?: string; attachment?: UploadedFileAttachment };
      logVideoThumbnailDebug('attachment.inline.result', {
        fileName: file.name,
        success: result?.success,
        error: result?.error,
        attachment: result?.attachment,
      });
      if (!result?.success || !result.attachment) {
        throw new Error(result?.error || '上传文件失败');
      }
      let previewUrl = '';
      if (isVideoAttachment(result.attachment)) {
        previewUrl = URL.createObjectURL(file);
      }
      try {
        const attachmentWithThumbnail = await withVideoThumbnail(result.attachment, previewUrl, currentSessionId);
        logVideoThumbnailDebug('attachment.inline.append', {
          name: attachmentWithThumbnail.name,
          hasThumbnailDataUrl: Boolean(attachmentWithThumbnail.thumbnailDataUrl),
          thumbnailDataUrl: attachmentWithThumbnail.thumbnailDataUrl,
          thumbnailUrl: attachmentWithThumbnail.thumbnailUrl,
        });
        appendPendingAttachment(attachmentWithThumbnail);
      } finally {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
      }
      focusComposer();
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error || '上传文件失败'));
    } finally {
      setIsAttachmentUploading(false);
    }
  }, [allowFileUpload, appendPendingAttachment, currentSessionId, focusComposer, isProcessing, setErrorNotice]);

  const attachFilePath = useCallback(async (path: string) => {
    if (!allowFileUpload || isProcessing) return;
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath) return;
    setIsAttachmentUploading(true);
    setErrorNotice(null);
    try {
      const result = await window.ipcRenderer.chat.createPathAttachment({
        path: normalizedPath,
        sessionId: currentSessionId || undefined,
      }) as { success?: boolean; error?: string; attachment?: UploadedFileAttachment };
      logVideoThumbnailDebug('attachment.path.result', {
        path: normalizedPath,
        success: result?.success,
        error: result?.error,
        attachment: result?.attachment,
      });
      if (!result?.success || !result.attachment) {
        throw new Error(result?.error || '上传文件失败');
      }
      const attachmentWithThumbnail = await withVideoThumbnail(result.attachment, undefined, currentSessionId);
      logVideoThumbnailDebug('attachment.path.append', {
        name: attachmentWithThumbnail.name,
        hasThumbnailDataUrl: Boolean(attachmentWithThumbnail.thumbnailDataUrl),
        thumbnailDataUrl: attachmentWithThumbnail.thumbnailDataUrl,
        thumbnailUrl: attachmentWithThumbnail.thumbnailUrl,
      });
      appendPendingAttachment(attachmentWithThumbnail);
      focusComposer();
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error || '上传文件失败'));
    } finally {
      setIsAttachmentUploading(false);
    }
  }, [allowFileUpload, appendPendingAttachment, currentSessionId, focusComposer, isProcessing, setErrorNotice]);

  const handleDroppedFiles = useCallback((files: FileList | null | undefined) => {
    const items = droppedFiles(files);
    if (!items.length) return;
    void (async () => {
      for (const file of items) {
        await attachFile(file);
      }
    })();
  }, [attachFile]);

  const handleDroppedPaths = useCallback((paths: string[] | null | undefined) => {
    const items = droppedPaths(paths);
    if (!items.length) return;
    void (async () => {
      for (const path of items) {
        await attachFilePath(path);
      }
    })();
  }, [attachFilePath]);

  useEffect(() => {
    if (!allowFileUpload || !isActive) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    getCurrentWindow().onDragDropEvent((event) => {
      if (disposed || isProcessing) return;
      const payload = event.payload as DragDropEvent;
      if (payload.type === 'enter' || payload.type === 'over') {
        setIsFileDragActive(true);
        return;
      }
      if (payload.type === 'drop') {
        fileDragDepthRef.current = 0;
        setIsFileDragActive(false);
        handleDroppedPaths(payload.paths);
        return;
      }
      if (payload.type === 'leave') {
        fileDragDepthRef.current = 0;
        setIsFileDragActive(false);
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    }).catch(() => {
      // Browser preview builds keep the HTML5 drag handlers below.
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [allowFileUpload, handleDroppedPaths, isActive, isProcessing]);

  const handleFileDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!allowFileUpload || isProcessing || !dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current += 1;
    setIsFileDragActive(true);
  }, [allowFileUpload, isProcessing]);

  const handleFileDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!allowFileUpload || isProcessing || !dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setIsFileDragActive(true);
  }, [allowFileUpload, isProcessing]);

  const handleFileDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!allowFileUpload || !dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) {
      setIsFileDragActive(false);
    }
  }, [allowFileUpload]);

  const handleFileDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!allowFileUpload || isProcessing || !dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = 0;
    setIsFileDragActive(false);
    if (isTauriRuntime()) {
      return;
    }
    handleDroppedFiles(event.dataTransfer.files);
  }, [allowFileUpload, handleDroppedFiles, isProcessing]);

  const pickAttachment = useCallback(async () => {
    if (isProcessing) return;
    if (!allowFileUpload) return;
    try {
      const pickedFiles = await pickFilesFromBrowserInput();
      if (pickedFiles.length === 0) return;
      for (const file of pickedFiles) {
        await attachFile(file);
      }
      return;
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error || '选择文件失败'));
    }

    setIsAttachmentUploading(true);
    setErrorNotice(null);
    try {
      const result = await window.ipcRenderer.chat.pickAttachment({
        sessionId: currentSessionId || undefined,
      }) as { success?: boolean; canceled?: boolean; error?: string; attachment?: UploadedFileAttachment };
      if (!result?.success) {
        setErrorNotice(result?.error || '上传文件失败');
        return;
      }
      if (result.canceled) return;
      if (result.attachment) {
        setErrorNotice(null);
        appendPendingAttachment(await withVideoThumbnail(result.attachment));
        focusComposer();
      }
    } catch (error) {
      setErrorNotice(String(error || '上传文件失败'));
    } finally {
      setIsAttachmentUploading(false);
    }
  }, [allowFileUpload, appendPendingAttachment, attachFile, currentSessionId, focusComposer, isProcessing, setErrorNotice]);

  return {
    clearPendingAttachment,
    dragHandlers: {
      onDragEnter: handleFileDragEnter,
      onDragLeave: handleFileDragLeave,
      onDragOver: handleFileDragOver,
      onDrop: handleFileDrop,
    },
    isAttachmentUploading,
    isFileDragActive,
    pendingAttachment: pendingAttachments[0] || null,
    pendingAttachments,
    pickAttachment,
    removePendingAttachment,
    resetPendingAttachment,
    setPendingAttachment: (attachment: UploadedFileAttachment | null) => {
      setPendingAttachments(attachment ? [attachment] : []);
    },
    setPendingAttachments,
  };
}
