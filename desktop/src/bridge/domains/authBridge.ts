import type { BridgeCore, Listener } from '../types';

export function createAuthBridge(core: BridgeCore) {
  return {
    officialAuth: {
      bootstrap: (payload?: { reason?: string }) => core.invokeChannel('redbox-auth:bootstrap', payload || {}),
      refresh: () => core.invokeChannel('redbox-auth:refresh'),
      getConfig: () => core.invokeChannel('redbox-auth:get-config'),
      getWechatStatus: (payload: { sessionId: string }) =>
        core.invokeChannel('redbox-auth:wechat-status', payload),
      getWechatUrl: (payload?: { state?: string }) =>
        core.invokeChannel('redbox-auth:wechat-url', payload || {}),
      sendSmsCode: (payload: { phone: string }) => core.invokeChannel('redbox-auth:send-sms-code', payload),
      loginSms: (payload: { phone: string; code: string; inviteCode?: string }) =>
        core.invokeChannel('redbox-auth:login-sms', payload),
      registerSms: (payload: { phone: string; code: string; inviteCode?: string }) =>
        core.invokeChannel('redbox-auth:register-sms', payload),
      getPricing: () => core.invokeChannel('redbox-auth:pricing'),
      refreshPricing: () => core.invokeChannel('redbox-auth:pricing-refresh'),
    },
    llmReadiness: {
      getState: () => core.invokeChannel('llm-readiness:get-state'),
      refresh: () => core.invokeChannel('llm-readiness:refresh'),
      configureCustomSource: (payload: unknown) =>
        core.invokeChannel('llm-readiness:configure-custom-source', payload),
      onStateChanged: (listener: Listener) => core.on('llm-readiness:state-changed', listener),
      offStateChanged: (listener: Listener) => core.off('llm-readiness:state-changed', listener),
    },
    auth: {
      getState: () => core.invokeChannel('auth:get-state'),
      loginSms: (payload: { phone: string; code: string; inviteCode?: string }) =>
        core.invokeChannel('auth:login-sms', payload),
      loginWechatStart: (payload?: { state?: string }) =>
        core.invokeChannel('auth:login-wechat-start', payload || {}),
      loginWechatPoll: (payload: { sessionId: string }) => core.invokeChannel('auth:login-wechat-poll', payload),
      logout: () => core.invokeChannel('auth:logout'),
      refreshNow: () => core.invokeChannel('auth:refresh-now'),
      onStateChanged: (listener: Listener) => core.on('auth:state-changed', listener),
      offStateChanged: (listener: Listener) => core.off('auth:state-changed', listener),
      onDataChanged: (listener: Listener) => core.on('auth:data-changed', listener),
      offDataChanged: (listener: Listener) => core.off('auth:data-changed', listener),
    },
  };
}
