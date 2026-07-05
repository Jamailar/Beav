import type { ClipboardCaptureCandidate, ClipboardCaptureSource } from '../captureTypes';
import { hostnameMatches, parseHttpUrl, sanitizeClipboardUrl } from '../clipboardUrlExtractor';

function candidateId(kind: string, key: string): string {
  return `${kind}:${key}`;
}

export function detectTiktokClipboardCandidate(
  rawUrl: string,
  rawText: string,
  source: ClipboardCaptureSource,
): ClipboardCaptureCandidate | null {
  const sanitized = sanitizeClipboardUrl(rawUrl);
  const parsed = parseHttpUrl(sanitized);
  if (!parsed || !hostnameMatches(parsed, ['tiktok.com'])) return null;

  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const handle = pathParts[0]?.startsWith('@') ? pathParts[0].slice(1).trim() : '';
  if (!handle || pathParts[1] === 'video') return null;
  if (!/^[A-Za-z0-9_.]{1,32}$/.test(handle)) return null;

  return {
    id: candidateId('tiktok-profile', handle),
    kind: 'tiktok-profile',
    platform: 'tiktok',
    rawText,
    rawUrl: sanitized,
    canonicalUrl: `https://www.tiktok.com/@${handle}`,
    externalId: handle,
    confidence: 'exact',
    source,
    detectedAt: new Date().toISOString(),
  };
}
