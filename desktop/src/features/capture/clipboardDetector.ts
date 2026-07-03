import type { ClipboardCaptureCandidate, ClipboardCaptureSource } from './captureTypes';
import { extractClipboardUrls } from './clipboardUrlExtractor';
import { detectYouTubeClipboardCandidate } from './detectors/youtube';

const MAX_CLIPBOARD_TEXT_CHARS = 20_000;

type ClipboardDetector = (
  rawUrl: string,
  rawText: string,
  source: ClipboardCaptureSource,
) => ClipboardCaptureCandidate | null;

const DETECTORS: ClipboardDetector[] = [
  // Xiaohongshu and Douyin detectors exist for parity, but stay disabled until
  // Electron has server capture adapters for those platforms.
  detectYouTubeClipboardCandidate,
];

export function detectClipboardCaptureCandidate(
  text: string,
  source: ClipboardCaptureSource,
): ClipboardCaptureCandidate | null {
  const rawText = String(text || '').trim();
  if (!rawText || rawText.length > MAX_CLIPBOARD_TEXT_CHARS) return null;

  const urls = extractClipboardUrls(rawText);
  for (const url of urls) {
    for (const detector of DETECTORS) {
      const candidate = detector(url, rawText, source);
      if (candidate) return candidate;
    }
  }

  return null;
}

export function clipboardCaptureDedupeKey(candidate: ClipboardCaptureCandidate): string {
  return candidate.externalId
    ? `${candidate.kind}:${candidate.externalId}`
    : `${candidate.kind}:${candidate.canonicalUrl}`;
}

export function clipboardCapturePlatformLabel(candidate: ClipboardCaptureCandidate): string {
  if (candidate.kind === 'youtube-video') return 'YouTube';
  if (candidate.kind === 'xhs-profile') return '小红书主页';
  if (candidate.kind === 'xhs-note') return '小红书笔记';
  if (candidate.kind === 'douyin-video') return '抖音视频';
  return '链接';
}
