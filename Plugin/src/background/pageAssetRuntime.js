import { sendContentMessage } from './dynamicContentInjection.js';

export const CONTENT_PAGE_ASSETS_TYPE = 'xwow-data-ai:page-assets';
const TARGET_PAGE_ASSET_KINDS = ['font', 'image', 'script', 'stylesheet', 'video', 'other'];
export const ASSET_LIBRARY_REGISTRATION_SCHEMA_VERSION = 1;

export async function readPageAssetInventory(tabId, options = {}) {
  const result = await sendContentMessage(Number(tabId), CONTENT_PAGE_ASSETS_TYPE, options, options.frameId || 0);
  const inventory = result?.response?.assets || result?.assets || {};
  const targetInventory = buildTargetPageAssetInventory(inventory);
  return {
    ...result,
    targetInventory,
    id: targetInventory.id,
    assets: targetInventory.assets,
    inlineSvgs: targetInventory.inlineSvgs,
    pageUrl: targetInventory.pageUrl,
    summary: targetInventory.summary,
  };
}

export async function bundlePageAssets(tabId, action = {}) {
  const maxAssets = clamp(Number(action.maxAssets || 20), 1, 100);
  const maxAssetBytes = clamp(Number(action.maxAssetBytes || 512 * 1024), 1024, 5 * 1024 * 1024);
  const maxTotalBytes = clamp(Number(action.maxTotalBytes || 2 * 1024 * 1024), 1024, 20 * 1024 * 1024);
  const includeDataUrl = action.includeDataUrl === true;
  const artifactBinding = buildArtifactBinding(action);
  const inventoryResponse = action.inventory
    ? { success: true, response: { assets: action.inventory } }
    : await readPageAssetInventory(tabId, action);
  const inventory = inventoryResponse?.response?.assets || inventoryResponse?.assets || {};
  const targetInventory = buildTargetPageAssetInventory(inventory);
  const candidates = flattenAssetInventory(inventory, action)
    .filter((asset) => /^https?:\/\//i.test(asset.url))
    .slice(0, maxAssets);
  const bundled = [];
  const skipped = [];
  let totalBytes = 0;
  for (const asset of candidates) {
    if (totalBytes >= maxTotalBytes) {
      skipped.push({ asset, reason: 'max_total_bytes_reached' });
      continue;
    }
    const remainingBytes = Math.max(0, maxTotalBytes - totalBytes);
    const maxBytes = Math.min(maxAssetBytes, remainingBytes);
    const fetched = await fetchAsset(asset, maxBytes, includeDataUrl, Number(action.timeoutMs || 8000), artifactBinding);
    if (fetched.success) {
      totalBytes += fetched.byteSize;
      bundled.push(fetched);
    } else {
      skipped.push({ asset, reason: fetched.error || 'fetch_failed' });
    }
  }
  const targetBundle = buildTargetPageAssetBundle(targetInventory, bundled, skipped, action);
  const assetLibraryRegistration = buildAssetLibraryRegistrationManifest(targetInventory, targetBundle, bundled, artifactBinding);
  return {
    success: true,
    directoryPath: targetBundle.directoryPath,
    manifestPath: targetBundle.manifestPath,
    assets: targetBundle.assets,
    failures: targetBundle.failures,
    summary: targetBundle.summary,
    assetLibraryRegistration,
    targetBundle,
    bundle: {
      schemaVersion: 1,
      artifactBindingSchemaVersion: 1,
      assetLibraryRegistrationSchemaVersion: ASSET_LIBRARY_REGISTRATION_SCHEMA_VERSION,
      inventoryId: targetInventory.id,
      pageUrl: inventory.url || '',
      title: inventory.title || '',
      createdAt: new Date().toISOString(),
      artifactBinding,
      assetLibraryRegistration,
      sourceCounts: inventory.counts || {},
      limits: { maxAssets, maxAssetBytes, maxTotalBytes, includeDataUrl },
      totalBytes,
      assetCount: bundled.length,
      skippedCount: skipped.length,
      assets: bundled,
      skipped,
    },
  };
}

function buildAssetLibraryRegistrationManifest(targetInventory = {}, targetBundle = {}, bundled = [], artifactBinding = {}) {
  const entries = bundled.map((asset) => ({
    artifactId: asset.artifactId,
    filename: asset.filename,
    library: asset.suggestedLibrary || 'asset',
    sourceUrl: asset.url,
    pageUrl: targetInventory.pageUrl || '',
    inventoryId: targetInventory.id || '',
    bundleDirectoryPath: targetBundle.directoryPath || '',
    bundleManifestPath: targetBundle.manifestPath || '',
    mimeType: asset.mimeType || '',
    byteSize: Number(asset.byteSize || 0),
    sha256: asset.sha256 || '',
    title: asset.title || '',
    kind: targetKindFromGroup(asset.group, asset.type),
    group: asset.group || '',
    role: artifactBinding.pageRole || '',
    jobId: artifactBinding.jobId || '',
    storeId: artifactBinding.storeId || '',
    sessionId: artifactBinding.sessionId || '',
    turnId: artifactBinding.turnId || '',
    source: artifactBinding.source || 'browser_page_asset_bundle',
  }));
  return {
    schemaVersion: ASSET_LIBRARY_REGISTRATION_SCHEMA_VERSION,
    source: 'browser_page_asset_bundle',
    binding: artifactBinding,
    inventoryId: targetInventory.id || '',
    pageUrl: targetInventory.pageUrl || '',
    directoryPath: targetBundle.directoryPath || '',
    manifestPath: targetBundle.manifestPath || '',
    entryCount: entries.length,
    libraries: countBy(entries, 'library'),
    entries,
  };
}

function flattenAssetInventory(inventory = {}, action = {}) {
  const allowedTypes = new Set(normalizeTypeList(action.types || ['images', 'icons', 'manifests', 'stylesheets', 'scripts']));
  const assetIds = new Set(normalizeStringList(action.assetIds || action.asset_ids || []));
  const entries = [];
  for (const [group, assets] of Object.entries(inventory)) {
    if (!Array.isArray(assets) || !allowedTypes.has(group)) continue;
    for (const [index, asset] of assets.entries()) {
      if (!asset?.url) continue;
      const id = buildTargetAssetId(group, asset.url, index);
      if (assetIds.size && !assetIds.has(id) && !assetIds.has(String(asset.id || ''))) continue;
      entries.push({
        id,
        group,
        type: asset.type || singularizeGroup(group),
        url: asset.url,
        title: asset.title || asset.text || '',
        mimeType: asset.mimeType || '',
        width: asset.width || 0,
        height: asset.height || 0,
      });
    }
  }
  return uniqueAssetUrls(entries);
}

async function fetchAsset(asset, maxBytes, includeDataUrl, timeoutMs, artifactBinding = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), clamp(timeoutMs, 500, 30_000));
  try {
    const response = await fetch(asset.url, {
      cache: 'force-cache',
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) return { success: false, error: 'asset_too_large' };
    if (!response.ok) return { success: false, error: `http_${response.status}` };
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return { success: false, error: 'asset_too_large' };
    const contentType = response.headers.get('content-type') || asset.mimeType || '';
    const sha256 = await sha256Hex(buffer);
    const filename = buildArtifactFilename(asset, contentType, sha256);
    const artifactId = buildArtifactId(artifactBinding, sha256);
    const out = {
      success: true,
      artifactId,
      id: asset.id || artifactId,
      filename,
      suggestedLibrary: inferSuggestedLibrary(asset, contentType),
      group: asset.group,
      type: asset.type,
      url: asset.url,
      title: asset.title,
      mimeType: contentType,
      byteSize: buffer.byteLength,
      sha256,
      width: asset.width,
      height: asset.height,
      binding: {
        ...artifactBinding,
        artifactId,
        filename,
        sourceUrl: asset.url,
      },
    };
    if (includeDataUrl) out.dataUrl = `data:${contentType || 'application/octet-stream'};base64,${arrayBufferToBase64(buffer)}`;
    return out;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function normalizeTypeList(types) {
  return normalizeStringList(types)
    .map((item) => normalizeAssetTypeName(item))
    .filter(Boolean);
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list.map((item) => String(item || '').trim()).filter(Boolean);
}

function uniqueAssetUrls(assets) {
  const seen = new Set();
  const out = [];
  for (const asset of assets) {
    if (seen.has(asset.url)) continue;
    seen.add(asset.url);
    out.push(asset);
  }
  return out;
}

function singularizeGroup(group) {
  return String(group || '').replace(/s$/, '') || 'asset';
}

function buildArtifactBinding(action = {}) {
  const binding = action.artifactBinding || action.binding || {};
  return {
    sessionId: String(action.sessionId || binding.sessionId || ''),
    turnId: String(action.turnId || binding.turnId || ''),
    jobId: String(action.jobId || binding.jobId || ''),
    storeId: String(action.storeId || binding.storeId || ''),
    pageRole: String(action.pageRole || binding.pageRole || ''),
    source: String(action.source || binding.source || 'browser_page_asset_bundle'),
  };
}

function buildArtifactId(binding = {}, sha256 = '') {
  const scope = [binding.jobId, binding.sessionId, binding.turnId, binding.storeId, binding.pageRole]
    .map((item) => String(item || '').replace(/[^a-zA-Z0-9_-]+/g, '-'))
    .filter(Boolean)
    .join('_');
  const suffix = String(sha256 || '').slice(0, 16);
  return [scope || 'browser-asset', suffix].filter(Boolean).join('_');
}

function buildArtifactFilename(asset = {}, mimeType = '', sha256 = '') {
  const urlName = safeFilenameFromUrl(asset.url || '');
  const extension = extensionFromName(urlName) || extensionFromMimeType(mimeType) || extensionFromGroup(asset.group) || 'bin';
  const base = stripExtension(urlName || `${asset.type || 'asset'}-${String(sha256 || '').slice(0, 12)}`) || 'asset';
  return `${base.slice(0, 80)}-${String(sha256 || '').slice(0, 12)}.${extension}`;
}

function safeFilenameFromUrl(url = '') {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  } catch {
    return '';
  }
}

function stripExtension(name = '') {
  return String(name || '').replace(/\.[a-zA-Z0-9]{1,12}$/, '');
}

function extensionFromName(name = '') {
  const match = String(name || '').match(/\.([a-zA-Z0-9]{1,12})$/);
  return match ? match[1].toLowerCase() : '';
}

function extensionFromMimeType(mimeType = '') {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'application/json': 'json',
    'application/manifest+json': 'webmanifest',
    'text/css': 'css',
    'text/javascript': 'js',
    'application/javascript': 'js',
  };
  return map[type] || '';
}

