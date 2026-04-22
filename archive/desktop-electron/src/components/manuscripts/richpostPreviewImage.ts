import { toPng } from 'html-to-image';

const RICHPOST_FONT_SCALE_MIN = 0.8;
const RICHPOST_FONT_SCALE_MAX = 1.6;
const RICHPOST_LINE_HEIGHT_SCALE_MIN = 0.8;
const RICHPOST_LINE_HEIGHT_SCALE_MAX = 1.4;
export const RICHPOST_RENDER_VIEWPORT_WIDTH = 560;
export const RICHPOST_RENDER_VIEWPORT_HEIGHT = RICHPOST_RENDER_VIEWPORT_WIDTH * 4 / 3;

export type RichpostZoneLayoutInspection = {
  widthPx: number;
  heightPx: number;
  scrollWidthPx: number;
  scrollHeightPx: number;
  overflowX: boolean;
  overflowY: boolean;
  font: string;
  lineHeightPx: number;
  paragraphFont: string;
  paragraphLineHeightPx: number;
  contentBottomPx: number;
  frameBottomPx: number;
  zoneTopPx: number;
  availableHeightPx: number;
};

export type RichpostLayoutInspection = {
  title: RichpostZoneLayoutInspection | null;
  body: RichpostZoneLayoutInspection | null;
};

function clampScale(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Number(value)));
}

