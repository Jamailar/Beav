import type { ClipboardCaptureCandidate, ClipboardCaptureSource } from '../captureTypes';
import { hostnameMatches, parseHttpUrl, sanitizeClipboardUrl } from '../clipboardUrlExtractor';

function candidateId(kind: string, key: string): string {
  return `${kind}:${key}`;
}

function cleanId(value: string): string {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
}

function xhsShortlinkKind(parsed: URL): 'xhs-note' | 'xhs-profile' {
  const firstPathPart = parsed.pathname.split('/').filter(Boolean)[0]?.toLowerCase() || '';
  return firstPathPart === 'm' ? 'xhs-profile' : 'xhs-note';
}

export function detectXiaohongshuClipboardCandidate(
  rawUrl: string,
  rawText: string,
  source: ClipboardCaptureSource,
): ClipboardCaptureCandidate | null {
  const sanitized = sanitizeClipboardUrl(rawUrl);
  const parsed = parseHttpUrl(sanitized);
  if (!parsed) return null;

  if (hostnameMatches(parsed, ['xhslink.com'])) {
    const kind = xhsShortlinkKind(parsed);
    return {
      id: candidateId(kind, sanitized),
      kind,
      platform: 'xiaohongshu',
      rawText,
      rawUrl: sanitized,
      canonicalUrl: sanitized,
      confidence: 'probable',
      source,
      detectedAt: new Date().toISOString(),
    };
  }

  if (!hostnameMatches(parsed, ['xiaohongshu.com', 'rednote.com'])) return null;

  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const first = pathParts[0] || '';
  const second = pathParts[1] || '';
  const third = pathParts[2] || '';

  if (first === 'explore' || (first === 'discovery' && second === 'item')) {
    const noteId = cleanId(first === 'explore' ? second : third);
    if (!noteId) return null;
    return {
      id: candidateId('xhs-note', noteId),
      kind: 'xhs-note',
      platform: 'xiaohongshu',
      rawText,
      rawUrl: sanitized,
      canonicalUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
      externalId: noteId,
      confidence: 'exact',
      source,
      detectedAt: new Date().toISOString(),
    };
  }

  if (first === 'user' && second === 'profile') {
    const userId = cleanId(third);
    if (!userId) return null;
    return {
      id: candidateId('xhs-profile', userId),
      kind: 'xhs-profile',
      platform: 'xiaohongshu',
      rawText,
      rawUrl: sanitized,
      canonicalUrl: `https://www.xiaohongshu.com/user/profile/${userId}`,
      externalId: userId,
      confidence: 'exact',
      source,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}
