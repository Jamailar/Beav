import remarkGfm from 'remark-gfm';

const supportsRemarkGfmAutolinkRegex = (): boolean => {
  try {
    new RegExp('(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)', 'gu');
    return true;
  } catch {
    return false;
  }
};

export const SAFE_REMARK_PLUGINS = supportsRemarkGfmAutolinkRegex() ? [remarkGfm] : [];
