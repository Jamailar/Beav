export function toAbsoluteUrl(value) {
  try {
    return new URL(value || '', location.href).href;
  } catch {
    return value || '';
  }
}

export function absolutizeSrcset(srcset) {
  return srcset
    .split(',')
    .map((part) => {
      const [url, ...rest] = part.trim().split(/\s+/);
      if (!url) return '';
      return [toAbsoluteUrl(url), ...rest].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

export function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function unique(items) {
  return [...new Set(items)];
}

export function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

export function cssPath(element) {
  const parts = [];
  let node = element;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part += `#${cssEscape(node.id)}`;
      parts.unshift(part);
      break;
    }
    const classes = [...node.classList].slice(0, 2).map(cssEscape);
    if (classes.length) part += `.${classes.join('.')}`;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