function extractUrlValue(raw: string): string | null {
  const match = raw.match(/^url\((['"]?)(.+)\1\)$/i);
  const source = match?.[2]?.trim();
  if (!source || source === 'none') return null;
  return source;
}

function serializeRichpostHtml(doc: Document): string {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function materializeRichpostBackgroundInHtml(html: string): string {
  if (!html.trim()) return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const host = doc.querySelector('.rb-page-host') as HTMLElement | null;
  const backgroundZone = doc.querySelector('.rb-zone-background') as HTMLElement | null;
  if (!host || !backgroundZone) return html;
  if (backgroundZone.querySelector('[data-richpost-export-bg="true"]')) {
    return serializeRichpostHtml(doc);
  }
  const styleAttr = host.getAttribute('style') || '';
  const match = styleAttr.match(/--rb-background-image\s*:\s*url\((['"]?)(.+?)\1\)\s*;/i);
  const source = match?.[2]?.trim();
  if (!source || source === 'none') {
    return html;
  }
  const img = doc.createElement('img');
  img.setAttribute('data-richpost-export-bg', 'true');
  img.alt = '';
  img.src = source;
  backgroundZone.setAttribute('style', 'background-image:none;');
  backgroundZone.replaceChildren(img);
  return serializeRichpostHtml(doc);
}

function buildCanvasFont(style: CSSStyleDeclaration | null | undefined): string {
  if (!style) return '400 16px sans-serif';
  const fontStyle = style.fontStyle && style.fontStyle !== 'normal' ? `${style.fontStyle} ` : '';
  const fontVariant = style.fontVariant && style.fontVariant !== 'normal' ? `${style.fontVariant} ` : '';
  const fontWeight = style.fontWeight || '400';
  const fontSize = style.fontSize || '16px';
  const fontFamily = style.fontFamily || 'sans-serif';
  return `${fontStyle}${fontVariant}${fontWeight} ${fontSize} ${fontFamily}`.replace(/\s+/g, ' ').trim();
}

function parseLineHeightPx(style: CSSStyleDeclaration | null | undefined): number {
  if (!style) return 24;
  const explicit = Number.parseFloat(style.lineHeight || '');
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const fontSize = Number.parseFloat(style.fontSize || '');
  if (Number.isFinite(fontSize) && fontSize > 0) {
    return fontSize * 1.6;
  }
  return 24;
}

function inspectZoneContentBottom(zone: HTMLElement): number {
  const candidates = Array.from(zone.querySelectorAll<HTMLElement>('.rb-block, .page-asset, p, ul, ol, table, blockquote, hr'))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0.5 || rect.width > 0.5;
    });
  if (candidates.length === 0) {
    return zone.getBoundingClientRect().bottom;
  }
  return candidates.reduce((bottom, node) => Math.max(bottom, node.getBoundingClientRect().bottom), zone.getBoundingClientRect().bottom);
}

function inspectZoneLayout(
  zone: HTMLElement | null,
  paragraphSelector: string,
  frame: HTMLElement | null,
): RichpostZoneLayoutInspection | null {
  if (!zone) return null;
  const view = zone.ownerDocument.defaultView || window;
  const zoneStyle = view.getComputedStyle(zone);
  const paragraph = zone.querySelector(paragraphSelector) as HTMLElement | null;
  const paragraphStyle = paragraph ? view.getComputedStyle(paragraph) : zoneStyle;
  const zoneRect = zone.getBoundingClientRect();
  const frameRect = frame?.getBoundingClientRect() || zoneRect;
  const contentBottomPx = inspectZoneContentBottom(zone);
  const widthPx = Math.max(zone.clientWidth, Math.round(zoneRect.width));
  const heightPx = Math.max(zone.clientHeight, Math.round(zoneRect.height));
  const scrollWidthPx = Math.max(zone.scrollWidth, widthPx);
  const scrollHeightPx = Math.max(zone.scrollHeight, heightPx);
  const availableHeightPx = Math.max(0, frameRect.bottom - zoneRect.top);
  return {
    widthPx,
    heightPx,
    scrollWidthPx,
    scrollHeightPx,
    overflowX: scrollWidthPx > widthPx + 1,
    overflowY: contentBottomPx > frameRect.bottom + 1,
    font: buildCanvasFont(zoneStyle),
    lineHeightPx: parseLineHeightPx(zoneStyle),
    paragraphFont: buildCanvasFont(paragraphStyle),
    paragraphLineHeightPx: parseLineHeightPx(paragraphStyle),
    contentBottomPx,
    frameBottomPx: frameRect.bottom,
    zoneTopPx: zoneRect.top,
    availableHeightPx,
  };
}

export function injectRichpostPreviewScale(
  html: string,
  fontScale?: number,
  lineHeightScale?: number
): string {
  if (!html.trim()) return html;
  if (fontScale == null && lineHeightScale == null) return html;
  const normalizedFontScale = clampScale(
    fontScale ?? 1,
    RICHPOST_FONT_SCALE_MIN,
    RICHPOST_FONT_SCALE_MAX
  );
  const normalizedLineHeightScale = clampScale(
    lineHeightScale ?? 1,
    RICHPOST_LINE_HEIGHT_SCALE_MIN,
    RICHPOST_LINE_HEIGHT_SCALE_MAX
  );
  const scaleScript = `<script>(()=>{const apply=()=>{document.documentElement.style.setProperty('--rb-font-scale','${normalizedFontScale}');document.documentElement.style.setProperty('--rb-line-height-scale','${normalizedLineHeightScale}');const host=document.querySelector('.rb-page-host');if(!host)return;const computed=window.getComputedStyle(host);const rawBase=Number.parseFloat((computed.getPropertyValue('--rb-body-line-height')||'').trim()||'1.9');const base=Number.isFinite(rawBase)?rawBase:1.9;host.style.setProperty('--rb-runtime-body-line-height',String((base*${normalizedLineHeightScale}).toFixed(3)));};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',apply,{once:true});}else{apply();}})();</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${scaleScript}</body>`);
  }
  return `${html}${scaleScript}`;
}

type RichpostPngRenderOptions = {
  width?: number;
  height?: number;
  viewportWidth?: number;
  viewportHeight?: number;
};

async function waitForIframeContentReady(frame: HTMLIFrameElement): Promise<Document> {
  const doc = await new Promise<Document>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('导出页加载超时'));
    }, 15000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      frame.removeEventListener('load', handleLoad);
      frame.removeEventListener('error', handleError);
    };
    const handleLoad = () => {
      cleanup();
      if (!frame.contentDocument) {
        reject(new Error('导出页加载失败'));
        return;
      }
      resolve(frame.contentDocument);
    };
    const handleError = () => {
      cleanup();
      reject(new Error('导出页加载失败'));
    };
    frame.addEventListener('load', handleLoad, { once: true });
    frame.addEventListener('error', handleError, { once: true });
  });

  const fonts = (doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    await fonts.ready.catch(() => undefined);
  }
  await Promise.all(
    Array.from(doc.images).map((image) => (
      image.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const done = () => resolve();
            image.addEventListener('load', done, { once: true });
            image.addEventListener('error', done, { once: true });
          })
    ))
  );
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  return doc;
}

