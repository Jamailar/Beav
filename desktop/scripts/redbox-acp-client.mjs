#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:31937/acp/v1';

function usage() {
  return `RedBox ACP client

Usage:
  node desktop/scripts/redbox-acp-client.mjs discover [--discovery-file PATH]
  node desktop/scripts/redbox-acp-client.mjs manifest [--base-url URL] [--token TOKEN]
  node desktop/scripts/redbox-acp-client.mjs guide [--base-url URL] [--json]
  node desktop/scripts/redbox-acp-client.mjs session create --title TEXT [--objective TEXT] [--client-name NAME]
  node desktop/scripts/redbox-acp-client.mjs send --session-id ID --prompt TEXT [--client-name NAME]
  node desktop/scripts/redbox-acp-client.mjs run --prompt TEXT [--session-id ID] [--title TEXT] [--objective TEXT] [--client-name NAME]
  node desktop/scripts/redbox-acp-client.mjs run get --run-id ID
  node desktop/scripts/redbox-acp-client.mjs events --run-id ID [--cursor ID] [--limit N]
  node desktop/scripts/redbox-acp-client.mjs artifact --artifact-id ID

Options:
  --base-url URL       Defaults to REDBOX_ACP_BASE_URL, discovery file, or ${DEFAULT_BASE_URL}
  --discovery-file PATH Defaults to REDBOX_ACP_DISCOVERY_FILE or the RedBox app config path
  --token TOKEN        Defaults to REDBOX_ACP_TOKEN
  --client-name NAME   Defaults to Codex
  --client-kind KIND   Defaults to generic_agent
  --attach-type TYPE   acp_session, collab_session, or project_ref
  --attach-id ID       Target id for attachTo
  --json              Print raw JSON for guide
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (inlineValue !== undefined && inlineValue !== '') {
      args[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function discoveryFileCandidates(explicitPath = '') {
  const candidates = [];
  const add = (item) => {
    if (item && !candidates.includes(item)) candidates.push(item);
  };
  add(explicitPath);
  add(process.env.REDBOX_ACP_DISCOVERY_FILE);
  const home = os.homedir();
  if (process.platform === 'darwin') {
    add(path.join(home, 'Library', 'Application Support', 'RedBox', 'acp-gateway.json'));
  } else if (process.platform === 'win32') {
    add(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'RedBox', 'acp-gateway.json'));
  } else {
    add(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'RedBox', 'acp-gateway.json'));
  }
  return candidates;
}

function readDiscoveryFile(explicitPath = '') {
  for (const candidate of discoveryFileCandidates(explicitPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return { path: candidate, data };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function baseUrlFromDiscovery(discovery) {
  const data = discovery?.data;
  const endpointUrl = typeof data?.endpointUrl === 'string' ? data.endpointUrl.trim() : '';
  if (endpointUrl) return endpointUrl;
  const baseUrl = typeof data?.baseUrl === 'string' ? data.baseUrl.trim().replace(/\/+$/, '') : '';
  if (baseUrl) return `${baseUrl}/acp/v1`;
  return '';
}

function cleanBaseUrl(value) {
  const discovery = value || process.env.REDBOX_ACP_BASE_URL
    ? null
    : readDiscoveryFile();
  const raw = String(
    value
      || process.env.REDBOX_ACP_BASE_URL
      || baseUrlFromDiscovery(discovery)
      || DEFAULT_BASE_URL,
  ).trim();
  return raw.replace(/\/+$/, '');
}

function baseRoot(baseUrl) {
  return baseUrl.endsWith('/acp/v1') ? baseUrl.slice(0, -'/acp/v1'.length) : baseUrl;
}

function value(args, key, fallback = '') {
  const item = args[key];
  if (item === undefined || item === true) return fallback;
  return String(item);
}

function attachTo(args) {
  const type = value(args, 'attachType');
  const id = value(args, 'attachId');
  if (!type) return undefined;
  const payload = { type };
  if (id) payload.id = id;
  return payload;
}

function clientPayload(args) {
  return {
    name: value(args, 'clientName', 'Codex'),
    kind: value(args, 'clientKind', 'generic_agent'),
  };
}

function requestPayload(args, extra = {}) {
  const payload = {
    client: clientPayload(args),
    ...extra,
  };
  const title = value(args, 'title');
  const objective = value(args, 'objective');
  const attach = attachTo(args);
  if (title) payload.title = title;
  if (objective) payload.objective = objective;
  if (attach) payload.attachTo = attach;
  return payload;
}

async function request(args, method, path, body) {
  const baseUrl = cleanBaseUrl(args.baseUrl);
  const root = baseRoot(baseUrl);
  const url = path.startsWith('http')
    ? path
    : `${path.startsWith('/.well-known') ? root : baseUrl}${path}`;
  const token = value(args, 'token', process.env.REDBOX_ACP_TOKEN || '');
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.error || `${response.status} ${response.statusText}`);
    error.response = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function discover(args) {
  const discovery = readDiscoveryFile(value(args, 'discoveryFile'));
  if (discovery) {
    printJson({
      success: true,
      source: 'file',
      path: discovery.path,
      ...discovery.data,
    });
    return;
  }
  try {
    const manifest = await request({ ...args, baseUrl: value(args, 'baseUrl', DEFAULT_BASE_URL) }, 'GET', '/.well-known/redbox-agent.json');
    printJson({
      success: true,
      source: 'default-port-manifest',
      discoveryFileCandidates: discoveryFileCandidates(value(args, 'discoveryFile')),
      baseUrl: manifest?.protocol?.baseUrl || baseRoot(DEFAULT_BASE_URL),
      endpointUrl: manifest?.protocol?.baseUrl ? `${manifest.protocol.baseUrl}/acp/v1` : DEFAULT_BASE_URL,
      manifestUrl: manifest?.endpoints?.wellKnown,
      guideUrl: manifest?.endpoints?.guide,
      manifest,
    });
  } catch (error) {
    printJson({
      success: false,
      source: 'not-found',
      error: error.message,
      discoveryFileCandidates: discoveryFileCandidates(value(args, 'discoveryFile')),
      defaultEndpointUrl: DEFAULT_BASE_URL,
      defaultManifestUrl: `${baseRoot(DEFAULT_BASE_URL)}/.well-known/redbox-agent.json`,
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args._;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return;
  }

  if (command === 'discover') {
    await discover(args);
    return;
  }

  if (command === 'manifest') {
    printJson(await request(args, 'GET', '/.well-known/redbox-agent.json'));
    return;
  }

  if (command === 'guide') {
    const data = await request(args, 'GET', '/guide');
    if (args.json) {
      printJson(data);
    } else {
      process.stdout.write(`${data?.guide || data?.body || JSON.stringify(data, null, 2)}\n`);
    }
    return;
  }

  if (command === 'session' && subcommand === 'create') {
    const payload = requestPayload(args);
    printJson(await request(args, 'POST', '/sessions', payload));
    return;
  }

  if (command === 'send') {
    const sessionId = value(args, 'sessionId');
    const prompt = value(args, 'prompt') || value(args, 'message') || value(args, 'content');
    if (!sessionId || !prompt) throw new Error('send requires --session-id and --prompt');
    const payload = requestPayload(args, { prompt });
    printJson(await request(args, 'POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, payload));
    return;
  }

  if (command === 'run' && subcommand === 'get') {
    const runId = value(args, 'runId');
    if (!runId) throw new Error('run get requires --run-id');
    printJson(await request(args, 'GET', `/runs/${encodeURIComponent(runId)}`));
    return;
  }

  if (command === 'run') {
    const prompt = value(args, 'prompt') || value(args, 'message') || value(args, 'content');
    if (!prompt) throw new Error('run requires --prompt');
    const sessionId = value(args, 'sessionId');
    const payload = requestPayload(args, { prompt });
    if (sessionId) payload.sessionId = sessionId;
    printJson(await request(args, 'POST', '/runs', payload));
    return;
  }

  if (command === 'events') {
    const runId = value(args, 'runId');
    if (!runId) throw new Error('events requires --run-id');
    const params = new URLSearchParams();
    const cursor = value(args, 'cursor');
    const limit = value(args, 'limit');
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', limit);
    const suffix = params.toString() ? `?${params}` : '';
    printJson(await request(args, 'GET', `/runs/${encodeURIComponent(runId)}/events${suffix}`));
    return;
  }

  if (command === 'artifact') {
    const artifactId = value(args, 'artifactId');
    if (!artifactId) throw new Error('artifact requires --artifact-id');
    printJson(await request(args, 'GET', `/artifacts/${encodeURIComponent(artifactId)}`));
    return;
  }

  throw new Error(`Unknown command: ${args._.join(' ')}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  if (error.response) {
    process.stderr.write(`${JSON.stringify(error.response, null, 2)}\n`);
  }
  process.stderr.write(`\n${usage()}`);
  process.exitCode = 1;
});
