export {};

import type { IpcRendererBridge } from '../src/bridge/ipcRenderer';

declare global {
  interface Window {
    ipcRenderer: IpcRendererBridge;
  }
}
