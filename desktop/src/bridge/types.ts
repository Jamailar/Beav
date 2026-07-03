export type Listener = (...args: any[]) => void;

export type GuardedFallbackValue<T> = T | null | (() => T | null);

export type InvokeGuardOptions<T> = {
  timeoutMs?: number;
  fallback?: GuardedFallbackValue<T>;
  normalize?: (value: unknown) => T;
};

export type ListenerRecord = {
  pending?: Promise<() => void>;
  dispose?: () => void;
  disposed?: boolean;
};

export type BridgeCore = {
  isTauriRuntime: () => boolean;
  on: (channel: string, listener: Listener) => void;
  off: (channel: string, listener: Listener) => void;
  removeAllListeners: (channel: string) => void;
  sendChannel: (channel: string, payload?: unknown) => void;
  invokeChannel: (channel: string, payload?: unknown) => Promise<any>;
  invokeChannelGuarded: <T = unknown>(
    channel: string,
    payload?: unknown,
    options?: InvokeGuardOptions<T>,
  ) => Promise<T>;
  invokeCommand: <T = unknown>(command: string, args?: unknown) => Promise<T>;
  invokeCommandGuarded: <T = unknown>(
    command: string,
    args?: unknown,
    options?: InvokeGuardOptions<T> & { fallbackChannel?: string },
  ) => Promise<T>;
};
