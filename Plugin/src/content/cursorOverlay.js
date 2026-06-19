const XWOW_CURSOR_ARRIVED = 'xwow-data-ai:cursor-arrived';
const TARGET_CURSOR_ARRIVED = 'AGENT_CURSOR_ARRIVED';
const CURSOR_ASSET_PATH = 'images/cursor-chat.png';
const TARGET_OVERLAY_ROOT_ID = 'codex-agent-overlay-root';
const TARGET_OVERLAY_ROOT_DATASET = 'codexAgentOverlayRoot';
const LEGACY_CURSOR_ID = 'xwow-browser-data-ai-cursor';
const CURSOR_STYLE_ID = 'xwow-browser-data-ai-cursor-style';
const TARGET_CURSOR_PATH_CONFIG = {
  arcFlow: 0.5783555327868779,
  arcSize: 0.2765523188064277,
  boundsMargin: 20,
  candidateCount: 20,
  clickAngleDegrees: -44,
  endpointHandle: 0.15,
  startHandle: 0.41960295031576633,
};

let lastCursorState = null;
let cursorRepairObserver = null;
let cursorAnimationFrame = null;
let renderedCursorPoint = null;

export function moveAgentCursor(options = {}) {
  const x = Number(options.x);
  const y = Number(options.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { success: false, error: 'cursor requires finite x and y' };
  const cursor = ensureAgentCursor();
  const moveSequence = Number.isInteger(options.moveSequence) ? options.moveSequence : null;
  lastCursorState = {
    isVisible: true,
    x,
    y,
    label: String(options.label || 'RedBox').slice(0, 12),
    moveSequence,
    animateMovement: options.animateMovement !== false,
  };
  applyCursorDomState(cursor, lastCursorState, {
    animate: lastCursorState.animateMovement !== false,
    onComplete: () => notifyCursorArrived(moveSequence, options),
  });
  return { success: true, x, y, moveSequence };
}

export function applyAgentCursorState(state = {}) {
  if (state?.isVisible === false || state?.cursor?.visible === false) {
    return hideAgentCursor();
  }
  return moveAgentCursor({
    x: state.cursor?.x,
    y: state.cursor?.y,
    label: state.label || 'RedBox',
    moveSequence: state.cursor?.moveSequence,
    animateMovement: state.cursor?.animateMovement,
    sessionId: state.sessionId || '',
    turnId: state.turnId || '',
  });
}

export function hideAgentCursor() {
  const cursor = document.getElementById('xwow-browser-data-ai-cursor');
  lastCursorState = { ...(lastCursorState || {}), isVisible: false };
  cancelCursorMotion();
  if (cursor) cursor.dataset.visible = 'false';
  return { success: true };
}

function ensureAgentCursor() {
  ensureCursorRepairObserver();
  ensureAgentCursorStyle();
  const root = ensureTargetOverlayRoot();
  let cursor = document.getElementById(LEGACY_CURSOR_ID);
  if (cursor) {
    if (cursor.parentElement !== root) root.appendChild(cursor);
    if (lastCursorState) applyCursorDomState(cursor, lastCursorState, { animate: false });
    return cursor;
  }
  cursor = document.createElement('div');
  cursor.id = LEGACY_CURSOR_ID;
  cursor.className = 'codex-agent-overlay';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.dataset.visible = 'false';
  cursor.innerHTML = `
    <div data-xwow-cursor-shell>
      <img data-browser-agent-cursor-asset data-xwow-cursor-asset alt="" draggable="false" />
      <div data-xwow-cursor-dot></div>
    </div>
  `;
  const asset = cursor.querySelector('[data-xwow-cursor-asset]');
  if (asset) {
    asset.src = resolveCursorAssetUrl();
    asset.addEventListener('error', () => {
      cursor.dataset.assetLoaded = 'false';
    }, { once: true });
    asset.addEventListener('load', () => {
      cursor.dataset.assetLoaded = 'true';
    }, { once: true });
  }
  root.appendChild(cursor);
  if (lastCursorState) applyCursorDomState(cursor, lastCursorState, { animate: false });
  return cursor;
}

function ensureTargetOverlayRoot() {
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

function ensureAgentCursorStyle() {
  if (document.getElementById(CURSOR_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CURSOR_STYLE_ID;
  style.textContent = `
    #codex-agent-overlay-root {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
    }
    @media print { #codex-agent-overlay-root { display: none; } }
    #xwow-browser-data-ai-cursor {
      position: fixed;
      left: 0;
      top: 0;
      z-index: 20;
      pointer-events: none;
      transform: translate(-100px, -100px);
      transition: opacity 120ms ease-out;
      opacity: 0;
      will-change: transform, opacity, filter;
      transform-origin: 12px 12px;
    }
    #xwow-browser-data-ai-cursor[data-visible="true"] { opacity: 1; }
    #xwow-browser-data-ai-cursor [data-xwow-cursor-shell] {
      position: relative;
      width: 24px;
      height: 24px;
      transform: translate(-12px, -12px);
    }
    #xwow-browser-data-ai-cursor [data-xwow-cursor-asset] {
      display: block;
      width: 23px;
      height: 24px;
      transform: translate(12px, -2.5px) rotate(44deg);
      transform-origin: 0 0;
      filter: drop-shadow(0 0 6px rgba(51, 156, 255, .9)) drop-shadow(0 0 15px rgba(51, 156, 255, .48));
      user-select: none;
      -webkit-user-drag: none;
    }
    #xwow-browser-data-ai-cursor [data-xwow-cursor-dot] {
      width: 14px;
      height: 14px;
      border: 2px solid #071714;
      border-radius: 50%;
      background: #4ee1c1;
      box-shadow: 0 2px 10px rgba(0, 0, 0, .28);
      transform: translate(-7px, -7px);
      opacity: 0;
      position: absolute;
      left: 12px;
      top: 12px;
    }
    #xwow-browser-data-ai-cursor[data-asset-loaded="false"] [data-xwow-cursor-dot] {
      opacity: 1;
    }
  `;
  document.documentElement.appendChild(style);
}

function applyCursorDomState(cursor, state, options = {}) {
  if (!state) return;
  cursor.dataset.visible = state.isVisible === false ? 'false' : 'true';
  if (Number.isInteger(state.moveSequence)) cursor.dataset.moveSequence = String(state.moveSequence);
  if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) return;
  const to = clampPointToViewport({ x: Number(state.x), y: Number(state.y) });
  const from = renderedCursorPoint || to;
  const shouldAnimate = options.animate !== false && state.animateMovement !== false && distance(from, to) >= 0.5 && state.isVisible !== false;
  if (!shouldAnimate) {
    cancelCursorMotion();
    renderCursorPoint(cursor, to);
    renderedCursorPoint = to;
    cursor.dataset.motion = 'none';
    options.onComplete?.();
    return;
  }
  startCursorBezierSpringMotion(cursor, from, to, options.onComplete);
}

function startCursorBezierSpringMotion(cursor, from, to, onComplete) {
  cancelCursorMotion();
  const path = buildCursorBezierPath(from, to, viewportBounds());
  const duration = clamp(distance(from, to) * (path.durationScale || 1.15), 140, 620);
  const startedAt = now();
  cursor.dataset.motion = path.mode;
  cursor.dataset.motionSegments = String(path.segments?.length || 1);
  if (path.targetProfile) cursor.dataset.motionProfile = path.targetProfile;
  const tick = () => {
    const elapsed = now() - startedAt;
    const progress = clamp(elapsed / duration, 0, 1);
    const eased = springProgress(progress);
    const sample = sampleBezierPath(path, eased);
    renderCursorPoint(cursor, sample.point, sample.tangent, progress);
    renderedCursorPoint = sample.point;
    if (progress >= 1) {
      cursorAnimationFrame = null;
      renderCursorPoint(cursor, to, sample.tangent, 1);
      renderedCursorPoint = to;
      cursor.dataset.motion = 'arrived';
      onComplete?.();
      return;
    }
    cursorAnimationFrame = requestAnimationFrame(tick);
  };
  cursorAnimationFrame = requestAnimationFrame(tick);
}

function buildCursorBezierPath(from, to, bounds) {
  const config = TARGET_CURSOR_PATH_CONFIG;
  const length = Math.max(1, distance(from, to));
  const clickTangent = unitFromDegrees(config.clickAngleDegrees);
  const delta = { x: to.x - from.x, y: to.y - from.y };
  const travelTangent = normalize(delta);
  const startHandleDistance = clamp(length * config.startHandle, 48, Math.min(640, length * 0.9));
  const endHandleDistance = clamp(length * config.endpointHandle, 48, Math.min(640, length * 0.9));
  const startControl = boundedControlPoint(bounds, from, clickTangent, startHandleDistance, config.boundsMargin);
  const endControl = boundedControlPoint(bounds, to, { x: -clickTangent.x, y: -clickTangent.y }, endHandleDistance, config.boundsMargin);
  const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const normal = chooseNaturalArcNormal(travelTangent, clickTangent);
  const arcDistanceBase = clamp(length * config.arcSize, 50, 520);
  const arcHandleDistanceBase = clamp(length * config.arcFlow, 38, 440);
  const candidates = [
    oneSegmentPath(from, to, startControl, endControl),
    oneSegmentPath(
      from,
      to,
      boundedControlPoint(bounds, from, clickTangent, startHandleDistance * 0.65, config.boundsMargin),
      boundedControlPoint(bounds, to, { x: -clickTangent.x, y: -clickTangent.y }, endHandleDistance * 0.65, config.boundsMargin),
    ),
  ];
  for (const arcDistanceScale of [0.55, 0.8, 1.05]) {
    for (const arcHandleScale of [0.65, 1, 1.35]) {
      addArcCandidates({
        arcDistance: arcDistanceBase * arcDistanceScale,
        arcHandleDistance: arcHandleDistanceBase * arcHandleScale,
        bounds,
        clickTangent,
        candidates,
        end: to,
        endControl,
        midpoint,
        normal,
        start: from,
        startControl,
        travelTangent,
      });
    }
  }
  const ranked = candidates
    .slice(0, config.candidateCount)
    .map((candidate) => ({ candidate, metrics: cursorPathMetrics(candidate, bounds, config.boundsMargin) }))
    .sort((a, b) => cursorPathScore(a.candidate, a.metrics) - cursorPathScore(b.candidate, b.metrics));
  const inBounds = ranked.find((entry) => entry.metrics.staysInBounds);
  const selected = (inBounds || ranked[0])?.candidate || candidates[0];
  return {
    ...selected,
    mode: selected.segments.length > 1 ? 'target-bezier-arc-spring' : 'target-bezier-spring',
    targetProfile: 'hehggada-cursor-path-v1',
    durationScale: clamp(0.42 + cursorPathScore(selected, cursorPathMetrics(selected, bounds, config.boundsMargin)) / Math.max(1, length) * 0.08, 0.85, 1.45),
  };
}

function sampleBezierPath(path, progress) {
  const t = clamp(progress, 0, 1);
  const segments = path.segments || [{ control1: path.control1, control2: path.control2, end: path.to }];
  const scaled = t === 1 ? segments.length - 1 : t * segments.length;
  const index = Math.min(segments.length - 1, Math.floor(scaled));
  const segment = segments[index];
  const start = index === 0 ? path.from : segments[index - 1].end;
  const localT = t === 1 ? 1 : scaled - index;
  const point = cubicPoint(start, segment.control1, segment.control2, segment.end, localT);
  const tangent = cubicTangent(start, segment.control1, segment.control2, segment.end, localT);
  return { point, tangent };
}

function oneSegmentPath(from, to, control1, control2) {
  return {
    from,
    to,
    control1,
    control2,
    segments: [{ control1, control2, end: to }],
  };
}

function addArcCandidates(options) {
  buildArcCandidate(options, options.normal);
  buildArcCandidate(options, { x: -options.normal.x, y: -options.normal.y });
}

function buildArcCandidate({ arcDistance, arcHandleDistance, bounds, candidates, clickTangent, end, endControl, midpoint, normal, start, startControl, travelTangent }, arcNormal) {
  const arc = clampPointToBounds({
    x: midpoint.x + arcNormal.x * arcDistance + clickTangent.x * distance(start, startControl) * 0.16,
    y: midpoint.y + arcNormal.y * arcDistance + clickTangent.y * distance(start, startControl) * 0.16,
  }, bounds);
  const arcIn = clampPointToBounds({
    x: arc.x - travelTangent.x * arcHandleDistance,
    y: arc.y - travelTangent.y * arcHandleDistance,
  }, bounds);
  const arcOut = clampPointToBounds({
    x: arc.x + travelTangent.x * arcHandleDistance,
    y: arc.y + travelTangent.y * arcHandleDistance,
  }, bounds);
  candidates.push({
    from: start,
    to: end,
    arc,
    control1: startControl,
    control2: endControl,
    segments: [
      { control1: startControl, control2: arcIn, end: arc },
      { control1: arcOut, control2: endControl, end },
    ],
  });
}

function cursorPathMetrics(path, bounds, margin) {
  const segments = path.segments || [{ control1: path.control1, control2: path.control2, end: path.to }];
  let length = 0;
  let angleEnergy = 0;
  let totalTurn = 0;
  let maxAngleChange = 0;
  let lastAngle = null;
  let previousPoint = path.from;
  let segmentStart = path.from;
  let staysInBounds = pointInBounds(path.from, bounds, margin);
  for (const segment of segments) {
    for (let step = 1; step <= 24; step += 1) {
      const point = cubicPoint(segmentStart, segment.control1, segment.control2, segment.end, step / 24);
      staysInBounds = staysInBounds && pointInBounds(point, bounds, margin);
      const vector = { x: point.x - previousPoint.x, y: point.y - previousPoint.y };
      length += distance(previousPoint, point);
      if (distance({ x: 0, y: 0 }, vector) > 0.01) {
        const angle = Math.atan2(vector.y, vector.x);
        if (lastAngle != null) {
          const change = shortestAngleDelta(lastAngle, angle);
          angleEnergy += change * change;
          totalTurn += Math.abs(change);
          maxAngleChange = Math.max(maxAngleChange, Math.abs(change));
        }
        lastAngle = angle;
      }
      previousPoint = point;
    }
    segmentStart = segment.end;
  }
  return { angleEnergy, length, maxAngleChange, staysInBounds, totalTurn };
}

function cursorPathScore(path, metrics) {
  const direct = Math.max(1, distance(path.from, path.to));
  const lengthPenalty = Math.max(0, metrics.length / direct - 1) * 320;
  const arcPenalty = path.arc ? 45 : 0;
  return metrics.length + lengthPenalty + metrics.angleEnergy * 140 + metrics.maxAngleChange * 180 + metrics.totalTurn * 18 + arcPenalty;
}

function chooseNaturalArcNormal(travelTangent, clickTangent) {
  const normal = { x: -travelTangent.y, y: travelTangent.x };
  const direction = normal.x * clickTangent.x + normal.y * clickTangent.y >= 0 ? 1 : -1;
  return { x: normal.x * direction, y: normal.y * direction };
}

function boundedControlPoint(bounds, point, tangent, distanceValue, margin = 0) {
  const safeBounds = {
    width: Math.max(1, bounds.width - margin),
    height: Math.max(1, bounds.height - margin),
  };
  const safePoint = {
    x: clamp(point.x, margin, safeBounds.width),
    y: clamp(point.y, margin, safeBounds.height),
  };
  let scaled = Math.max(0, distanceValue);
  if (tangent.x < 0) scaled = Math.min(scaled, (safePoint.x - margin) / -tangent.x);
  if (tangent.x > 0) scaled = Math.min(scaled, (safeBounds.width - safePoint.x) / tangent.x);
  if (tangent.y < 0) scaled = Math.min(scaled, (safePoint.y - margin) / -tangent.y);
  if (tangent.y > 0) scaled = Math.min(scaled, (safeBounds.height - safePoint.y) / tangent.y);
  return {
    x: safePoint.x + tangent.x * Math.max(0, scaled),
    y: safePoint.y + tangent.y * Math.max(0, scaled),
  };
}

function cubicPoint(a, b, c, d, t) {
  const inv = 1 - t;
  return {
    x: inv ** 3 * a.x + 3 * inv ** 2 * t * b.x + 3 * inv * t ** 2 * c.x + t ** 3 * d.x,
    y: inv ** 3 * a.y + 3 * inv ** 2 * t * b.y + 3 * inv * t ** 2 * c.y + t ** 3 * d.y,
  };
}

function cubicTangent(a, b, c, d, t) {
  const inv = 1 - t;
  return {
    x: 3 * inv ** 2 * (b.x - a.x) + 6 * inv * t * (c.x - b.x) + 3 * t ** 2 * (d.x - c.x),
    y: 3 * inv ** 2 * (b.y - a.y) + 6 * inv * t * (c.y - b.y) + 3 * t ** 2 * (d.y - c.y),
  };
}

function renderCursorPoint(cursor, point, tangent = { x: 1, y: 0 }, progress = 1) {
  const angle = Number.isFinite(tangent.x) && Number.isFinite(tangent.y)
    ? Math.atan2(tangent.y, tangent.x) * 180 / Math.PI
    : 0;
  const stretch = 1 + Math.sin(clamp(progress, 0, 1) * Math.PI) * 0.08;
  cursor.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) rotate(${round(angle)}deg) scale(${round(stretch)}, ${round(1 / stretch)})`;
}

function cancelCursorMotion() {
  if (cursorAnimationFrame != null) {
    cancelAnimationFrame(cursorAnimationFrame);
    cursorAnimationFrame = null;
  }
}

function springProgress(progress) {
  const t = clamp(progress, 0, 1);
  const value = 1 - Math.exp(-6 * t) * Math.cos(8 * t);
  return clamp(value, 0, 1);
}

function viewportBounds() {
  return {
    width: Math.max(1, window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth || 1),
    height: Math.max(1, window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 1),
  };
}

function clampPointToViewport(point) {
  return clampPointToBounds(point, viewportBounds());
}

function clampPointToBounds(point, bounds) {
  return {
    x: clamp(Number(point.x), 0, Math.max(0, bounds.width - 1)),
    y: clamp(Number(point.y), 0, Math.max(0, bounds.height - 1)),
  };
}

function normalize(vector) {
  const len = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
  if (!Number.isFinite(len) || len < 0.001) return { x: 1, y: 0 };
  return { x: vector.x / len, y: vector.y / len };
}

function unitFromDegrees(degrees) {
  const radians = Number(degrees || 0) * Math.PI / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

function distance(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function pointInBounds(point, bounds, margin = 0) {
  return point.x >= margin
    && point.x <= bounds.width - margin
    && point.y >= margin
    && point.y <= bounds.height - margin;
}

function shortestAngleDelta(from, to) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function resolveCursorAssetUrl() {
  try {
    return chrome.runtime.getURL(CURSOR_ASSET_PATH);
  } catch {
    return CURSOR_ASSET_PATH;
  }
}

function ensureCursorRepairObserver() {
  if (cursorRepairObserver) return;
  cursorRepairObserver = new MutationObserver(() => {
    if (lastCursorState?.isVisible === false) return;
    if (!document.documentElement) return;
    const root = document.getElementById(TARGET_OVERLAY_ROOT_ID);
    const cursor = document.getElementById(LEGACY_CURSOR_ID);
    const style = document.getElementById(CURSOR_STYLE_ID);
    if (root && cursor && style) return;
    ensureAgentCursor();
  });
  cursorRepairObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function notifyCursorArrived(moveSequence, options = {}) {
  if (!Number.isInteger(moveSequence)) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chrome.runtime.sendMessage({
        type: XWOW_CURSOR_ARRIVED,
        moveSequence,
        frameUrl: location.href,
      }).catch(() => {});
      if (options.sessionId && options.turnId) {
        chrome.runtime.sendMessage({
          type: TARGET_CURSOR_ARRIVED,
          moveSequence,
          sessionId: options.sessionId,
          turnId: options.turnId,
          frameUrl: location.href,
        }).catch(() => {});
      }
    });
  });
}
