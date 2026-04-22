#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

const relayUrl = process.env.REDCONVERT_RELAY_URL || 'http://127.0.0.1:31937/hooks/weixin/relay';
const relayToken = process.env.REDCONVERT_RELAY_TOKEN || '';
const accountId = process.env.WEIXIN_CLAW_ACCOUNT_ID || '';
const pollTimeoutMs = Math.max(5_000, Number(process.env.WEIXIN_CLAW_POLL_TIMEOUT_MS || 35_000));
const retryDelayMs = Math.max(1_000, Number(process.env.WEIXIN_CLAW_RETRY_DELAY_MS || 3_000));
const cursorFile = process.env.WEIXIN_CLAW_CURSOR_FILE || '';
const outboxDir = process.env.WEIXIN_OUTBOX_DIR || '';

async function loadCursorState() {
  if (!cursorFile) return { syncCursor: '' };
  try {
    const raw = await fs.readFile(cursorFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      syncCursor: String(parsed?.syncCursor || '').trim(),
    };
  } catch {
    return { syncCursor: '' };
  }
}

async function saveCursorState(syncCursor) {
  if (!cursorFile) return;
  await fs.mkdir(path.dirname(cursorFile), { recursive: true });
  await fs.writeFile(cursorFile, JSON.stringify({ syncCursor }, null, 2), 'utf-8');
}

const textFromItems = (items) => {
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => String(item?.text_item?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
};

async function loadWeixinRuntime() {
  try {
    const [{ getUpdates }, { resolveWeixinAccount }, { sendMessageWeixin }] = await Promise.all([
      import('@weixin-claw/core/api/api'),
      import('@weixin-claw/core/auth/accounts'),
      import('@weixin-claw/core/messaging/send'),
    ]);
    return { getUpdates, resolveWeixinAccount, sendMessageWeixin };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load @weixin-claw/core. Install it under Node >=22 first. ${message}`);
  }
}

async function postToRelay(payload) {
  console.log('[weixin-claw-relay] posting message to relay', {
    peerId: payload.peerId,
    messageId: payload.messageId,
    preview: String(payload.text || '').slice(0, 120),
  });
  const response = await fetch(relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...payload,
      authToken: relayToken,
      waitForReply: true,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    throw new Error(`Relay request failed: ${body?.error || response.statusText || 'unknown error'}`);
  }
  console.log('[weixin-claw-relay] relay accepted', {
    peerId: payload.peerId,
    messageId: payload.messageId,
    taskId: body?.taskId,
    sessionId: body?.sessionId,
    responsePreview: String(body?.response || '').slice(0, 120),
  });
  return {
    taskId: body?.taskId,
    sessionId: body?.sessionId,
    response: String(body?.response || '').trim(),
  };
}

async function listPendingOutboundFiles() {
  if (!outboxDir) return [];
  try {
    const entries = await fs.readdir(outboxDir);
    return entries
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(outboxDir, name));
  } catch {
    return [];
  }
}

async function claimOutboundFile(filePath) {
  const claimedPath = `${filePath}.sending`;
  try {
    await fs.rename(filePath, claimedPath);
    return claimedPath;
  } catch {
    return null;
  }
}

async function releaseOutboundFile(claimedPath) {
  try {
    if (claimedPath.endsWith('.sending')) {
      await fs.rename(claimedPath, claimedPath.slice(0, -'.sending'.length));
    }
  } catch {
    // ignore
  }
}

async function flushOutboundMessages(sendMessageWeixin, resolved) {
  const files = await listPendingOutboundFiles();
  for (const filePath of files) {
    const claimedPath = await claimOutboundFile(filePath);
    if (!claimedPath) continue;
    try {
      const raw = await fs.readFile(claimedPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.accountId && parsed.accountId !== resolved.accountId) {
        await fs.unlink(claimedPath).catch(() => {});
        continue;
      }
      const peerId = String(parsed?.peerId || '').trim();
      const text = String(parsed?.text || '').trim();
      if (!peerId || !text) {
        await fs.unlink(claimedPath).catch(() => {});
        continue;
      }
      console.log('[weixin-claw-relay] sending queued outbound message', {
        peerId,
        kind: parsed?.kind,
        taskId: parsed?.taskId,
        preview: text.slice(0, 120),
      });
      await sendMessageWeixin({
        to: peerId,
        text,
        opts: {
          baseUrl: resolved.baseUrl,
          token: resolved.token,
          contextToken: String(parsed?.contextToken || '').trim() || undefined,
        },
      });
      await fs.unlink(claimedPath).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[weixin-claw-relay] failed to flush outbound message:', message);
      await releaseOutboundFile(claimedPath);
    }
  }
}

async function main() {
  const { getUpdates, resolveWeixinAccount, sendMessageWeixin } = await loadWeixinRuntime();
  const resolved = resolveWeixinAccount(accountId || undefined);
  if (!resolved?.configured || !resolved?.token) {
    throw new Error('No configured Weixin account found. Complete QR login with @weixin-claw/core first.');
  }

  console.log('[weixin-claw-relay] started', {
    relayUrl,
    accountId: resolved.accountId,
    baseUrl: resolved.baseUrl,
    cursorFile: cursorFile || '(memory-only)',
    outboxDir: outboxDir || '(disabled)',
  });

  const cursorState = await loadCursorState();
  let syncCursor = cursorState.syncCursor;
  while (true) {
    try {
      const updates = await getUpdates({
        baseUrl: resolved.baseUrl,
        token: resolved.token,
        timeoutMs: pollTimeoutMs,
        get_updates_buf: syncCursor,
      });
      if (typeof updates?.get_updates_buf === 'string') {
        syncCursor = updates.get_updates_buf;
        await saveCursorState(syncCursor);
      }
      const messages = Array.isArray(updates?.msgs) ? updates.msgs : [];
      if (messages.length) {
        console.log('[weixin-claw-relay] updates received', {
          count: messages.length,
          cursor: syncCursor,
        });
      }
      for (const message of messages) {
        if (Number(message?.message_type) !== 1) continue;
        const text = textFromItems(message?.item_list);
        const peerId = String(message?.from_user_id || '').trim();
        if (!peerId || !text) continue;
        console.log('[weixin-claw-relay] inbound text message', {
          peerId,
          messageId: String(message?.message_id || '').trim(),
          preview: text.slice(0, 120),
        });

        const accepted = await postToRelay({
          provider: 'weixin',
          accountId: resolved.accountId,
          peerId,
          userId: peerId,
          messageId: String(message?.message_id || '').trim(),
          text,
          metadata: {
            contextToken: String(message?.context_token || '').trim(),
            sessionId: String(message?.session_id || '').trim(),
          },
        });
        const kickoffText = String(accepted?.response || '').trim()
          || '收到，RedClaw正在思考';
        console.log('[weixin-claw-relay] sending immediate kickoff reply to weixin', {
          peerId,
          messageId: String(message?.message_id || '').trim(),
          taskId: accepted?.taskId,
          preview: kickoffText.slice(0, 120),
        });
        await sendMessageWeixin({
          to: peerId,
          text: kickoffText,
          opts: {
            baseUrl: resolved.baseUrl,
            token: resolved.token,
            contextToken: String(message?.context_token || '').trim() || undefined,
          },
        });
        console.log('[weixin-claw-relay] immediate kickoff reply sent', {
          peerId,
          messageId: String(message?.message_id || '').trim(),
        });
      }
      await flushOutboundMessages(sendMessageWeixin, resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[weixin-claw-relay] loop error:', message);
      await delay(retryDelayMs);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[weixin-claw-relay] fatal:', message);
  process.exitCode = 1;
});
