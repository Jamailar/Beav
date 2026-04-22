import { parseDocument } from 'yaml';

export type MarkdownFrontmatterValue =
  | string
  | number
  | boolean
  | null
  | MarkdownFrontmatterValue[]
  | { [key: string]: MarkdownFrontmatterValue };

export interface MarkdownFrontmatterResult {
  hasFrontmatter: boolean;
  data: Record<string, MarkdownFrontmatterValue>;
  raw: string | null;
  block: string | null;
  body: string;
}

function normalizeMarkdownSource(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function parseMarkdownFrontmatter(source: string): MarkdownFrontmatterResult {
  const normalized = normalizeMarkdownSource(source || '');

  if (!normalized.startsWith('---\n')) {
    return {
      hasFrontmatter: false,
      data: {},
      raw: null,
      block: null,
      body: normalized,
    };
  }

  const lines = normalized.split('\n');
  let endIndex = -1;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === '---' || line === '...') {
      endIndex = index;
      break;
    }
  }

  if (endIndex < 0) {
    return {
      hasFrontmatter: false,
      data: {},
      raw: null,
      block: null,
      body: normalized,
    };
  }

  const raw = lines.slice(1, endIndex).join('\n');
  const block = lines.slice(0, endIndex + 1).join('\n');

  if (!raw.trim()) {
    return {
      hasFrontmatter: true,
      data: {},
      raw,
      block,
      body: lines.slice(endIndex + 1).join('\n').replace(/^\n+/, ''),
    };
  }

  const document = parseDocument(raw);
  const parsed = document.toJSON();

  if (document.errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      hasFrontmatter: false,
      data: {},
      raw: null,
      block: null,
      body: normalized,
    };
  }

  return {
    hasFrontmatter: true,
    data: parsed as Record<string, MarkdownFrontmatterValue>,
    raw,
    block,
    body: lines.slice(endIndex + 1).join('\n').replace(/^\n+/, ''),
  };
}

export function composeMarkdownWithFrontmatter(body: string, block?: string | null): string {
  if (!block) {
    return body || '';
  }
  const normalizedBody = normalizeMarkdownSource(body || '');
  const normalizedBlock = normalizeMarkdownSource(block).replace(/\n+$/, '');
  const nextBody = normalizedBody.replace(/^\n+/, '');
  return nextBody ? `${normalizedBlock}\n\n${nextBody}` : `${normalizedBlock}\n`;
}
