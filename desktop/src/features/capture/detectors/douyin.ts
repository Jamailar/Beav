import type { ClipboardCaptureCandidate, ClipboardCaptureSource } from '../captureTypes';
import { hostnameMatches, parseHttpUrl, sanitizeClipboardUrl } from '../clipboardUrlExtractor';

function candidateId(kind: string, key: string): string {
  return `${kind}:${key}`;
}

function cleanAwemeId(value: string): string {
  return String(value || '').trim().replace(/[^\d]/g, '');
}

export function detectDouyinClipboardCandidate(
  rawUrl: string,
  rawText: string,
  source: ClipboardCaptureSource,
): ClipboardCaptureCandidate | null {
  const sanitized = sanitizeClipboardUrl(rawUrl);
  const parsed = parseHttpUrl(sanitized);
  if (!parsed || !hostnameMatches(parsed, ['douyin.com', 'iesdouyin.com'])) return null;

  const pathParts = parsed.pathname.split('/').filter(Boolean);

  if (parsed.hostname.toLowerCase() === 'v.douyin.com') {
    return {
      id: candidateId('douyin-video', sanitized),
      kind: 'douyin-video',
      platform: 'douyin',
      rawText,
      rawUrl: sanitized,
      canonicalUrl: sanitized,
      confidence: 'probable',
      source,
      detectedAt: new Date().toISOString(),
    };
  }

  let awemeId = '';
  if (pathParts[0] === 'user' && pathParts[1]) {
    const profileId = String(pathParts[1] || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '');
    if (profileId) {
      return {
        id: candidateId('douyin-profile', profileId),
        kind: 'douyin-profile',
        platform: 'douyin',
        rawText,
        rawUrl: sanitized,
        canonicalUrl: `https://www.douyin.com/user/${profileId}`,
        externalId: profileId,
        confidence: 'exact',
        source,
        detectedAt: new Date().toISOString(),
      };
    }
  }

  if (pathParts[0] === 'video') {
    awemeId = cleanAwemeId(pathParts[1]);
  } else if (pathParts[0] === 'share' && pathParts[1] === 'video') {
    awemeId = cleanAwemeId(pathParts[2]);
  }

  if (!awemeId) return null;

  return {
    id: candidateId('douyin-video', awemeId),
    kind: 'douyin-video',
    platform: 'douyin',
    rawText,
    rawUrl: sanitized,
    canonicalUrl: `https://www.douyin.com/video/${awemeId}`,
    externalId: awemeId,
    confidence: 'exact',
    source,
    detectedAt: new Date().toISOString(),
  };
}
