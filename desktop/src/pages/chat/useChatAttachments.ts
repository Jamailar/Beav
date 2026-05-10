import { getCurrentWindow, type DragDropEvent } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { ChatComposerHandle, UploadedFileAttachment } from '../../components/ChatComposer';
import { clearAttachmentDraft, loadAttachmentDraft, saveAttachmentDraft } from '../../features/chat/attachmentDraftStore';
import { resolveAssetUrl } from '../../utils/pathManager';

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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
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
): Promise<UploadedFileAttachment> {
  if (!isVideoAttachment(attachment) || attachment.thumbnailDataUrl) return attachment;
  const source = String(
    preferredSource
    || attachment.localUrl
    || attachment.absolutePath
    || attachment.originalAbsolutePath
    || attachment.inlineDataUrl
    || '',
  ).trim();
  if (!source) return attachment;
  const thumbnailDataUrl = await createVideoThumbnailDataUrl(source.startsWith('blob:') || source.startsWith('data:') ? source : resolveAssetUrl(source));
  return thumbnailDataUrl ? { ...attachment, thumbnailDataUrl } : attachment;
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

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      composerRef.current?.syncHeight();
      composerRef.current?.focus();
    });
  }, [composerRef]);

  const appendPendingAttachment = useCallback((attachment: UploadedFileAttachment) => {
    setPendingAttachments((current) => {
      const key = String(
        attachment.attachmentId
        || attachment.workspaceRelativePath
        || attachment.toolPath
        || attachment.absolutePath
        || attachment.originalAbsolutePath
        || attachment.inlineDataUrl
        || attachment.name
      ).trim();
      if (key && current.some((item) => String(
        item.attachmentId
        || item.workspaceRelativePath
        || item.toolPath
        || item.absolutePath
        || item.originalAbsolutePath
        || item.inlineDataUrl
        || item.name
      ).trim() === key)) {
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
    const key = String(
      attachment.attachmentId
      || attachment.workspaceRelativePath
      || attachment.toolPath
      || attachment.absolutePath
      || attachment.originalAbsolutePath
      || attachment.inlineDataUrl
      || attachment.name
    ).trim();
    setPendingAttachments((current) => current.filter((item) => String(
      item.attachmentId
      || item.workspaceRelativePath
      || item.toolPath
      || item.absolutePath
      || item.originalAbsolutePath
      || item.inlineDataUrl
      || item.name
    ).trim() !== key));
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
      if (!result?.success || !result.attachment) {
        throw new Error(result?.error || '上传文件失败');
      }
      let previewUrl = '';
      if (isVideoAttachment(result.attachment)) {
        previewUrl = URL.createObjectURL(file);
      }
      try {
        appendPendingAttachment(await withVideoThumbnail(result.attachment, previewUrl));
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
      if (!result?.success || !result.attachment) {
        throw new Error(result?.error || '上传文件失败');
      }
      appendPendingAttachment(await withVideoThumbnail(result.attachment));
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
    handleDroppedFiles(event.dataTransfer.files);
  }, [allowFileUpload, handleDroppedFiles, isProcessing]);

  const pickAttachment = useCallback(async () => {
    if (isProcessing) return;
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
  }, [appendPendingAttachment, currentSessionId, focusComposer, isProcessing, setErrorNotice]);

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
