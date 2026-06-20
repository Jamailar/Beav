const TARGET_OVERLAY_ROOT_ID = 'codex-agent-overlay-root';
const TARGET_OVERLAY_ROOT_DATASET = 'codexAgentOverlayRoot';
const CONTROL_BADGE_ID = 'xwow-browser-data-ai-control-badge';
const CONTROL_BADGE_STYLE_ID = 'xwow-browser-data-ai-control-badge-style';

export function applyControlledTabBadge(options = {}) {
  const state = normalizeBadgeState(options);
  if (!state.visible) {
    clearControlledTabBadge();
    return { success: true, visible: false };
  }
  const root = ensureOverlayRoot();
  ensureControlBadgeStyle();
  let badge = document.getElementById(CONTROL_BADGE_ID);
  if (!badge) {
    badge = document.createElement('div');
    badge.id = CONTROL_BADGE_ID;
    badge.className = 'codex-agent-control-badge';
    badge.setAttribute('aria-hidden', 'true');
    root.appendChild(badge);
  } else if (badge.parentElement !== root) {
    root.appendChild(badge);
  }
  badge.dataset.visible = 'true';
  badge.dataset.state = state.state;
  badge.dataset.origin = state.origin;
  badge.dataset.pageRole = state.pageRole;
  badge.textContent = state.label;
  if (state.title) badge.title = state.title;
  else badge.removeAttribute('title');
  return { success: true, visible: true, state: state.state };
}

export function clearControlledTabBadge() {
  const badge = document.getElementById(CONTROL_BADGE_ID);
  if (badge) badge.remove();
  return { success: true, visible: false };
}

function normalizeBadgeState(options = {}) {
  const state = String(options.state || 'active').trim() || 'active';
  const origin = String(options.origin || '').trim();
  const pageRole = String(options.pageRole || '').trim();
  const sessionName = String(options.sessionName || options.name || '').trim();
  const baseLabel = String(options.label || '').trim() || 'RedBox 控制中';
  const label = sessionName ? `${baseLabel} · ${sessionName}` : baseLabel;
  return {
    visible: options.visible !== false && options.badge !== false && state === 'active',
    state,
    origin,
    pageRole,
    label: label.slice(0, 40),
    title: sessionName ? `RedBox browser-control: ${sessionName}` : 'RedBox browser-control',
  };
}

function ensureOverlayRoot() {
  let root = document.getElementById(TARGET_OVERLAY_ROOT_ID);
  if (!(root instanceof HTMLDivElement) || root.dataset[TARGET_OVERLAY_ROOT_DATASET] !== 'true') {
    if (root?.parentNode) root.parentNode.removeChild(root);
    root = document.createElement('div');
    root.id = TARGET_OVERLAY_ROOT_ID;
    root.dataset[TARGET_OVERLAY_ROOT_DATASET] = 'true';
    root.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(root);
  }
  return root;
}

function ensureControlBadgeStyle() {
  if (document.getElementById(CONTROL_BADGE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CONTROL_BADGE_STYLE_ID;
  style.textContent = `
    #codex-agent-overlay-root {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
    }
    @media print { #codex-agent-overlay-root { display: none; } }
    #xwow-browser-data-ai-control-badge {
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 40;
      max-width: min(320px, calc(100vw - 24px));
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 9px;
      border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, .72);
      background: rgba(7, 17, 20, .88);
      color: #f7fffb;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .22), 0 0 0 1px rgba(78, 225, 193, .22);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      font-weight: 650;
      line-height: 16px;
      letter-spacing: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
      user-select: none;
      -webkit-user-select: none;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }
    #xwow-browser-data-ai-control-badge::before {
      content: "";
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: #4ee1c1;
      box-shadow: 0 0 0 3px rgba(78, 225, 193, .18), 0 0 12px rgba(78, 225, 193, .72);
    }
  `;
  document.documentElement.appendChild(style);
}