function extractRichpostBackgroundSource(doc: Document): string | null {
  const backgroundZone = doc.querySelector('.rb-zone-background') as HTMLElement | null;
  const existingImage = backgroundZone?.querySelector('img') as HTMLImageElement | null;
  if (existingImage?.src) {
    return existingImage.src;
  }
  const computed = backgroundZone ? doc.defaultView?.getComputedStyle(backgroundZone) : null;
  const computedSource = extractUrlValue(computed?.backgroundImage || '');
  if (computedSource) {
    return computedSource;
  }
  const host = doc.querySelector('.rb-page-host') as HTMLElement | null;
  const styleAttr = host?.getAttribute('style') || '';
  const styleMatch = styleAttr.match(/--rb-background-image\s*:\s*url\((['"]?)(.+?)\1\)\s*;/i);
  return styleMatch?.[2]?.trim() || null;
}

async function loadImage(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
  if ('decode' in image) {
    try {
      await image.decode();
      return image;
    } catch {
      // fall through to standard load listeners
    }
  }
  await new Promise<void>((resolve, reject) => {
    if (image.complete) {
      resolve();
      return;
    }
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => reject(new Error('图片资源加载失败')), { once: true });
  });
  return image;
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number
) {
  const sourceWidth = (image as { width?: number }).width || width;
  const sourceHeight = (image as { height?: number }).height || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;
  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

async function composeRichpostExportLayers(
  backgroundSource: string,
  foregroundDataUrl: string,
  width: number,
  height: number
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('无法创建导出画布');
  }
  context.clearRect(0, 0, width, height);
  const backgroundImage = await loadImage(backgroundSource);
  drawImageCover(context, backgroundImage, width, height);
  const foregroundImage = await loadImage(foregroundDataUrl);
  context.drawImage(foregroundImage, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

async function materializeRichpostBackgroundImage(doc: Document): Promise<void> {
  const host = doc.querySelector('.rb-page-host') as HTMLElement | null;
  const backgroundZone = doc.querySelector('.rb-zone-background') as HTMLElement | null;
  if (!host || !backgroundZone) return;
  if (backgroundZone.querySelector('[data-richpost-export-bg="true"]')) return;
  const computed = doc.defaultView?.getComputedStyle(backgroundZone);
  const source = extractUrlValue(computed?.backgroundImage || '');
  if (!source || source === 'none') return;

  const img = doc.createElement('img');
  img.setAttribute('data-richpost-export-bg', 'true');
  img.alt = '';
  img.decoding = 'async';
  img.src = source;
  Object.assign(img.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'center',
    zIndex: '0',
    pointerEvents: 'none',
  });
  backgroundZone.style.backgroundImage = 'none';
  backgroundZone.prepend(img);
  if ('decode' in img) {
    try {
      await img.decode();
      return;
    } catch {
      // fall through to load/error listeners
    }
  }
  await new Promise<void>((resolve) => {
    if (img.complete) {
      resolve();
      return;
    }
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  });
}

async function renderRichpostFrameToPng(
  frame: HTMLIFrameElement,
  options?: RichpostPngRenderOptions
): Promise<string> {
  const doc = await waitForIframeContentReady(frame);
  await materializeRichpostBackgroundImage(doc);
  const backgroundSource = extractRichpostBackgroundSource(doc);
  const target = (
    doc.querySelector('.rb-stage')
    || doc.querySelector('.rb-page-host')
    || doc.querySelector('.page')
    || doc.body
  ) as HTMLElement | null;
  if (!target) {
    throw new Error('未找到可导出的页面内容');
  }
  const rect = target.getBoundingClientRect();
  const targetWidth = Math.max(1, Math.round(rect.width || target.clientWidth || frame.clientWidth || RICHPOST_RENDER_VIEWPORT_WIDTH));
  const targetHeight = Math.max(1, Math.round(rect.height || target.clientHeight || frame.clientHeight || RICHPOST_RENDER_VIEWPORT_HEIGHT));
  const outputWidth = Math.max(1, Math.round(Number(options?.width) || targetWidth));
  const outputHeight = Math.max(1, Math.round(Number(options?.height) || targetHeight));
  const pixelRatio = Math.max(
    1,
    Math.min(
      outputWidth / targetWidth,
      outputHeight / targetHeight,
    ),
  );
  if (backgroundSource) {
    const root = doc.documentElement as HTMLElement | null;
    const body = doc.body as HTMLElement | null;
    const host = doc.querySelector('.rb-page-host') as HTMLElement | null;
    const backgroundZone = doc.querySelector('.rb-zone-background') as HTMLElement | null;
    if (root) root.style.background = 'transparent';
    if (body) body.style.background = 'transparent';
    if (host) host.style.background = 'transparent';
    if (backgroundZone) {
      backgroundZone.style.backgroundImage = 'none';
      backgroundZone.replaceChildren();
    }
  }
  const foregroundDataUrl = await toPng(target, {
    cacheBust: true,
    pixelRatio,
    width: targetWidth,
    height: targetHeight,
    ...(backgroundSource ? {} : { backgroundColor: '#ffffff' }),
  });
  if (!backgroundSource) {
    return foregroundDataUrl;
  }
  return await composeRichpostExportLayers(backgroundSource, foregroundDataUrl, outputWidth, outputHeight);
}

export async function inspectRichpostHtmlLayout(
  html: string,
  options?: {
    viewportWidth?: number;
    viewportHeight?: number;
  }
): Promise<RichpostLayoutInspection> {
  const viewportWidth = Math.max(
    1,
    Number.isFinite(Number(options?.viewportWidth))
      ? Number(options?.viewportWidth)
      : RICHPOST_RENDER_VIEWPORT_WIDTH
  );
  const viewportHeight = Math.max(
    1,
    Number.isFinite(Number(options?.viewportHeight))
      ? Number(options?.viewportHeight)
      : RICHPOST_RENDER_VIEWPORT_HEIGHT
  );
  const frame = document.createElement('iframe');
  frame.srcdoc = materializeRichpostBackgroundInHtml(html);
  frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox');
  frame.style.position = 'fixed';
  frame.style.left = '-20000px';
  frame.style.top = '0';
  frame.style.width = `${viewportWidth}px`;
  frame.style.height = `${viewportHeight}px`;
  frame.style.border = '0';
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';
  frame.style.background = '#ffffff';
  document.body.appendChild(frame);
  try {
    const doc = await waitForIframeContentReady(frame);
    const stageFrame = doc.querySelector('.rb-stage-frame') as HTMLElement | null;
    const titleZone = doc.querySelector('.rb-zone-title') as HTMLElement | null;
    const bodyZone = doc.querySelector('.rb-zone-body') as HTMLElement | null;
    return {
      title: inspectZoneLayout(titleZone, '.rb-block.rb-heading h1, .rb-block.rb-heading h2, .rb-block.rb-heading h3, .rb-block.rb-heading h4, .rb-block.rb-heading h5, .rb-block.rb-heading h6', stageFrame),
      body: inspectZoneLayout(bodyZone, '.rb-block.rb-paragraph p, .rb-block.rb-paragraph', stageFrame),
    };
  } finally {
    frame.remove();
  }
}

export async function loadRichpostPreviewHtml(
  readPath: string,
  options?: {
    fontScale?: number;
    lineHeightScale?: number;
    errorLabel?: string;
  }
): Promise<string> {
  const result = await window.ipcRenderer.invoke('manuscripts:read', readPath) as { content?: string };
  const html = String(result?.content || '');
  if (!html.trim()) {
    throw new Error(options?.errorLabel || '图文页面 HTML 为空');
  }
  return injectRichpostPreviewScale(
    materializeRichpostBackgroundInHtml(html),
    options?.fontScale,
    options?.lineHeightScale
  );
}

export async function renderRichpostPageUrlToPng(
  sourceUrl: string,
  pageId: string,
  options?: RichpostPngRenderOptions
): Promise<string> {
  void pageId;
  if (!String(sourceUrl || '').trim()) {
    throw new Error('图文预览页地址为空');
  }
  const viewportWidth = Math.max(
    1,
    Number.isFinite(Number(options?.viewportWidth))
      ? Number(options?.viewportWidth)
      : RICHPOST_RENDER_VIEWPORT_WIDTH
  );
  const viewportHeight = Math.max(
    1,
    Number.isFinite(Number(options?.viewportHeight))
      ? Number(options?.viewportHeight)
      : RICHPOST_RENDER_VIEWPORT_HEIGHT
  );
  const frame = document.createElement('iframe');
  frame.src = sourceUrl;
  frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox');
  frame.style.position = 'fixed';
  frame.style.left = '-20000px';
  frame.style.top = '0';
  frame.style.width = `${viewportWidth}px`;
  frame.style.height = `${viewportHeight}px`;
  frame.style.border = '0';
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';
  frame.style.background = '#ffffff';
  document.body.appendChild(frame);
  try {
    return await renderRichpostFrameToPng(frame, options);
  } finally {
    frame.remove();
  }
}

export async function renderRichpostHtmlToPng(
  html: string,
  pageId: string,
  options?: RichpostPngRenderOptions
): Promise<string> {
  void pageId;
  const viewportWidth = Math.max(
    1,
    Number.isFinite(Number(options?.viewportWidth))
      ? Number(options?.viewportWidth)
      : RICHPOST_RENDER_VIEWPORT_WIDTH
  );
  const viewportHeight = Math.max(
    1,
    Number.isFinite(Number(options?.viewportHeight))
      ? Number(options?.viewportHeight)
      : RICHPOST_RENDER_VIEWPORT_HEIGHT
  );
  const frame = document.createElement('iframe');
  frame.srcdoc = materializeRichpostBackgroundInHtml(html);
  frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox');
  frame.style.position = 'fixed';
  frame.style.left = '-20000px';
  frame.style.top = '0';
  frame.style.width = `${viewportWidth}px`;
  frame.style.height = `${viewportHeight}px`;
  frame.style.border = '0';
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';
  frame.style.background = '#ffffff';
  document.body.appendChild(frame);
  try {
    return await renderRichpostFrameToPng(frame, options);
  } finally {
    frame.remove();
  }
}
