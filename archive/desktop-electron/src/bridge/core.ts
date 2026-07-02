import { buildFallbackResponse } from './fallbacks';
import type {
  BridgeCore,
  GuardedFallbackValue,
  InvokeGuardOptions,
  Listener,
  ListenerRecord,
} from './types';

type ElectronIpcTransport = {
  on: (channel: string, listener: Listener) => void;
  off: (channel: string, listener: Listener) => void;
  removeAllListeners: (channel: string) => void;
  send: (channel: string, payload?: unknown) => void;
  invoke: (channel: string, payload?: unknown) => Promise<any>;
};

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
  'knowledge:rebuild-catalog': 'knowledge_rebuild_catalog',
  'knowledge:open-index-root': 'knowledge_open_index_root',
  'knowledge:get-file-index-dashboard': 'knowledge_get_file_index_dashboard',
  'knowledge:get-file-index-scope-status': 'knowledge_get_file_index_scope_status',
  'redclaw:runner-status': 'redclaw_runner_status',
};

const explicitChannelByCommand = Object.fromEntries(
  Object.entries(explicitCommandRoutes).map(([channel, command]) => [command, channel]),
) as Record<string, string>;

const channelListeners = new Map<string, Map<Listener, ListenerRecord>>();

function isTauriRuntime(): boolean {
  return false;
}

function getElectronTransport(): ElectronIpcTransport | null {
  if (typeof window === 'undefined') return null;
  const transport = (window as typeof window & { __RED_ELECTRON_IPC__?: Partial<ElectronIpcTransport> }).__RED_ELECTRON_IPC__;
  if (
    transport
    && typeof transport.invoke === 'function'
    && typeof transport.send === 'function'
    && typeof transport.on === 'function'
    && typeof transport.off === 'function'
    && typeof transport.removeAllListeners === 'function'
  ) {
    return transport as ElectronIpcTransport;
  }
  return null;
}

async function invokeChannel(channel: string, payload?: unknown): Promise<any> {
  try {
    const transport = getElectronTransport();
    if (!transport) {
      throw new Error('Electron IPC transport is unavailable');
    }
    return await transport.invoke(channel, payload ?? null);
  } catch (error) {
    console.warn(`[RedBox] invoke failed for ${channel}:`, error);
    return buildFallbackResponse(channel, error);
  }
}

function sendChannel(channel: string, payload?: unknown): void {
  const transport = getElectronTransport();
  if (!transport) {
    console.warn(`[RedBox] send skipped for ${channel}: Electron IPC transport is unavailable`);
    return;
  }
  transport.send(channel, payload ?? null);
}

async function invokeCommand<T = unknown>(command: string, args?: unknown): Promise<T> {
  try {
    const transport = getElectronTransport();
    if (!transport) {
      throw new Error('Electron IPC transport is unavailable');
    }
    return await transport.invoke(explicitChannelByCommand[command] || command, args ?? null);
  } catch (error) {
    console.warn(`[RedBox] command invoke failed for ${command}:`, error);
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
      console.warn(`[RedBox] invoke timed out for ${channel}:`, timeoutError.message);
      return resolveGuardFallback(channel, timeoutError, options?.fallback);
    }

    if (options?.normalize) {
      try {
        return options.normalize(value);
      } catch (error) {
        console.warn(`[RedBox] invoke normalization failed for ${channel}:`, error);
        return resolveGuardFallback(channel, error, options?.fallback);
      }
    }

    return value as T;
  } catch (error) {
    console.warn(`[RedBox] guarded invoke failed for ${channel}:`, error);
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
      console.warn(`[RedBox] command invoke timed out for ${command}:`, timeoutError.message);
      return resolveGuardFallback(fallbackKey, timeoutError, options?.fallback);
    }

    if (options?.normalize) {
      try {
        return options.normalize(value);
      } catch (error) {
        console.warn(`[RedBox] command normalization failed for ${command}:`, error);
        return resolveGuardFallback(fallbackKey, error, options?.fallback);
      }
    }

    return value as T;
  } catch (error) {
    return resolveGuardFallback(fallbackKey, error, options?.fallback);
  }
}

function on(channel: string, listener: Listener): void {
  const transport = getElectronTransport();
  if (!transport) {
    console.warn(`[RedBox] listener skipped for ${channel}: Electron IPC transport is unavailable`);
    return;
  }

  const entry: ListenerRecord = {};
  if (!channelListeners.has(channel)) {
    channelListeners.set(channel, new Map());
  }
  channelListeners.get(channel)!.set(listener, entry);

  const wrappedListener: Listener = (...args: unknown[]) => {
    listener({ __electron: true, channel }, ...args);
  };
  transport.on(channel, wrappedListener);
  entry.dispose = () => transport.off(channel, wrappedListener);
}

function off(channel: string, listener: Listener): void {
  const channelMap = channelListeners.get(channel);
  const record = channelMap?.get(listener);
  if (!record) return;

  record.disposed = true;
  record.dispose?.();
  channelMap?.delete(listener);
  if (channelMap && channelMap.size === 0) {
    channelListeners.delete(channel);
  }
}

function removeAllListeners(channel: string): void {
  const channelMap = channelListeners.get(channel);
  const transport = getElectronTransport();
  if (!channelMap) {
    transport?.removeAllListeners(channel);
    return;
  }
  for (const [listener, record] of channelMap.entries()) {
    record.disposed = true;
    record.dispose?.();
    channelMap.delete(listener);
  }
  transport?.removeAllListeners(channel);
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
