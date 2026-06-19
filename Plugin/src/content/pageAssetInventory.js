import { extractImages, extractLinks } from './domReader.js';
import { clampNumber, toAbsoluteUrl } from './domUtils.js';

export function readPageAssets(options = {}) {
  const imageLimit = clampNumber(options.maxImages || options.limit || 300, 1, 1000);
  const linkLimit = clampNumber(options.maxLinks || 500, 1, 2000);
  const mediaLimit = clampNumber(options.maxMedia || 100, 1, 500);
  const resourceLimit = clampNumber(options.maxResources || 200, 1, 1000);
  const images = extractImages(options).slice(0, imageLimit).map((image) => ({
    type: 'image',
    url: image.src,
    alt: image.alt,
    title: image.title,
    width: image.width,
    height: image.height,
  }));
  const links = extractLinks({ ...options, maxLinks: linkLimit }).map((link) => ({
    type: 'link',
    url: link.href,
    text: link.text,
    title: link.title,
  }));
  const videos = [...document.querySelectorAll('video,video source')]
    .map((node) => mediaAssetFromNode(node, 'video'))
    .filter(Boolean)
    .slice(0, mediaLimit);
  const audios = [...document.querySelectorAll('audio,audio source')]
    .map((node) => mediaAssetFromNode(node, 'audio'))
    .filter(Boolean)
    .slice(0, mediaLimit);
  const icons = [...document.querySelectorAll('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]')]
    .map((link) => iconAssetFromLink(link))
    .filter((asset) => asset.url)
    .slice(0, resourceLimit);
  const manifests = [...document.querySelectorAll('link[rel="manifest"]')]
    .map((link) => resourceAssetFromUrl('manifest', link.getAttribute('href') || '', { rel: link.getAttribute('rel') || '' }))
    .filter((asset) => asset.url)
    .slice(0, resourceLimit);
  const stylesheets = [...document.querySelectorAll('link[rel~="stylesheet"]')]
    .map((link) => resourceAssetFromUrl('stylesheet', link.getAttribute('href') || '', { media: link.getAttribute('media') || '' }))
    .filter((asset) => asset.url)
    .slice(0, resourceLimit);
  const scripts = [...document.scripts]
    .map((script) => resourceAssetFromUrl('script', script.getAttribute('src') || '', { async: script.async === true, defer: script.defer === true }))
    .filter((asset) => asset.url)
    .slice(0, resourceLimit);
  const inlineSvgs = [...document.querySelectorAll('svg')]
    .map((node, index) => inlineSvgFromNode(node, index))
    .filter(Boolean)
    .slice(0, resourceLimit);
  const byType = {
    images: uniqueAssets(images),
    links: uniqueAssets(links),
    videos: uniqueAssets(videos),
    audios: uniqueAssets(audios),
    icons: uniqueAssets(icons),
    manifests: uniqueAssets(manifests),
    stylesheets: uniqueAssets(stylesheets),
    scripts: uniqueAssets(scripts),
  };
  return {
    schemaVersion: 1,
    url: location.href,
    title: document.title || '',
    capturedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(byType).map(([key, value]) => [key, value.length])),
    inlineSvgs,
    ...byType,
  };
}

function mediaAssetFromNode(node, type) {
  const url = toAbsoluteUrl(node.currentSrc || node.src || node.getAttribute('src') || '');
  if (!url || url.startsWith('data:')) return null;
  return {
    type,
    url,
    mimeType: node.getAttribute('type') || '',
    title: node.getAttribute('title') || '',
  };
}

function iconAssetFromLink(link) {
  const href = link.dataset.xwowOriginalFaviconHref || link.getAttribute('href') || '';
  return resourceAssetFromUrl('icon', href, {
    rel: link.getAttribute('rel') || '',
    sizes: link.getAttribute('sizes') || '',
    mimeType: link.getAttribute('type') || '',
  });
}

function resourceAssetFromUrl(type, value, extra = {}) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('data:')) return { type, url: '', ...extra };
  return { type, url: toAbsoluteUrl(raw), ...extra };
}

function inlineSvgFromNode(node, index) {
  const markup = node.outerHTML || '';
  if (!markup) return null;
  const label = node.getAttribute('aria-label') || node.getAttribute('title') || node.id || `inline-svg-${index + 1}`;
  return {
    id: node.id || `inline-svg-${index + 1}`,
    name: label,
    markup,
  };
}

function uniqueAssets(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.type}:${item.url}`;
    if (!item.url || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
