import { useMemo } from 'react';
import clsx from 'clsx';
import MarkdownIt from 'markdown-it';
import { resolveAssetUrl } from '../../utils/pathManager';
import { parseMarkdownFrontmatter } from '../../utils/markdownFrontmatter';

type MarkdownItPreviewProps = {
  content: string;
  className?: string;
};

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
});

const defaultLinkOpenRenderer = markdownRenderer.renderer.rules.link_open
  || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdownRenderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noreferrer noopener');
  return defaultLinkOpenRenderer(tokens, idx, options, env, self);
};

const defaultImageRenderer = markdownRenderer.renderer.rules.image
  || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdownRenderer.renderer.rules.image = (tokens, idx, options, env, self) => {
  const srcIndex = tokens[idx].attrIndex('src');
  if (srcIndex >= 0 && tokens[idx].attrs) {
    const original = tokens[idx].attrs[srcIndex]?.[1] || '';
    tokens[idx].attrs[srcIndex][1] = resolveAssetUrl(original);
  }
  return defaultImageRenderer(tokens, idx, options, env, self);
};

export function MarkdownItPreview({ content, className }: MarkdownItPreviewProps) {
  const html = useMemo(
    () => {
      const { body } = parseMarkdownFrontmatter(content);
      return markdownRenderer.render(body.trim() || '开始写内容后，这里会显示正文。');
    },
    [content]
  );

  return (
    <div
      className={clsx(
        'markdown-it-preview max-w-none',
        '[&_h1]:text-[2rem] [&_h1]:font-semibold [&_h1]:leading-tight [&_h1]:tracking-tight [&_h1]:text-text-primary',
        '[&_h2]:mt-10 [&_h2]:text-[1.45rem] [&_h2]:font-semibold [&_h2]:leading-tight [&_h2]:tracking-tight [&_h2]:text-text-primary',
        '[&_h3]:mt-8 [&_h3]:text-[1.15rem] [&_h3]:font-semibold [&_h3]:leading-tight [&_h3]:text-text-primary',
        '[&_h4]:mt-6 [&_h4]:text-lg [&_h4]:font-semibold [&_h4]:text-text-primary',
        '[&_p]:my-0 [&_p]:text-[15px] [&_p]:leading-8 [&_p]:text-text-secondary',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-text-tertiary',
        '[&_a]:text-accent-primary [&_a]:underline [&_a]:underline-offset-4',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:text-[15px] [&_ul]:leading-7 [&_ul]:text-text-secondary',
        '[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:text-[15px] [&_ol]:leading-7 [&_ol]:text-text-secondary',
        '[&_li]:my-2',
        '[&_hr]:my-8 [&_hr]:border-border',
        '[&_code]:rounded-md [&_code]:bg-surface-secondary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-accent-primary',
        '[&_pre]:my-6 [&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-secondary [&_pre]:p-4',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-text-primary',
        '[&_table]:my-6 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-2xl [&_table]:border [&_table]:border-border',
        '[&_thead]:bg-surface-secondary',
        '[&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-sm [&_th]:font-semibold [&_th]:text-text-primary',
        '[&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:text-sm [&_td]:text-text-secondary',
        '[&_img]:my-6 [&_img]:max-w-full [&_img]:rounded-xl [&_img]:border [&_img]:border-border',
        '[&>*+*]:mt-6',
        className
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
