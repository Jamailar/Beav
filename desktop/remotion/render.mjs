import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function main() {
  const [, , configPath, outputPath] = process.argv;
  if (!configPath || !outputPath) {
    throw new Error('Usage: node remotion/render.mjs <configPath> <outputPath>');
  }

  const raw = await fs.readFile(configPath, 'utf8');
  const compositionConfig = JSON.parse(raw);
  const entryPoint = path.join(projectRoot, 'src', 'remotion', 'index.ts');
  const compositionId = typeof compositionConfig.entryCompositionId === 'string'
    && compositionConfig.entryCompositionId.trim()
    ? compositionConfig.entryCompositionId.trim()
    : 'RedBoxVideoMotion';
  const bundled = await bundle({
    entryPoint,
    webpackOverride: (config) => config,
  });

  const inputProps = {
    composition: compositionConfig,
    runtime: 'render',
  };

  const composition = await selectComposition({
    serveUrl: bundled,
    id: compositionId,
    inputProps,
  });

  const renderMode = compositionConfig.renderMode === 'full' ? 'full' : 'motion-layer';
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
    defaultOutName: composition.defaultOutName || null,
    codec,
    imageFormat,
    pixelFormat: pixelFormat || null,
    proResProfile: proResProfile || null,
  }));
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error?.message || error));
  process.exit(1);
});
