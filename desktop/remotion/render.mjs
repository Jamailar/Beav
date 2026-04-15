import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function isWindowsAbsoluteLocalPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '').trim());
}

function isLocalAssetSource(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^(https?:|data:|blob:)/i.test(raw)) return false;
  return raw.startsWith('/')
    || raw.startsWith('file://')
    || raw.startsWith('local-file://')
    || raw.startsWith('redbox-asset://')
    || isWindowsAbsoluteLocalPath(raw);
}

function extractLocalAssetPath(source) {
  const raw = String(source || '').trim();
  if (!raw) return '';
  if (raw.startsWith('redbox-asset://asset/')) {
    return decodeURIComponent(raw.replace(/^redbox-asset:\/\/asset\/?/i, '/'));
  }
  if (raw.startsWith('local-file://') || raw.startsWith('file://')) {
    try {
      const parsed = new URL(raw.replace(/^local-file:/i, 'file:'));
      let pathname = decodeURIComponent(parsed.pathname || '');
      if (/^\/[a-zA-Z]:/.test(pathname)) {
        pathname = pathname.slice(1);
      }
      return pathname;
    } catch {
      return decodeURIComponent(raw.replace(/^(local-file|file):\/+/i, '/'));
    }
  }
  return raw;
}

function collectLocalAssetSources(value, found = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectLocalAssetSources(item, found));
    return found;
  }
  if (!value || typeof value !== 'object') {
    return found;
  }
  Object.entries(value).forEach(([key, child]) => {
    if (key === 'src' && typeof child === 'string' && isLocalAssetSource(child)) {
      const assetPath = extractLocalAssetPath(child);
      if (assetPath) {
        found.add(assetPath);
      }
      return;
    }
    collectLocalAssetSources(child, found);
  });
  return found;
}

function rewriteLocalAssetSources(value, replacements) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteLocalAssetSources(item, replacements));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === 'src' && typeof child === 'string' && isLocalAssetSource(child)) {
        const assetPath = extractLocalAssetPath(child);
        return [key, replacements.get(assetPath) || child];
      }
      return [key, rewriteLocalAssetSources(child, replacements)];
    }),
  );
}

async function stageLocalAssetsForRender(compositionConfig) {
  const localSources = [...collectLocalAssetSources(compositionConfig)];
  if (localSources.length === 0) {
    return {
      compositionConfig,
      tempAssetDir: null,
    };
  }

  const tempRootDir = path.join(
    process.env.TMPDIR || process.env.TEMP || '/tmp',
    `lexbox-remotion-public-${Date.now()}`,
  );
  const assetDir = path.join(tempRootDir, 'redbox-assets');
  await fs.mkdir(assetDir, { recursive: true });

  const replacements = new Map();
  let assetIndex = 0;
  for (const sourcePath of localSources) {
    const extension = path.extname(sourcePath) || '';
    const fileName = `asset-${assetIndex}${extension}`;
    const targetPath = path.join(assetDir, fileName);
    await fs.copyFile(sourcePath, targetPath);
    replacements.set(sourcePath, `/redbox-assets/${fileName}`);
    assetIndex += 1;
  }

  return {
    compositionConfig: rewriteLocalAssetSources(compositionConfig, replacements),
    tempAssetDir: assetDir,
  };
}

async function main() {
  const [, , configPath, outputPath, scaleArg] = process.argv;
  if (!configPath || !outputPath) {
    throw new Error('Usage: node remotion/render.mjs <configPath> <outputPath> [scale]');
  }

  const raw = await fs.readFile(configPath, 'utf8');
  const compositionConfig = JSON.parse(raw);
  const staged = await stageLocalAssetsForRender(compositionConfig);
  const requestedScale = Number(scaleArg || '1');
  const renderScale = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1;
  const entryPoint = path.join(projectRoot, 'src', 'remotion', 'index.ts');
  const compositionId = typeof staged.compositionConfig.entryCompositionId === 'string'
    && staged.compositionConfig.entryCompositionId.trim()
    ? staged.compositionConfig.entryCompositionId.trim()
    : 'RedBoxVideoMotion';
  try {
    const bundled = await bundle({
      entryPoint,
      webpackOverride: (config) => config,
    });
    if (staged.tempAssetDir) {
      const bundleAssetDir = path.join(bundled, 'redbox-assets');
      await fs.mkdir(bundleAssetDir, { recursive: true });
      const stagedFiles = await fs.readdir(staged.tempAssetDir);
      for (const fileName of stagedFiles) {
        await fs.copyFile(
          path.join(staged.tempAssetDir, fileName),
          path.join(bundleAssetDir, fileName),
        );
      }
    }

    const inputProps = {
      composition: staged.compositionConfig,
      runtime: 'render',
    };

    const composition = await selectComposition({
      serveUrl: bundled,
      id: compositionId,
      inputProps,
    });

    const renderMode = staged.compositionConfig.renderMode === 'full' ? 'full' : 'motion-layer';
    const codec = composition.defaultCodec || (renderMode === 'motion-layer' ? 'prores' : 'h264');
    const imageFormat = composition.defaultVideoImageFormat || (codec === 'prores' ? 'png' : 'jpeg');
    const pixelFormat = composition.defaultPixelFormat || (codec === 'prores' ? 'yuva444p10le' : undefined);
    const proResProfile = composition.defaultProResProfile || (codec === 'prores' ? '4444' : undefined);
    const renderOptions = {
      codec,
      imageFormat,
      ...(pixelFormat ? { pixelFormat } : {}),
      ...(proResProfile ? { proResProfile } : {}),
      ...(renderMode === 'motion-layer'
        ? {
            muted: true,
            enforceAudioTrack: false,
          }
        : {}),
    };

    await renderMedia({
      serveUrl: bundled,
      composition,
      outputLocation: outputPath,
      inputProps,
      scale: renderScale,
      onProgress: (progress) => {
        process.stderr.write(`__REMOTION_PROGRESS__${JSON.stringify({
          percent: Math.max(0, Math.min(100, Math.round((progress.progress || 0) * 100))),
          renderedFrames: progress.renderedFrames,
          encodedFrames: progress.encodedFrames,
          stitchStage: progress.stitchStage,
        })}\n`);
      },
      chromiumOptions: {
        disableWebSecurity: true,
      },
      overwrite: true,
      ...renderOptions,
    });

    process.stdout.write(JSON.stringify({
      success: true,
      compositionId,
      outputLocation: outputPath,
      durationInFrames: composition.durationInFrames,
      renderMode,
      scale: renderScale,
      defaultOutName: composition.defaultOutName || null,
      codec,
      imageFormat,
      pixelFormat: pixelFormat || null,
      proResProfile: proResProfile || null,
    }));
  } finally {
    if (staged.tempAssetDir) {
      await fs.rm(path.dirname(staged.tempAssetDir), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error?.message || error));
  process.exit(1);
});
