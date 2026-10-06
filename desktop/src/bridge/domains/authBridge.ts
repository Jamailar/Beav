import type { BridgeCore, Listener } from '../types';

export function createAuthBridge(core: BridgeCore) {
  return {
    officialAuth: {
      bootstrap: (payload?: { reason?: string }) => core.invokeChannelGuarded(
        'redbox-auth:bootstrap',
        payload || {},
        {
          timeoutMs: 20000,
          fallback: { success: false, error: '官方账号恢复超时' },
        },
      ),
      refresh: () => core.invokeChannel('redbox-auth:refresh'),
      getConfig: () => core.invokeChannel('redbox-auth:get-config'),
      setRealm: (payload: { realm: 'cn' | 'global' }) => core.invokeChannel('redbox-auth:set-realm', payload),
      getMe: () => core.invokeChannel('redbox-auth:me'),
      getPoints: () => core.invokeChannel('redbox-auth:points'),
      getProducts: () => core.invokeChannel('redbox-auth:products'),
      getProduct: (payload: { productId: string }) => core.invokeChannel('redbox-auth:product', payload),
      getCallRecords: () => core.invokeChannel('redbox-auth:call-records'),
      getWechatStatus: (payload: { sessionId: string }) =>
        core.invokeChannel('redbox-auth:wechat-status', payload),
      getWechatUrl: (payload?: { state?: string }) =>
        core.invokeChannel('redbox-auth:wechat-url', payload || {}),
      sendSmsCode: (payload: { phone: string }) => core.invokeChannel('redbox-auth:send-sms-code', payload),
      loginSms: (payload: { phone: string; code: string; inviteCode?: string }) =>
        core.invokeChannel('redbox-auth:login-sms', payload),
      registerSms: (payload: { phone: string; code: string; inviteCode?: string }) =>
        core.invokeChannel('redbox-auth:register-sms', payload),
      logout: () => core.invokeChannel('redbox-auth:logout'),
      createPagePayOrder: (payload: Record<string, unknown>) =>
        core.invokeChannel('redbox-auth:create-page-pay-order', payload),
      getOrderStatus: (payload: { outTradeNo: string }) =>
        core.invokeChannel('redbox-auth:order-status', payload),
      openPaymentForm: (payload: { paymentForm: string }) =>
        core.invokeChannel('redbox-auth:open-payment-form', payload),
      getPricing: () => core.invokeChannel('redbox-auth:pricing'),
      refreshPricing: () => core.invokeChannel('redbox-auth:pricing-refresh'),
    },
    llmReadiness: {
      getState: () => core.invokeChannelGuarded(
        'llm-readiness:get-state',
        undefined,
        {
          timeoutMs: 3000,
          fallback: { ready: false, reason: 'timeout' },
        },
      ),
      refresh: () => core.invokeChannel('llm-readiness:refresh'),
      configureCustomSource: (payload: unknown) =>
        core.invokeChannel('llm-readiness:configure-custom-source', payload),
      onStateChanged: (listener: Listener) => core.on('llm-readiness:state-changed', listener),
      offStateChanged: (listener: Listener) => core.off('llm-readiness:state-changed', listener),
    },
    auth: {
      getState: () => core.invokeChannelGuarded(
        'auth:get-state',
        undefined,
        {
          timeoutMs: 3000,
          fallback: {
            status: 'anonymous',
            loggedIn: false,
            session: null,
            points: null,
            models: [],
            callRecords: [],
            degradedReason: null,
            lastError: null,
            lastErrorKind: null,
            lastRefreshAt: null,
            nextRefreshAtMs: null,
          },
        },
      ),
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
