import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const desktopSrc = path.join(repoRoot, 'desktop', 'src');
const electronMain = path.join(repoRoot, 'desktop', 'electron', 'main.ts');
const outputPath = path.join(repoRoot, 'LexBox', 'docs', 'ipc-inventory.md');

function run(command) {
  return execSync(command, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const frontendChannels = run(
  `rg -o "invoke\\\\('([^']+)'|send\\\\('([^']+)'|on\\\\('([^']+)'" "${desktopSrc}" -g '!**/*.css'`,
)
  .split('\n')
  .map((line) => line.match(/'([^']+)'/)?.[1])
  .filter(Boolean)
  .reduce((acc, channel) => {
    acc.set(channel, (acc.get(channel) || 0) + 1);
    return acc;
  }, new Map());

const backendHandlers = run(
  `rg -n "ipcMain\\\\.(handle|on)\\\\(" "${electronMain}"`,
).split('\n');

const lines = [
  '# IPC Inventory',
  '',
  '## Frontend referenced channels',
  '',
  '| Channel | References |',
  '| --- | ---: |',
  ...[...frontendChannels.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([channel, count]) => `| \`${channel}\` | ${count} |`),
  '',
  '## Electron main handlers',
  '',
  '```text',
  ...backendHandlers,
  '```',
  '',
];

fs.writeFileSync(outputPath, lines.join('\n'));
console.log(`Wrote ${outputPath}`);
