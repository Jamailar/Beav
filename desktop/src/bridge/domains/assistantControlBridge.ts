import type { BridgeCore } from '../types';

export function createAssistantControlBridge(core: BridgeCore) {
  return {
    assistantDaemon: {
      getStatus: () => core.invokeChannel('assistant:daemon-status'),
      start: (payload?: Record<string, unknown>) => core.invokeChannel('assistant:daemon-start', payload || {}),
      stop: () => core.invokeChannel('assistant:daemon-stop'),
      setConfig: (payload?: Record<string, unknown>) => core.invokeChannel('assistant:daemon-set-config', payload || {}),
      startWeixinLogin: (payload?: Record<string, unknown>) => core.invokeChannel('assistant:daemon-weixin-login-start', payload || {}),
      waitForWeixinLogin: (payload?: Record<string, unknown>) => core.invokeChannel('assistant:daemon-weixin-login-wait', payload || {}),
    },
    wechatOfficial: {
      getStatus: () => core.invokeChannel('wechat-official:get-status'),
      bind: (payload: Record<string, unknown>) => core.invokeChannel('wechat-official:bind', payload),
      unbind: (payload?: Record<string, unknown>) => core.invokeChannel('wechat-official:unbind', payload || {}),
      createDraft: (payload: Record<string, unknown>) => core.invokeChannel('wechat-official:create-draft', payload),
    },
  };
}
