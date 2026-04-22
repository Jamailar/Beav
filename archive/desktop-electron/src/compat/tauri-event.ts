import { getElectronIpcTransport } from './electronTransport';

type EventCallback<T> = (event: { event: string; id: number; payload: T }) => void;

let nextListenerId = 1;

export async function listen<T = unknown>(
  channel: string,
  callback: EventCallback<T>,
): Promise<() => void> {
  const transport = getElectronIpcTransport();
  const listenerId = nextListenerId++;
  const listener = (...args: unknown[]) => {
    const payload = (args.length > 1 ? args[1] : args[0]) as T;
    callback({
      event: channel,
      id: listenerId,
      payload,
    });
  };

  transport.on(channel, listener);
  return () => {
    transport.off(channel, listener);
  };
}
