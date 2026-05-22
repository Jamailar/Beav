import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  browserPayloadForCommand,
  invokeBrowserHost,
  isTauriRuntime,
} from './browserHost';
import { buildFallbackResponse } from './fallbacks';
import type {
  BridgeCore,
  GuardedFallbackValue,
  InvokeGuardOptions,
  Listener,
  ListenerRecord,
} from './types';

const explicitCommandRoutes: Record<string, string> = {
  'spaces:list': 'spaces_list',
  'advisors:list': 'advisors_list',
  'advisors:list-templates': 'advisors_list_templates',
  'knowledge:list': 'knowledge_list',
  'knowledge:list-youtube': 'knowledge_list_youtube',
  'knowledge:docs:list': 'knowledge_docs_list',
  'knowledge:list-page': 'knowledge_list_page',
  'knowledge:get-item-detail': 'knowledge_get_item_detail',
  'knowledge:get-index-status': 'knowledge_get_index_status',
  'knowledge:get-file-index-dashboard': 'knowledge_get_file_index_dashboard',
  'knowledge:rebuild-catalog': 'knowledge_rebuild_catalog',
  'knowledge:open-index-root': 'knowledge_open_index_root',
  'redclaw:runner-status': 'redclaw_runner_status',
};

const explicitChannelByCommand = Object.fromEntries(
  Object.entries(explicitCommandRoutes).map(([channel, command]) => [command, channel]),
) as Record<string, string>;

const channelListeners = new Map<string, Map<Listener, ListenerRecord>>();

async function invokeChannel(channel: string, payload?: unknown): Promise<any> {
  try {
    if (!isTauriRuntime()) {
      return await invokeBrowserHost(channel, payload);
    }
    const explicitCommand = explicitCommandRoutes[channel];
    if (explicitCommand) {
      return await invokeCommand(explicitCommand, payload);
    }
    return await invoke('ipc_invoke', { channel, payload: payload ?? null });
  } catch (error) {
    console.warn(`[] invoke failed for ${channel}:`, error);
    return buildFallbackResponse(channel, error, payload);
  }
}

function sendChannel(channel: string, payload?: unknown): void {
  if (!isTauriRuntime()) {
    void invokeBrowserHost(channel, payload).catch((error) => {
      console.warn(`[] browser send failed for ${channel}:`, error);
    });
    return;
  }
  void invoke('ipc_send', { channel, payload: payload ?? null }).catch((error) => {
    console.warn(`[] send failed for ${channel}:`, error);
  });
}

async function invokeCommand<T = unknown>(command: string, args?: unknown): Promise<T> {
  try {
    if (!isTauriRuntime()) {
      const channel = explicitChannelByCommand[command];
      if (!channel) {
        throw new Error(`Browser host does not expose command "${command}"`);
      }
      return await invokeBrowserHost(channel, browserPayloadForCommand(command, args));
    }
    return await invoke(command, args as Record<string, unknown> | undefined);
  } catch (error) {
    console.warn(`[] command invoke failed for ${command}:`, error);
    throw error;
  }
}

function resolveGuardFallback<T>(channel: string, error: unknown, fallback?: GuardedFallbackValue<T>): T {
  if (typeof fallback === 'function') {
    return (fallback as () => T | null)() as T;
  }
  if (fallback !== undefined) {
    return fallback as T;
  }
  return buildFallbackResponse(channel, error) as T;
}

