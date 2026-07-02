import { useCallback, useEffect, useRef } from 'react';
import type { PendingChatMessage, RedClawNavigationAction, ViewType } from '../app-shell/types';
import type { DeepLinkEventPayload, DeepLinkIntent, DeepLinkPendingResponse } from './types';

type UseDeepLinkRouterParams = {
  navigateToView: (view: ViewType) => void;
  navigateToRedClaw: (message: PendingChatMessage) => void;
  setRedClawNavigationAction: (value: RedClawNavigationAction | null) => void;
};

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function normalizeIntent(value: unknown): DeepLinkIntent | null {
  const record = recordFromUnknown(value);
  const type = normalizeString(record.type);
  if (type !== 'open' && type !== 'chat.new' && type !== 'import.url' && type !== 'knowledge.save') {
    return null;
  }
  return {
    type,
    text: normalizeString(record.text),
    url: normalizeString(record.url),
    title: normalizeString(record.title),
  };
}

function normalizePayload(value: unknown): DeepLinkEventPayload | null {
  const record = recordFromUnknown(value);
  if (!Object.keys(record).length) return null;
  return {
    success: record.success === true,
    source: normalizeString(record.source),
    rawUrl: normalizeString(record.rawUrl),
    receivedAt: normalizeString(record.receivedAt),
    intent: normalizeIntent(record.intent),
    error: recordFromUnknown(record.error),
  };
}

function eventKey(payload: DeepLinkEventPayload): string {
  return `${payload.receivedAt || ''}:${payload.rawUrl || ''}:${payload.intent?.type || ''}`;
}

function deepLinkTitle(intent: DeepLinkIntent): string {
  return intent.title || intent.url || intent.text || '来自网页的请求';
}

function messageForUrlIntent(intent: DeepLinkIntent): PendingChatMessage {
  const title = deepLinkTitle(intent);
  const prefix = intent.type === 'knowledge.save'
    ? '请把这个网页整理进知识库，并保留来源链接：'
    : '请帮我处理这个网页：';
  const lines = [
    prefix,
    intent.title ? `标题：${intent.title}` : '',
    intent.url ? `链接：${intent.url}` : '',
    intent.text ? `补充：${intent.text}` : '',
  ].filter(Boolean);
  return {
    content: lines.join('\n'),
    displayContent: intent.type === 'knowledge.save' ? `保存网页到知识库：${title}` : `处理网页：${title}`,
    sessionRouting: 'new',
    deliveryMode: 'draft',
  };
}

export function useDeepLinkRouter({
  navigateToView,
  navigateToRedClaw,
  setRedClawNavigationAction,
}: UseDeepLinkRouterParams) {
  const handledKeysRef = useRef<Set<string>>(new Set());

  const handlePayload = useCallback((rawPayload: unknown) => {
    const payload = normalizePayload(rawPayload);
    if (!payload) return;

    const key = eventKey(payload);
    if (handledKeysRef.current.has(key)) return;
    handledKeysRef.current.add(key);

    if (!payload.success || !payload.intent) {
      console.warn('[deep-link] ignored invalid link', payload.error || payload.rawUrl || payload);
      return;
    }

    const intent = payload.intent;
    if (intent.type === 'open') {
      navigateToView('redclaw');
      return;
    }

    if (intent.type === 'chat.new') {
      if (!intent.text) {
        setRedClawNavigationAction({
          action: 'new',
          nonce: Date.now(),
        });
        navigateToView('redclaw');
        return;
      }
      navigateToView('redclaw');
      navigateToRedClaw({
        content: intent.text,
        displayContent: intent.text,
        sessionRouting: 'new',
        deliveryMode: 'draft',
      });
      return;
    }

    if (intent.type === 'import.url' || intent.type === 'knowledge.save') {
      if (!intent.url) return;
      navigateToView('redclaw');
      navigateToRedClaw(messageForUrlIntent(intent));
    }
  }, [navigateToRedClaw, navigateToView, setRedClawNavigationAction]);

  useEffect(() => {
    let disposed = false;
    const consumePending = async (processItems: boolean) => {
      const result = await window.ipcRenderer.deepLink.consumePending<DeepLinkPendingResponse>();
      if (disposed || !processItems || !Array.isArray(result?.items)) return;
      for (const item of result.items) {
        handlePayload(item);
      }
    };

    void consumePending(true).catch((error) => {
      console.warn('[deep-link] failed to consume pending links', error);
    });

    const handleDeepLink = (_event: unknown, payload?: unknown) => {
      handlePayload(payload);
      void consumePending(false).catch(() => {});
    };

    window.ipcRenderer.deepLink.onOpen(handleDeepLink);
    return () => {
      disposed = true;
      window.ipcRenderer.deepLink.offOpen(handleDeepLink);
    };
  }, [handlePayload]);
}
