const TRAILING_URL_PUNCTUATION_RE = /[)\]}>,.!?，。！？、；;：:]+$/g;
const SUPPORTED_BARE_URL_RE = /(?:^|[\s"'([{<])((?:www\.)?(?:xiaohongshu\.com|rednote\.com|douyin\.com|iesdouyin\.com|youtube\.com|bilibili\.com|tiktok\.com)\/[^\s"'<>]+|(?:xhslink\.com|v\.douyin\.com|youtu\.be|b23\.tv)\/[^\s"'<>]+)/gi;

export function sanitizeClipboardUrl(rawInput: string): string {
  return String(rawInput || '')
    .trim()
    .replace(TRAILING_URL_PUNCTUATION_RE, '')
    .replace(/^<|>$/g, '');
}

export function parseHttpUrl(rawInput: string): URL | null {
  const sanitized = sanitizeClipboardUrl(rawInput);
  if (!sanitized) return null;
  try {
    const parsed = new URL(sanitized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function extractClipboardUrls(text: string, limit = 10): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const direct = parseHttpUrl(raw);
  if (direct) return [sanitizeClipboardUrl(raw)];

  const seen = new Set<string>();
  const matches = [
    ...(raw.match(/https?:\/\/[^\s"'<>]+/gi) || []),
    ...Array.from(raw.matchAll(SUPPORTED_BARE_URL_RE)).map((match) => `https://${match[1]}`),
  ];
  const urls: string[] = [];
  for (const match of matches) {
    const sanitized = sanitizeClipboardUrl(match);
    if (!sanitized || seen.has(sanitized) || !parseHttpUrl(sanitized)) continue;
    seen.add(sanitized);
    urls.push(sanitized);
    if (urls.length >= limit) break;
  }
  return urls;
}

export function normalizedHostname(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^www\./, '');
}

export function hostnameMatches(parsed: URL, domains: string[]): boolean {
  const host = parsed.hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