async function invokeChannelGuarded<T = unknown>(
  channel: string,
  payload?: unknown,
  options?: InvokeGuardOptions<T>,
): Promise<T> {
  const timeoutMs = Math.max(1, Number(options?.timeoutMs || 0));

  try {
    const value = timeoutMs > 0
      ? await Promise.race<unknown>([
          invokeChannel(channel, payload),
          new Promise((resolve) => {
            window.setTimeout(() => resolve(Symbol.for('__redbox_ipc_timeout__')), timeoutMs);
          }),
        ])
      : await invokeChannel(channel, payload);

    if (value === Symbol.for('__redbox_ipc_timeout__')) {
      const timeoutError = new Error(`Timed out after ${timeoutMs}ms`);
      console.warn(`[] invoke timed out for ${channel}:`, timeoutError.message);
      return resolveGuardFallback(channel, timeoutError, options?.fallback);
    }

    if (options?.normalize) {
      try {
        return options.normalize(value);
      } catch (error) {
        console.warn(`[] invoke normalization failed for ${channel}:`, error);
        return resolveGuardFallback(channel, error, options?.fallback);
      }
    }

    return value as T;
  } catch (error) {
    console.warn(`[] guarded invoke failed for ${channel}:`, error);
    return resolveGuardFallback(channel, error, options?.fallback);
  }
}

async function invokeCommandGuarded<T = unknown>(
  command: string,
  args?: unknown,
  options?: InvokeGuardOptions<T> & { fallbackChannel?: string },
): Promise<T> {
  const timeoutMs = Math.max(1, Number(options?.timeoutMs || 0));
  const fallbackKey = options?.fallbackChannel || command;

  try {
    const value = timeoutMs > 0
      ? await Promise.race<unknown>([
          invokeCommand(command, args),
          new Promise((resolve) => {
            window.setTimeout(() => resolve(Symbol.for('__redbox_ipc_timeout__')), timeoutMs);
          }),
        ])
      : await invokeCommand(command, args);

    if (value === Symbol.for('__redbox_ipc_timeout__')) {
      const timeoutError = new Error(`Timed out after ${timeoutMs}ms`);
      console.warn(`[] command invoke timed out for ${command}:`, timeoutError.message);
      return resolveGuardFallback(fallbackKey, timeoutError, options?.fallback);
    }

    if (options?.normalize) {
      try {
        return options.normalize(value);
      } catch (error) {
        console.warn(`[] command normalization failed for ${command}:`, error);
        return resolveGuardFallback(fallbackKey, error, options?.fallback);
      }
    }

    return value as T;
  } catch (error) {
    return resolveGuardFallback(fallbackKey, error, options?.fallback);
  }
}

function on(channel: string, listener: Listener): void {
  if (!isTauriRuntime()) {
    return;
  }
  const entry: ListenerRecord = {};
  if (!channelListeners.has(channel)) {
    channelListeners.set(channel, new Map());
  }
  channelListeners.get(channel)!.set(listener, entry);

  entry.pending = listen(channel, (event) => {
    listener({ __tauri: true, channel }, event.payload);
  }).then((dispose) => {
    if (entry.disposed) {
      dispose();
      return dispose;
    }
    entry.dispose = dispose;
    return dispose;
  });
}

function off(channel: string, listener: Listener): void {
  const channelMap = channelListeners.get(channel);
  const record = channelMap?.get(listener);
  if (!record) return;

  record.disposed = true;
  if (record.dispose) {
    record.dispose();
  } else if (record.pending) {
    void record.pending.then((dispose) => dispose());
  }
  channelMap?.delete(listener);
  if (channelMap && channelMap.size === 0) {
    channelListeners.delete(channel);
  }
}

function removeAllListeners(channel: string): void {
  const channelMap = channelListeners.get(channel);
  if (!channelMap) return;
  for (const [listener, record] of channelMap.entries()) {
    record.disposed = true;
    if (record.dispose) {
      record.dispose();
    } else if (record.pending) {
      void record.pending.then((dispose) => dispose());
    }
    channelMap.delete(listener);
  }
  channelListeners.delete(channel);
}

export function createBridgeCore(): BridgeCore {
  return {
    isTauriRuntime,
    on,
    off,
    removeAllListeners,
    sendChannel,
    invokeChannel,
    invokeChannelGuarded,
    invokeCommand,
    invokeCommandGuarded,
  };
}
