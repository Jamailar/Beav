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

  await renderMedia({
    serveUrl: bundled,
    composition,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps,
    chromiumOptions: {
      disableWebSecurity: true,
    },
    overwrite: true,
  });

  process.stdout.write(JSON.stringify({
    success: true,
    outputLocation: outputPath,
    durationInFrames: composition.durationInFrames,
  }));
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error?.message || error));
  process.exit(1);
});
