import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const rendererSrc = path.join(repoRoot, 'desktop', 'src');
const bridgeFile = path.join(rendererSrc, 'bridge', 'ipcRenderer.ts');
const hostSrc = path.join(repoRoot, 'desktop', 'src-tauri', 'src');
const outputPath = path.resolve(__dirname, '..', 'docs', 'ipc-inventory.md');

function run(command) {
  return execSync(command, { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim();
}

const frontendChannels = run(
  `rg -o "invoke(Channel|ChannelGuarded)?\\\\('([^']+)'|send(Channel)?\\\\('([^']+)'|on\\\\('([^']+)'" "${rendererSrc}" -g '!**/*.css'`,
)
  .split('\n')
  .map((line) => line.match(/'([^']+)'/)?.[1])
  .filter(Boolean)
  .reduce((acc, channel) => {
    acc.set(channel, (acc.get(channel) || 0) + 1);
    return acc;
  }, new Map());

const backendChannels = run(
  `rg --pcre2 -o '\\"[a-z0-9][a-z0-9:-]*:[a-z0-9:-]+\\"(?=\\s*=>)' "${hostSrc}" -g '*.rs'`,
)
  .split('\n')
  .map((line) => line.replaceAll('"', '').trim())
  .filter(Boolean)
  .reduce((acc, channel) => {
    acc.set(channel, (acc.get(channel) || 0) + 1);
    return acc;
  }, new Map());

const explicitCommandRoutes = run(
  `rg -o "'([^']+)'\\s*:\\s*'([^']+)'" "${bridgeFile}"`,
)
  .split('\n')
  .map((line) => {
    const match = line.match(/'([^']+)'\s*:\s*'([^']+)'/);
    if (!match) {
      return null;
    }
    return { channel: match[1], command: match[2] };
  })
  .filter(Boolean);

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
  '## Host handled channels',
  '',
  '| Channel | Handlers |',
  '| --- | ---: |',
  ...[...backendChannels.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([channel, count]) => `| \`${channel}\` | ${count} |`),
  '',
  '## Explicit Tauri command routes',
  '',
  '| Channel | Command |',
  '| --- | --- |',
  ...explicitCommandRoutes
    .sort((a, b) => a.channel.localeCompare(b.channel))
    .map(({ channel, command }) => `| \`${channel}\` | \`${command}\` |`),
  '',
];

fs.writeFileSync(outputPath, lines.join('\n'));
console.log(`Wrote ${outputPath}`);