function extensionFromGroup(group = '') {
  if (group === 'stylesheets') return 'css';
  if (group === 'scripts') return 'js';
  if (group === 'manifests') return 'webmanifest';
  return '';
}

function inferSuggestedLibrary(asset = {}, mimeType = '') {
  const type = String(asset.type || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (type === 'image' || mime.startsWith('image/')) return 'image';
  if (type === 'video' || mime.startsWith('video/')) return 'video';
  if (type === 'audio' || mime.startsWith('audio/')) return 'audio';
  if (asset.group === 'stylesheets' || asset.group === 'scripts' || asset.group === 'manifests') return 'web_resource';
  return 'asset';
}

function countBy(entries = [], field = '') {
  const out = {};
  for (const entry of entries) {
    const key = String(entry?.[field] || 'unknown');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function buildTargetPageAssetInventory(inventory = {}) {
  const assets = [];
  for (const [group, items] of Object.entries(inventory || {})) {
    if (!Array.isArray(items)) continue;
    for (const [index, item] of items.entries()) {
      if (!item?.url) continue;
      const kind = targetKindFromGroup(group, item.type);
      assets.push({
        id: buildTargetAssetId(group, item.url, index),
        kind,
        name: buildTargetAssetName(item, kind),
        sources: [buildTargetAssetSource(group, item)],
        url: item.url,
      });
    }
  }
  const inlineSvgs = Array.isArray(inventory.inlineSvgs)
    ? inventory.inlineSvgs.map((item, index) => ({
      id: String(item.id || `inline-svg-${index + 1}`),
      markup: String(item.markup || ''),
      name: String(item.name || item.id || `inline-svg-${index + 1}`),
    })).filter((item) => item.markup)
    : [];
  const byKind = Object.fromEntries(TARGET_PAGE_ASSET_KINDS.map((kind) => [kind, 0]));
  for (const asset of assets) byKind[asset.kind] = (byKind[asset.kind] || 0) + 1;
  return {
    id: buildTargetInventoryId(inventory),
    assets,
    inlineSvgs,
    pageUrl: typeof inventory.url === 'string' ? inventory.url : null,
    summary: {
      byKind,
      inlineSvgCount: inlineSvgs.length,
      totalCount: assets.length,
    },
  };
}

function buildTargetPageAssetBundle(targetInventory = {}, bundled = [], skipped = [], action = {}) {
  const inventoryId = String(action.inventoryId || action.inventory_id || targetInventory.id || 'page-assets');
  const directoryPath = `xwow://page-assets/${inventoryId}`;
  const manifestPath = `${directoryPath}/manifest.json`;
  const assets = bundled.map((asset) => ({
    contentType: asset.mimeType || null,
    id: String(asset.id || asset.artifactId || ''),
    kind: targetKindFromGroup(asset.group, asset.type),
    name: asset.filename || buildTargetAssetName(asset, targetKindFromGroup(asset.group, asset.type)),
    path: `${directoryPath}/${asset.filename || asset.artifactId || 'asset'}`,
    url: asset.url,
  }));
  const failures = skipped.map((item) => {
    const asset = item.asset || {};
    return {
      contentType: asset.mimeType || null,
      id: String(asset.id || ''),
      name: buildTargetAssetName(asset, targetKindFromGroup(asset.group, asset.type)),
      reason: String(item.reason || 'fetch_failed'),
      url: asset.url || '',
    };
  });
  return {
    assets,
    directoryPath,
    failures,
    manifestPath,
    summary: {
      downloadedCount: assets.length,
      elapsedMs: 0,
      failedCount: failures.length,
      requestedCount: assets.length + failures.length,
    },
  };
}

function buildTargetInventoryId(inventory = {}) {
  const seed = `${inventory.url || 'page'}:${inventory.capturedAt || ''}:${JSON.stringify(inventory.counts || {})}`;
  return `inventory-${hashString(seed)}`;
}

function buildTargetAssetId(group = '', url = '', index = 0) {
  return `${targetKindFromGroup(group)}-${hashString(`${group}:${url}:${index}`)}`;
}

function buildTargetAssetName(asset = {}, kind = 'other') {
  return String(asset.title || asset.text || safeFilenameFromUrl(asset.url || '') || `${kind}-asset`);
}

function buildTargetAssetSource(group = '', asset = {}) {
  if (group === 'stylesheets' || group === 'scripts' || group === 'manifests') return { kind: 'resource' };
  if (group === 'icons') return { kind: 'attribute', property: 'href' };
  if (group === 'images' || group === 'videos' || group === 'audios') return { kind: 'attribute', property: 'src' };
  return { kind: 'resource' };
}

function targetKindFromGroup(group = '', type = '') {
  const value = String(type || group || '').toLowerCase();
  if (value === 'font' || value === 'fonts') return 'font';
  if (value === 'image' || value === 'images' || value === 'icon' || value === 'icons') return 'image';
  if (value === 'script' || value === 'scripts') return 'script';
  if (value === 'stylesheet' || value === 'stylesheets') return 'stylesheet';
  if (value === 'video' || value === 'videos') return 'video';
  return 'other';
}

function normalizeAssetTypeName(value = '') {
  const name = String(value || '').trim();
  const lower = name.toLowerCase();
  if (!lower) return '';
  if (lower === 'font') return 'fonts';
  if (lower === 'image') return 'images';
  if (lower === 'icon') return 'icons';
  if (lower === 'stylesheet') return 'stylesheets';
  if (lower === 'style') return 'stylesheets';
  if (lower === 'script') return 'scripts';
  if (lower === 'video') return 'videos';
  if (lower === 'manifest') return 'manifests';
  return lower;
}

function hashString(value = '') {
  let hash = 5381;
  const input = String(value || '');
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
