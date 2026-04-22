type RawListener = (...args: unknown[]) => void;

type ElectronIpcTransport = {
  on: (channel: string, listener: RawListener) => void;
  off: (channel: string, listener: RawListener) => void;
  removeAllListeners: (channel: string) => void;
  send: (channel: string, payload?: unknown) => void;
  invoke: <T = unknown>(channel: string, payload?: unknown) => Promise<T>;
};

declare global {
  interface Window {
    __RED_ELECTRON_IPC__?: ElectronIpcTransport;
  }
}

export function getElectronIpcTransport(): ElectronIpcTransport {
  const transport = window.__RED_ELECTRON_IPC__;
  if (!transport) {
    throw new Error('Electron IPC transport is unavailable.');
  }
  return transport;
}

export type { ElectronIpcTransport, RawListener };
