#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const rootDir = path.resolve(__dirname, '..');
const runtimeDir = path.join(rootDir, '.private-runtime');
const privateEntry = path.join(rootDir, 'private', 'electron', 'registerOfficialFeatures.ts');
const privateRendererEntry = path.join(rootDir, 'private', 'renderer', 'OfficialAiPanel.tsx');
const generatedRendererBridge = path.join(rootDir, 'src', 'features', 'official', 'generatedOfficialAiPanel.tsx');

const filesToCompile = [
  ['electron/officialFeatureBridge.ts', '.private-runtime/electron/officialFeatureBridge.js'],
  ['electron/core/urlUtils.ts', '.private-runtime/electron/core/urlUtils.js'],
  ['shared/redboxVideo.ts', '.private-runtime/shared/redboxVideo.js'],
  ['private/electron/redboxAuthService.ts', '.private-runtime/private/electron/redboxAuthService.js'],
  ['private/electron/registerOfficialFeatures.ts', '.private-runtime/private/electron/registerOfficialFeatures.js'],
];

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  esModuleInterop: true,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
};

const cleanupRuntimeDir = () => {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
};

const ensureParentDir = (filePath) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const writeRendererBridge = (enabled) => {
  ensureParentDir(generatedRendererBridge);
  const content = enabled
    ? [
      "export { default, tabLabel } from '../../../private/renderer/OfficialAiPanel';",
      'export const hasOfficialAiPanel = true;',
      '',
    ].join('\n')
    : [
      "import type { ComponentType } from 'react';",
      'const OfficialAiPanelUnavailable: ComponentType<any> = () => null;',
      'export default OfficialAiPanelUnavailable;',
      "export const tabLabel = '登录';",
      'export const hasOfficialAiPanel = false;',
      '',
    ].join('\n');
  fs.writeFileSync(generatedRendererBridge, content, 'utf8');
};

const compileFile = (sourceRelativePath, targetRelativePath) => {
  const sourcePath = path.join(rootDir, sourceRelativePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing private runtime source: ${sourcePath}`);
  }

  const result = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions,
    fileName: sourcePath,
    reportDiagnostics: true,
  });

  if (result.diagnostics?.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
      getCanonicalFileName: (value) => value,
      getCurrentDirectory: () => rootDir,
      getNewLine: () => '\n',
    }));
  }

  const targetPath = path.join(rootDir, targetRelativePath);
  ensureParentDir(targetPath);
  fs.writeFileSync(targetPath, result.outputText, 'utf8');
};

if (!fs.existsSync(privateEntry)) {
  cleanupRuntimeDir();
  writeRendererBridge(false);
  console.log('[prepare-private-runtime] private feature entry not found, skipped');
  process.exit(0);
}

cleanupRuntimeDir();
for (const [sourceRelativePath, targetRelativePath] of filesToCompile) {
  compileFile(sourceRelativePath, targetRelativePath);
}
writeRendererBridge(fs.existsSync(privateRendererEntry));

console.log('[prepare-private-runtime] generated runtime modules');
