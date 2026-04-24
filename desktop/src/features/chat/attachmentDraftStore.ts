import type { UploadedFileAttachment } from '../../components/ChatComposer';

const ATTACHMENT_DRAFT_STORAGE_PREFIX = 'redbox:chat:attachment-draft:v1';

function storageKey(surface: string, scopeId: string): string {
  const normalizedSurface = String(surface || '').trim() || 'chat';
  const normalizedScopeId = String(scopeId || '').trim() || '__default__';
  return `${ATTACHMENT_DRAFT_STORAGE_PREFIX}:${normalizedSurface}:${normalizedScopeId}`;
}

function toPersistableAttachmentDraft(
  attachment: UploadedFileAttachment | null | undefined,
): UploadedFileAttachment | null {
  if (!attachment || attachment.type !== 'uploaded-file') {
    return null;
  }
  const { thumbnailDataUrl: _thumbnailDataUrl, ...persisted } = attachment;
  return persisted;
}

export function loadAttachmentDraft(
  surface: string,
  scopeId: string,
): UploadedFileAttachment | null {
  try {
    const raw = window.localStorage.getItem(storageKey(surface, scopeId));
    if (!raw) return null;
    return toPersistableAttachmentDraft(JSON.parse(raw) as UploadedFileAttachment);
  } catch {
    return null;
  }
}

export function saveAttachmentDraft(
  surface: string,
  scopeId: string,
  attachment: UploadedFileAttachment | null | undefined,
): void {
  try {
    const key = storageKey(surface, scopeId);
    const persisted = toPersistableAttachmentDraft(attachment);
    if (!persisted) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(persisted));
  } catch {
    // Ignore storage failures and keep the in-memory draft usable.
  }
}
