declare module '@weixin-claw/core/auth/login-qr' {
  export function startWeixinLoginWithQr(opts: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
    apiBaseUrl: string;
    botType?: string;
  }): Promise<{
    qrcodeUrl?: string;
    message: string;
    sessionKey: string;
  }>;

  export function waitForWeixinLogin(opts: {
    timeoutMs?: number;
    verbose?: boolean;
    sessionKey: string;
    apiBaseUrl: string;
    botType?: string;
  }): Promise<{
    connected: boolean;
    botToken?: string;
    accountId?: string;
    baseUrl?: string;
    userId?: string;
    message: string;
  }>;
}

declare module '@weixin-claw/core/auth/accounts' {
  export function registerWeixinAccountId(accountId: string): void;
  export function saveWeixinAccount(accountId: string, update: {
    token?: string;
    baseUrl?: string;
    userId?: string;
  }): void;
}
