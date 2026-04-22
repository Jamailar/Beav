import React, { memo, useMemo } from 'react';
import ReactMarkdown, { Components, UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const REMARK_PLUGINS = [remarkGfm];
const CODE_FENCE_PATTERN = /(^|\n)```/g;

const hasUnclosedCodeFence = (content: string): boolean => {
  let count = 0;
  for (const _match of content.matchAll(CODE_FENCE_PATTERN)) {
    count += 1;
  }
  return count % 2 === 1;
};

const normalizeStreamingMarkdown = (content: string, isStreaming?: boolean): string => {
  const text = String(content || '');
  if (!isStreaming || !text) return text;
  if (!hasUnclosedCodeFence(text)) return text;
  return `${text}\n\`\`\``;
};

interface StreamingMarkdownProps {
  content: string;
  isStreaming?: boolean;
  components: Components;
  urlTransform?: UrlTransform;
  className?: string;
}

export const StreamingMarkdown = memo(({
  content,
  isStreaming,
  components,
  urlTransform,
  className,
}: StreamingMarkdownProps) => {
  const normalizedContent = useMemo(
    () => normalizeStreamingMarkdown(content, isStreaming),
    [content, isStreaming],
  );

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={components}
        urlTransform={urlTransform}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
});

StreamingMarkdown.displayName = 'StreamingMarkdown';
