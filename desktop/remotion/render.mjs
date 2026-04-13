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
    id: 'RedBoxVideoMotion',
    inputProps,
  });

  const renderMode = compositionConfig.renderMode === 'full' ? 'full' : 'motion-layer';
  const renderOptions = renderMode === 'motion-layer'
    ? {
        codec: 'prores',
        proResProfile: '4444',
        pixelFormat: 'yuva444p10le',
        muted: true,
        enforceAudioTrack: false,
      }
    : {
        codec: 'h264',
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
    outputLocation: outputPath,
    durationInFrames: composition.durationInFrames,
    renderMode,
  }));
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error?.message || error));
  process.exit(1);
});
