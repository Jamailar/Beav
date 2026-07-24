#!/usr/bin/env node

import { DesktopBridgeControlClient } from './scripts/desktop-bridge-client.mjs';

function parseArgs(argv) {
  const out = { params: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--method') out.method = argv[index + 1];
    if (item === '--params') out.params = JSON.parse(argv[index + 1] || '{}');
    if (item === '--timeout-ms') out.timeoutMs = Number(argv[index + 1] || 0);
    if (item === '--help' || item === '-h') out.help = true;
  }
  if (!out.method && argv[0] && !argv[0].startsWith('--')) out.method = argv[0];
  if (!out.params && argv[1] && !argv[1].startsWith('--')) out.params = JSON.parse(argv[1] || '{}');
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node agent-client.mjs --method tools/list',
    '  node agent-client.mjs --method tabs.list --params \'{"limit":20}\'',
    '  node agent-client.mjs --method tools/call --params \'{"name":"browser.info","arguments":{}}\'',
    '',
    'The client uses the authenticated Desktop Bridge named pipe or Unix socket.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.method) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }
  const client = new DesktopBridgeControlClient({ timeoutMs: args.timeoutMs || 30_000 });
  try {
    if (args.method === 'tools/list') {
      console.log(JSON.stringify({ tools: await client.listTools() }, null, 2));
      return;
    }
    const name = args.method === 'tools/call'
      ? String(args.params?.name || '').trim()
      : args.method;
    const argumentsValue = args.method === 'tools/call'
      ? (args.params?.arguments || {})
      : (args.params || {});
    if (!name) throw new Error('tools/call requires params.name');
    const result = await client.invokeTool(name, argumentsValue, {
      timeoutMs: args.timeoutMs || 30_000,
    });
    console.log(JSON.stringify(result.response, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
