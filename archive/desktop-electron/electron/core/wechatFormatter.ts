type WechatFormatterInput = {
  content: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

type WechatFormatterResult = {
  title: string;
  html: string;
  plainText: string;
};

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'blockquote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'image'; alt: string; src: string }
  | { type: 'hr' };

const WECHAT_WRAPPER_STYLE = [
  'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
  'font-size:16px',
  'line-height:1.9',
  'color:#1f2937',
  'word-break:break-word',
].join(';');

const escapeHtml = (value: string): string => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const stripMarkdown = (value: string): string => String(value || '')
  .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/_([^_]+)_/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^\s*>\s?/gm, '')
  .replace(/^\s*[-+*]\s+/gm, '')
  .replace(/^\s*\d+\.\s+/gm, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const extractSection = (content: string, heading: string): string => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|\\n#\\s+|$)`));
  return match?.[1]?.trim() || '';
};

const normalizeSectionValue = (value: string): string => {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '(无)' || normalized === '(空)' || normalized === '(待定)') {
    return '';
  }
  return normalized;
};

const buildWechatArticleMarkdown = (content: string, inputTitle?: string): { title: string; markdown: string } => {
  const finalTitle = normalizeSectionValue(extractSection(content, '最终标题'));
  const summary = normalizeSectionValue(extractSection(content, '摘要'));
  const introduction = normalizeSectionValue(extractSection(content, '导语'));
  const body = normalizeSectionValue(extractSection(content, '正文'));
  const cta = normalizeSectionValue(extractSection(content, '结尾 CTA'));
  const fallbackBody = body || extractSection(content, '正文内容') || content;
  const title = normalizeTitle(inputTitle || finalTitle, fallbackBody);

  if (!body && !summary && !introduction && !cta) {
    return { title, markdown: content };
  }

  const lines = [
    introduction || '',
    summary ? `> 摘要：${summary}` : '',
    fallbackBody || '',
    cta ? `## 结尾\n${cta}` : '',
  ].filter(Boolean);

  return {
    title,
    markdown: lines.join('\n\n').trim(),
  };
};

