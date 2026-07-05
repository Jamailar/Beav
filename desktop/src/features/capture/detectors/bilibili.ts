import type { ClipboardCaptureCandidate, ClipboardCaptureSource } from '../captureTypes';
import { hostnameMatches, parseHttpUrl, sanitizeClipboardUrl } from '../clipboardUrlExtractor';

function candidateId(kind: string, key: string): string {
  return `${kind}:${key}`;
}

export function detectBilibiliClipboardCandidate(
  rawUrl: string,
  rawText: string,
  source: ClipboardCaptureSource,
): ClipboardCaptureCandidate | null {
  const sanitized = sanitizeClipboardUrl(rawUrl);
  const parsed = parseHttpUrl(sanitized);
  if (!parsed || !hostnameMatches(parsed, ['bilibili.com', 'b23.tv'])) return null;

  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  const uid = host.includes('bilibili.com') && pathParts[0] && /^\d+$/.test(pathParts[0])
    ? pathParts[0]
    : host.includes('bilibili.com') && pathParts[0] === 'space' && pathParts[1] && /^\d+$/.test(pathParts[1])
      ? pathParts[1]
      : '';
  const key = uid || sanitized;

  return {
    id: candidateId('bilibili-profile', key),
    kind: 'bilibili-profile',
    platform: 'bilibili',
    rawText,
    rawUrl: sanitized,
    canonicalUrl: uid ? `https://space.bilibili.com/${uid}` : sanitized,
    externalId: uid || undefined,
    confidence: uid ? 'exact' : 'probable',
    source,
    detectedAt: new Date().toISOString(),
  };
}
