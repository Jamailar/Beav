import type { Listener } from './types';

export type DataChangedPayload = {
  scope?: string;
  action?: string;
  entityId?: string;
};

export function subscribeSettingsUpdated(listener: Listener): () => void {
  window.ipcRenderer.onSettingsUpdated(listener);
  return () => window.ipcRenderer.offSettingsUpdated(listener);
}

export function subscribeDataChanged(listener: Listener): () => void {
  window.ipcRenderer.onDataChanged(listener);
  return () => window.ipcRenderer.offDataChanged(listener);
}

export function subscribeAppUpdateAvailable(listener: Listener): () => void {
  window.ipcRenderer.onAppUpdateAvailable(listener);
  return () => window.ipcRenderer.offAppUpdateAvailable(listener);
}

export function subscribeAppUpdateInstallProgress(listener: Listener): () => void {
  window.ipcRenderer.onAppUpdateInstallProgress(listener);
  return () => window.ipcRenderer.offAppUpdateInstallProgress(listener);
}

export function subscribeYoutubeFetchInfoProgress(listener: Listener): () => void {
  window.ipcRenderer.onFetchYoutubeInfoProgress(listener);
  return () => window.ipcRenderer.offFetchYoutubeInfoProgress(listener);
}

export function subscribeYoutubeInstallProgress(listener: Listener): () => void {
  window.ipcRenderer.on('youtube:install-progress', listener);
  return () => window.ipcRenderer.off('youtube:install-progress', listener);
}
