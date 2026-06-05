import type { BridgeCore, Listener } from '../types';

export function createManuscriptsBridge(core: BridgeCore) {
  return {
    manuscripts: {
      list: <T = unknown>() => core.invokeChannel('manuscripts:list') as Promise<T>,
      read: <T = unknown>(filePath: string) => core.invokeChannel('manuscripts:read', filePath) as Promise<T>,
      save: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:save', payload) as Promise<T>,
      createFile: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:create-file', payload) as Promise<T>,
      createFolder: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:create-folder', payload) as Promise<T>,
      rename: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:rename', payload) as Promise<T>,
      move: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:move', payload) as Promise<T>,
      delete: <T = unknown>(targetPath: string) => core.invokeChannel('manuscripts:delete', targetPath) as Promise<T>,
      attachExternalFiles: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:attach-external-files', payload) as Promise<T>,
      getPackageState: <T = unknown>(targetPath: string) => core.invokeChannel('manuscripts:get-package-state', targetPath) as Promise<T>,
      generateRemotionScene: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:generate-remotion-scene', payload) as Promise<T>,
      saveRemotionScene: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:save-remotion-scene', payload) as Promise<T>,
      pickExportPath: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:pick-export-path', payload) as Promise<T>,
      renderRemotionVideo: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:render-remotion-video', payload) as Promise<T>,
      getWriteProposal: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:get-write-proposal', payload) as Promise<T>,
      acceptWriteProposal: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:accept-write-proposal', payload) as Promise<T>,
      rejectWriteProposal: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:reject-write-proposal', payload) as Promise<T>,
      confirmPackageScript: <T = unknown>(payload: { filePath: string }) => core.invokeChannel('manuscripts:confirm-package-script', payload) as Promise<T>,
      getLayout: <T = unknown>() => core.invokeChannel('manuscripts:get-layout') as Promise<T>,
      saveLayout: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('manuscripts:save-layout', payload) as Promise<T>,
      onRenderProgress: (listener: Listener) => core.on('manuscripts:render-progress', listener),
      offRenderProgress: (listener: Listener) => core.off('manuscripts:render-progress', listener),
      onWriteProposal: (listener: Listener) => core.on('manuscripts:write-proposal', listener),
      offWriteProposal: (listener: Listener) => core.off('manuscripts:write-proposal', listener),
    },
  };
}