const normalizeTitle = (title?: string, content?: string): string => {
  const preferred = String(title || '').trim();
  if (preferred) return preferred;
  const firstHeading = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#\s+/.test(line));
  if (firstHeading) {
    return firstHeading.replace(/^#\s+/, '').trim();
  }
  return '未命名公众号文章';
};

const sanitizeImageSource = (value: string): string => {
  const source = String(value || '').trim();
  if (!source) return '';
  if (/^javascript:/i.test(source)) {
    return '';
  }
  if (/^(https?:|data:image\/|\/|\.{1,2}\/)/i.test(source)) {
    return source;
  }
  return source;
};

const renderInlineMarkdown = (value: string): string => {
  let output = escapeHtml(String(value || '').trim());
  output = output.replace(/`([^`]+)`/g, '<code style="padding:2px 6px;border-radius:6px;background:#f3f4f6;color:#be123c;font-size:0.92em;">$1</code>');
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#111827;font-weight:700;">$1</strong>');
  output = output.replace(/__([^_]+)__/g, '<strong style="color:#111827;font-weight:700;">$1</strong>');
  output = output.replace(/\*([^*]+)\*/g, '<em style="font-style:italic;">$1</em>');
  output = output.replace(/_([^_]+)_/g, '<em style="font-style:italic;">$1</em>');
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const href = escapeHtml(String(url || '').trim());
    if (!/^https?:\/\//i.test(href)) {
      return escapeHtml(label);
    }
    return `<a href="${href}" style="color:#0f766e;text-decoration:underline;">${escapeHtml(label)}</a>`;
  });
  return output.replace(/\n/g, '<br />');
};

const parseBlocks = (content: string): Block[] => {
  const lines = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      index += 1;
      continue;
    }

    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imageMatch) {
      const src = sanitizeImageSource(imageMatch[2]);
      if (src) {
        blocks.push({ type: 'image', alt: imageMatch[1] || '', src });
      } else {
        blocks.push({ type: 'paragraph', text: imageMatch[1] || '图片' });
      }
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        if (!current || !/^>\s?/.test(current)) break;
        quoteLines.push(current.replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    const unorderedMatch = line.match(/^[-+*]\s+(.+)$/);
    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        const matcher = ordered
          ? current.match(/^\d+\.\s+(.+)$/)
          : current.match(/^[-+*]\s+(.+)$/);
        if (!matcher) break;
        items.push(matcher[1].trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current) break;
      if (/^!\[([^\]]*)\]\(([^)]+)\)$/.test(current)) break;
      if (/^(#{1,6})\s+/.test(current)) break;
      if (/^>\s?/.test(current)) break;
      if (/^([-*_])\1{2,}$/.test(current)) break;
      if (/^[-+*]\s+/.test(current)) break;
      if (/^\d+\.\s+/.test(current)) break;
      paragraphLines.push(current);
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join('\n') });
  }

  return blocks;
};

const renderBlock = (block: Block, title: string): string => {
  switch (block.type) {
    case 'heading': {
      if (block.level === 1 && block.text.trim() === title.trim()) {
        return '';
      }
      const styleByLevel: Record<number, string> = {
        1: 'margin:32px 0 18px;font-size:28px;line-height:1.35;font-weight:700;color:#111827;',
        2: 'margin:30px 0 16px;padding-left:12px;border-left:4px solid #14b8a6;font-size:22px;line-height:1.45;font-weight:700;color:#111827;',
        3: 'margin:24px 0 12px;font-size:18px;line-height:1.6;font-weight:700;color:#111827;',
        4: 'margin:22px 0 10px;font-size:16px;line-height:1.7;font-weight:700;color:#111827;',
      };
      return `<h${Math.min(block.level, 4)} style="${styleByLevel[Math.min(block.level, 4)] || styleByLevel[4]}">${renderInlineMarkdown(block.text)}</h${Math.min(block.level, 4)}>`;
    }
    case 'paragraph':
      return `<p style="margin:16px 0;text-align:justify;">${renderInlineMarkdown(block.text)}</p>`;
    case 'blockquote':
      return `<blockquote style="margin:20px 0;padding:14px 16px;border-left:4px solid #94a3b8;background:#f8fafc;color:#334155;border-radius:0 12px 12px 0;">${renderInlineMarkdown(block.text)}</blockquote>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const listStyle = block.ordered ? 'decimal' : 'disc';
      const items = block.items
        .map((item) => `<li style="margin:8px 0;">${renderInlineMarkdown(item)}</li>`)
        .join('');
      return `<${tag} style="margin:16px 0 16px 22px;padding:0;list-style:${listStyle};">${items}</${tag}>`;
    }
    case 'image':
      return [
        '<figure style="margin:24px 0;text-align:center;">',
        `<img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}" style="max-width:100%;height:auto;border-radius:14px;display:block;margin:0 auto;" />`,
        block.alt ? `<figcaption style="margin-top:8px;font-size:12px;color:#6b7280;">${escapeHtml(block.alt)}</figcaption>` : '',
        '</figure>',
      ].join('');
    case 'hr':
      return '<hr style="margin:28px auto;border:none;border-top:1px solid #d1d5db;width:100%;" />';
    default:
      return '';
  }
};

export function formatWechatArticleFromMarkdown(input: WechatFormatterInput): WechatFormatterResult {
  const normalizedInput = buildWechatArticleMarkdown(String(input.content || '').trim(), input.title);
  const markdown = normalizedInput.markdown;
  const title = normalizedInput.title;
  const blocks = parseBlocks(markdown);
  const plainText = stripMarkdown(markdown);
  const renderedBlocks = blocks
    .map((block) => renderBlock(block, title))
    .filter(Boolean)
    .join('');

  const titleHtml = `<h1 style="margin:0 0 24px;font-size:32px;line-height:1.35;font-weight:800;letter-spacing:0.01em;color:#111827;">${escapeHtml(title)}</h1>`;
  const html = [
    `<section data-redconvert-wechat="true" style="${WECHAT_WRAPPER_STYLE}">`,
    titleHtml,
    renderedBlocks || `<p style="margin:16px 0;text-align:justify;">${renderInlineMarkdown(markdown || title)}</p>`,
    '</section>',
  ].join('');

  return {
    title,
    html,
    plainText,
  };
}
