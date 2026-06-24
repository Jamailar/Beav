#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:31937/acp/v1';

function usage() {
  return `RedBox ACP client

Usage:
  node desktop/scripts/redbox-acp-client.mjs manifest [--base-url URL] [--token TOKEN]
  node desktop/scripts/redbox-acp-client.mjs guide [--base-url URL] [--json]
  node desktop/scripts/redbox-acp-client.mjs session create --title TEXT [--objective TEXT] [--client-name NAME]
  node desktop/scripts/redbox-acp-client.mjs send --session-id ID --prompt TEXT [--client-name NAME]
  node desktop/scripts/redbox-acp-client.mjs run --prompt TEXT [--session-id ID] [--title TEXT] [--objective TEXT] [--client-name NAME]
  node desktop/scripts/redbox-acp-client.mjs run get --run-id ID
  node desktop/scripts/redbox-acp-client.mjs events --run-id ID [--cursor ID] [--limit N]
  node desktop/scripts/redbox-acp-client.mjs artifact --artifact-id ID

Options:
  --base-url URL       Defaults to REDBOX_ACP_BASE_URL or ${DEFAULT_BASE_URL}
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

function cleanBaseUrl(value) {
  const raw = String(value || process.env.REDBOX_ACP_BASE_URL || DEFAULT_BASE_URL).trim();
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args._;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
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
