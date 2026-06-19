const XWOW_FAVICON_BADGE_MARK = 'xwow-favicon-badge';
const TARGET_FAVICON_BADGE_MARK = 'codex-favicon-badge';
const TARGET_FAVICON_BADGE_MARK_ATTR = 'data-codex-favicon-badge';

export function applyTabFaviconBadge(options = {}) {
  const badge = options.badge || null;
  if (!badge) {
    clearTabFaviconBadge();
    return { success: true, restored: true };
  }
  if (!['active', 'handoff', 'deliverable', 'unseen-handoff', 'unseen-deliverable'].includes(badge)) {
    return { success: false, error: `unsupported favicon badge: ${badge}` };
  }
  const preservedHref = document.querySelector('link[data-xwow-favicon-badge="true"]')?.dataset.xwowOriginalFaviconHref || '';
  const faviconHref = String(preservedHref || options.faviconDataUrl || options.faviconUrl || '').trim();
  if (!faviconHref) return { success: false, error: 'favicon badge requires faviconDataUrl' };
  clearTabFaviconBadge();
  const links = currentFaviconLinks();
  const targets = links.length ? links : [createFaviconLink()];
  for (const link of targets) {
    const originalHref = link.getAttribute('href');
    const createdByXwow = !links.length;
    link.href = buildBadgedFaviconDataUrl(badge, faviconHref);
    link.dataset.xwowFaviconBadge = 'true';
    link.dataset.xwowFaviconBadgeCreated = createdByXwow ? 'true' : 'false';
    if (originalHref) link.dataset.xwowOriginalFaviconHref = originalHref;
  }
  return { success: true, badge };
}

export function clearTabFaviconBadge() {
  for (const link of document.querySelectorAll('link[data-xwow-favicon-badge="true"]')) {
    const created = link.dataset.xwowFaviconBadgeCreated === 'true';
    const originalHref = link.dataset.xwowOriginalFaviconHref || '';
    delete link.dataset.xwowFaviconBadge;
    delete link.dataset.xwowFaviconBadgeCreated;
    delete link.dataset.xwowOriginalFaviconHref;
    if (created) {
      link.remove();
    } else if (originalHref) {
      link.href = originalHref;
    } else {
      link.removeAttribute('href');
    }
  }
}

function currentFaviconLinks() {
  return [...document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]')]
    .filter((link) => link.dataset.xwowFaviconBadge !== 'true');
}

function createFaviconLink() {
  const link = document.createElement('link');
  link.rel = 'icon';
  (document.head || document.documentElement).appendChild(link);
  return link;
}

function buildBadgedFaviconDataUrl(badge, faviconHref) {
  const normalizedBadge = normalizeBadgeKind(badge);
  const opacity = normalizedBadge === 'active' ? ' opacity="0.34"' : '';
  const marker = `${TARGET_FAVICON_BADGE_MARK_ATTR}="${TARGET_FAVICON_BADGE_MARK}" data-${XWOW_FAVICON_BADGE_MARK}="true"`;
  const overlay = faviconBadgeSvgOverlay(badge);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ${marker} width="32" height="32" viewBox="0 0 32 32"><image href="${escapeSvgAttribute(faviconHref)}" width="32" height="32"${opacity} />${overlay}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function faviconBadgeSvgOverlay(badge) {
  const normalizedBadge = normalizeBadgeKind(badge);
  if (normalizedBadge === 'active') {
    return '<path d="M3.045 4.453C2.758 3.603 3.603 2.758 4.453 3.045L14.183 6.334C15.164 6.666 15.087 8.08 14.072 8.39L10.299 9.543C9.939 9.653 9.653 9.939 9.543 10.299L8.39 14.072C8.08 15.087 6.666 15.164 6.334 14.183L3.045 4.453Z" fill="#071714" stroke="white" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke fill" transform="translate(-2 -2) scale(2.1)" />';
  }
  const fill = normalizedBadge === 'deliverable' ? '#22c55e' : '#facc15';
  const base = `<circle cx="24" cy="24" r="7" fill="${fill}" stroke="white" stroke-width="1.5" />`;
  if (!String(badge || '').startsWith('unseen-')) return base;
  return `<circle cx="24" cy="24" r="10" fill="none" stroke="#38bdf8" stroke-width="2" /><circle cx="24" cy="24" r="7" fill="${fill}" stroke="white" stroke-width="1.5" /><circle cx="29" cy="17" r="3" fill="#38bdf8" stroke="white" stroke-width="1" />`;
}

function normalizeBadgeKind(badge) {
  if (badge === 'unseen-deliverable') return 'deliverable';
  if (badge === 'unseen-handoff') return 'handoff';
  return badge;
}

function escapeSvgAttribute(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
