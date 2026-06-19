#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostName = 'com.redbox.browser_control';
const hostScript = path.join(__dirname, 'native-host', 'host.mjs');
const templatePath = path.join(__dirname, 'native-host', `${hostName}.json`);
const targetDir = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
const targetPath = path.join(targetDir, `${hostName}.json`);

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--extension-id') out.extensionId = argv[index + 1];
    if (item === '--target') out.target = argv[index + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const extensionId = args.extensionId || process.env.REDBOX_BROWSER_CONTROL_EXTENSION_ID;
if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  console.error('Usage: node install-native-host.mjs --extension-id <chrome extension id>');
  process.exit(1);
}

fs.chmodSync(hostScript, 0o755);
const manifest = fs.readFileSync(templatePath, 'utf8')
  .replace('__HOST_PATH__', hostScript)
  .replace('__EXTENSION_ID__', extensionId);
const destination = args.target || targetPath;
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, manifest);
console.log(`[native-host] installed ${destination}`);
