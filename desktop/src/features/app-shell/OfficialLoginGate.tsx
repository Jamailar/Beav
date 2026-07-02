import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDown, Loader2, Minus, ShieldCheck, Square, X } from 'lucide-react';
import QRCode from 'qrcode';
import { AppDialogsHost } from '../../components/AppDialogsHost';
import { AI_SOURCE_PRESETS, DEFAULT_AI_PRESET_ID } from '../../config/aiSources';
import { APP_BRAND } from '../../config/brand';
import googleIcon from '../../assets/auth/google.svg';
import wechatIcon from '../../assets/auth/wechat.svg';

export type OfficialAuthGateMode = 'checking' | 'login' | 'expired';
type LoginNoticeType = 'idle' | 'success' | 'error';
type OfficialAuthRealm = 'cn' | 'global';
type LlmSetupTab = 'official' | 'custom';
type AppShellPlatform = 'mac' | 'windows' | null;

function getAppShellPlatform(): AppShellPlatform {
  if (typeof navigator === 'undefined') return null;
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  if (/\bMac\b/i.test(platform) || /\bMac OS X\b/i.test(userAgent)) return 'mac';
  if (/\bWin/i.test(platform) || /\bWindows\b/i.test(userAgent)) return 'windows';
  return null;
}

function TransparentWindowTitleBar() {
  const platform = getAppShellPlatform();
  if (platform !== 'windows') return null;

  const startWindowDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button,a,input,textarea,select,[role="button"],[data-no-window-drag]')) return;
    event.preventDefault();
    void window.ipcRenderer.windowControls.startDragging().catch((error) => {
      console.warn(`[${APP_BRAND.displayName}] failed to start window drag:`, error);
    });
  };

  const toggleWindowMaximize = () => {
    void window.ipcRenderer.windowControls.toggleMaximize().catch((error) => {
      console.warn(`[${APP_BRAND.displayName}] failed to toggle window maximize:`, error);
    });
  };

  const handleTitleBarDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button,a,input,textarea,select,[role="button"],[data-no-window-drag]')) return;
    toggleWindowMaximize();
  };

  return (
    <header
      data-tauri-drag-region
      onMouseDown={startWindowDrag}
      onDoubleClick={handleTitleBarDoubleClick}
      className="app-titlebar app-auth-titlebar app-titlebar--windows shrink-0"
    >
      <div data-tauri-drag-region className="app-titlebar-title" />
      <div className="app-titlebar-window-controls" data-no-window-drag>
        <button
          type="button"
          onClick={() => {
            void window.ipcRenderer.windowControls.minimize();
          }}
          className="app-titlebar-window-button"
          title="最小化"
          aria-label="最小化"
          data-no-window-drag
        >
          <Minus className="h-[14px] w-[14px]" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={toggleWindowMaximize}
          className="app-titlebar-window-button"
          title="最大化"
          aria-label="最大化"
          data-no-window-drag
        >
          <Square className="h-[11px] w-[11px]" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={() => {
            void window.ipcRenderer.windowControls.close();
          }}
          className="app-titlebar-window-button app-titlebar-window-button--close"
          title="关闭"
          aria-label="关闭"
          data-no-window-drag
        >
          <X className="h-[14px] w-[14px]" strokeWidth={1.8} />
        </button>
      </div>
    </header>
  );
}

function isLikelyImageUrl(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('data:image/')
    || normalized.startsWith('blob:')
    || /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?(#.*)?$/i.test(normalized);
}

async function buildWechatQrDataUrl(value: string): Promise<string> {
  const content = String(value || '').trim();
  if (!content) {
    throw new Error('二维码内容为空');
  }
  if (isLikelyImageUrl(content)) {
    return content;
  }
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 420,
    color: {
      dark: '#111827',
      light: '#ffffff',
    },
  });
}

export function OfficialLoginGate({ mode }: { mode: OfficialAuthGateMode }) {
  const [activeRealm, setActiveRealm] = useState<OfficialAuthRealm>('cn');
  const [activeSetupTab, setActiveSetupTab] = useState<LlmSetupTab>('official');
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsAuthMode, setSmsAuthMode] = useState<'login' | 'register' | null>(null);
  const [smsForm, setSmsForm] = useState({ phone: '', code: '', inviteCode: '' });
  const [customBusy, setCustomBusy] = useState(false);
  const [customForm, setCustomForm] = useState({
    presetId: DEFAULT_AI_PRESET_ID,
    baseURL: AI_SOURCE_PRESETS.find((preset) => preset.id === DEFAULT_AI_PRESET_ID)?.baseURL || '',
    apiKey: '',
  });
  const [wechatBusy, setWechatBusy] = useState(false);
  const [wechatQrUrl, setWechatQrUrl] = useState('');
  const [wechatStatus, setWechatStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState<LoginNoticeType>('idle');
  const wechatSessionIdRef = useRef('');
  const wechatPollTimerRef = useRef<number | null>(null);
  const wechatPollTokenRef = useRef(0);

  const setLoginNotice = useCallback((type: LoginNoticeType, message: string) => {
    setNoticeType(type);
    setNotice(message);
  }, []);

  const refreshAuthAfterLogin = useCallback(() => {
    void window.ipcRenderer.officialAuth.bootstrap({ reason: 'login-gate-authenticated' })
      .finally(() => {
        void window.ipcRenderer.llmReadiness.refresh();
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = async () => {
      try {
        const result = await window.ipcRenderer.officialAuth.getConfig() as {
          success?: boolean;
          activeRealm?: OfficialAuthRealm;
        };
        if (!cancelled && result?.success) {
          setActiveRealm(result.activeRealm === 'global' ? 'global' : 'cn');
        }
      } catch {
        if (!cancelled) {
          setActiveRealm('cn');
        }
      }
    };
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const stopWechatPolling = useCallback(() => {
    wechatPollTokenRef.current += 1;
    if (wechatPollTimerRef.current !== null) {
      window.clearTimeout(wechatPollTimerRef.current);
      wechatPollTimerRef.current = null;
    }
  }, []);

  const pollWechatStatus = useCallback((sessionId: string, token: number) => {
    const run = async () => {
      if (wechatPollTokenRef.current !== token) return;
      try {
        const result = await window.ipcRenderer.officialAuth.getWechatStatus({ sessionId }) as {
          success?: boolean;
          data?: {
            status?: string;
            session?: unknown;
          };
          error?: string;
        };
        if (!result?.success) {
          throw new Error(result?.error || '微信登录状态检查失败');
        }

        const nextStatus = String(result.data?.status || '').toUpperCase();
        setWechatStatus(nextStatus);
        if (nextStatus === 'CONFIRMED') {
          if (!result.data?.session) {
            throw new Error('微信登录已确认，但服务端未返回登录凭证，请重新扫码。');
          }
          stopWechatPolling();
          setLoginNotice('success', '登录成功，正在进入工作台…');
          refreshAuthAfterLogin();
          return;
        }
        if (nextStatus === 'EXPIRED' || nextStatus === 'FAILED') {
          stopWechatPolling();
          setLoginNotice('error', nextStatus === 'EXPIRED' ? '二维码已过期，请重新获取。' : '微信登录失败，请重试。');
          return;
        }
      } catch (error) {
        setWechatStatus('FAILED');
        setLoginNotice('error', error instanceof Error ? error.message : '微信登录状态检查失败');
      }

      if (wechatPollTokenRef.current === token) {
        wechatPollTimerRef.current = window.setTimeout(run, 900);
      }
    };

    wechatPollTimerRef.current = window.setTimeout(run, 300);
  }, [refreshAuthAfterLogin, setLoginNotice, stopWechatPolling]);

  useEffect(() => {
    return () => stopWechatPolling();
  }, [stopWechatPolling]);

  const startWechatLogin = useCallback(async () => {
    setWechatBusy(true);
    stopWechatPolling();
    try {
      const result = await window.ipcRenderer.officialAuth.getWechatUrl({ state: 'redconvert-desktop' }) as {
        success?: boolean;
        data?: {
          sessionId?: string;
          qrContentUrl?: string;
          url?: string;
        };
        error?: string;
      };
      if (!result?.success || !result.data) {
        throw new Error(result?.error || '微信登录初始化失败');
      }
      const sessionId = String(result.data.sessionId || '').trim();
      const qrContent = String(result.data.qrContentUrl || result.data.url || '').trim();
      if (!sessionId || !qrContent) {
        throw new Error('微信登录二维码数据不完整');
      }
      const qrUrl = await buildWechatQrDataUrl(qrContent);
      wechatSessionIdRef.current = sessionId;
      setWechatQrUrl(qrUrl);
      setWechatStatus('PENDING');
      setLoginNotice('idle', '');
      const token = wechatPollTokenRef.current + 1;
      wechatPollTokenRef.current = token;
      pollWechatStatus(sessionId, token);
    } catch (error) {
      setWechatStatus('');
      setWechatQrUrl('');
      setLoginNotice('error', error instanceof Error ? error.message : '微信登录初始化失败');
    } finally {
      setWechatBusy(false);
    }
  }, [pollWechatStatus, setLoginNotice, stopWechatPolling]);

  const sendSmsCode = useCallback(async () => {
    const phone = String(smsForm.phone || '').trim();
    if (!phone) {
      setLoginNotice('error', '请先输入手机号');
      return;
    }
    setSmsBusy(true);
    try {
      const result = await window.ipcRenderer.officialAuth.sendSmsCode({ phone }) as {
        success?: boolean;
        error?: string;
      };
      if (!result?.success) {
        throw new Error(result?.error || '验证码发送失败');
      }
      setLoginNotice('success', '验证码已发送');
    } catch (error) {
      setLoginNotice('error', error instanceof Error ? error.message : '验证码发送失败');
    } finally {
      setSmsBusy(false);
    }
  }, [setLoginNotice, smsForm.phone]);

  const handleSmsAuth = useCallback(async (mode: 'login' | 'register') => {
    const phone = String(smsForm.phone || '').trim();
    const code = String(smsForm.code || '').trim();
    if (!phone || !code) {
      setLoginNotice('error', '请输入手机号和验证码');
      return;
    }
    setSmsBusy(true);
    setSmsAuthMode(mode);
    try {
      const inviteCode = String(smsForm.inviteCode || '').trim();
      const smsPayload: { phone: string; code: string; inviteCode?: string } = mode === 'register'
        ? { phone, code, inviteCode: inviteCode || undefined }
        : { phone, code };
      const result = await (
        mode === 'login'
          ? window.ipcRenderer.officialAuth.loginSms(smsPayload)
          : window.ipcRenderer.officialAuth.registerSms(smsPayload)
      ) as {
        success?: boolean;
        session?: unknown;
        error?: string;
      };
      if (!result?.success || !result.session) {
        throw new Error(result?.error || (mode === 'login' ? '登录失败' : '注册失败'));
      }
      setLoginNotice('success', mode === 'login' ? '登录成功，正在进入工作台…' : '注册成功，正在进入工作台…');
      refreshAuthAfterLogin();
    } catch (error) {
      setLoginNotice('error', error instanceof Error ? error.message : (mode === 'login' ? '登录失败' : '注册失败'));
    } finally {
      setSmsBusy(false);
      setSmsAuthMode(null);
    }
  }, [refreshAuthAfterLogin, setLoginNotice, smsForm.code, smsForm.inviteCode, smsForm.phone]);

  const startGoogleLogin = useCallback(() => {
    setLoginNotice('error', 'Google 登录通道尚未接入。');
  }, [setLoginNotice]);

  const handleCustomPresetChange = useCallback((presetId: string) => {
    const preset = AI_SOURCE_PRESETS.find((item) => item.id === presetId) || AI_SOURCE_PRESETS.find((item) => item.id === DEFAULT_AI_PRESET_ID);
    setCustomForm((prev) => ({
      ...prev,
      presetId: preset?.id || DEFAULT_AI_PRESET_ID,
      baseURL: preset?.baseURL || prev.baseURL,
    }));
    setLoginNotice('idle', '');
  }, [setLoginNotice]);

  const handleCustomApiSetup = useCallback(async () => {
    const preset = AI_SOURCE_PRESETS.find((item) => item.id === customForm.presetId);
    const baseURL = String(customForm.baseURL || '').trim();
    const apiKey = String(customForm.apiKey || '').trim();
    if (!baseURL) {
      setLoginNotice('error', '请先填写 API Base URL');
      return;
    }
    setCustomBusy(true);
    setLoginNotice('idle', '正在保存模型配置…');
    try {
      const result = await window.ipcRenderer.llmReadiness.configureCustomSource({
        baseURL,
        apiKey,
        presetId: customForm.presetId,
        protocol: preset?.protocol,
        name: preset?.label || 'Custom API',
      });
      if (!result?.success) {
        throw new Error(result?.error || '自定义 API 配置失败');
      }
      const model = String((result.source as { model?: unknown } | undefined)?.model || '').trim();
      setLoginNotice('success', model ? `已选择 ${model}，正在进入工作台…` : '配置成功，正在进入工作台…');
      void window.ipcRenderer.llmReadiness.refresh();
    } catch (error) {
      setLoginNotice('error', error instanceof Error ? error.message : '自定义 API 配置失败');
    } finally {
      setCustomBusy(false);
    }
  }, [customForm.apiKey, customForm.baseURL, customForm.presetId, setLoginNotice]);

  const returnToSmsLogin = useCallback(() => {
    stopWechatPolling();
    setWechatQrUrl('');
    setWechatStatus('');
    setLoginNotice('idle', '');
  }, [setLoginNotice, stopWechatPolling]);

  const isMainlandRealm = activeRealm === 'cn';
  const authBusy = wechatBusy || smsBusy || customBusy;
  const showMainlandWechatQr = isMainlandRealm && Boolean(wechatQrUrl);
  const title = mode === 'checking'
    ? '正在恢复会话'
    : `欢迎回到 ${APP_BRAND.displayName}`;
  const subtitle = mode === 'checking'
    ? `正在恢复 ${APP_BRAND.displayName} 的登录状态。`
    : mode === 'expired'
      ? '登录状态已过期，请重新登录或配置自定义 API。'
      : `选择 ${APP_BRAND.displayName} 的 AI 运行方式。`;
  const inputClassName = 'h-12 w-full rounded-2xl bg-[rgb(var(--color-surface-primary)/0.86)] px-4 text-sm text-[rgb(var(--color-text-primary))] shadow-[inset_0_0_0_1px_rgb(var(--color-border)/0.58)] outline-none transition placeholder:text-[rgb(var(--color-text-secondary)/0.62)] focus:bg-[rgb(var(--color-surface-primary)/0.98)] focus:shadow-[inset_0_0_0_1px_rgb(var(--color-accent-primary)/0.38),0_0_0_3px_rgb(var(--color-accent-primary)/0.10)] disabled:opacity-60';
  const selectClassName = `${inputClassName} appearance-none pr-11`;
  const primaryButtonClassName = 'h-12 w-full rounded-2xl bg-[rgb(var(--color-accent-primary))] text-sm font-semibold text-white transition hover:bg-[rgb(var(--color-accent-hover))] active:scale-[0.99] disabled:opacity-60';
  const secondaryButtonClassName = 'flex h-[56px] w-full items-center justify-center gap-3 rounded-2xl bg-[rgb(var(--color-surface-secondary)/0.62)] text-base font-semibold text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-primary)/0.78)] hover:text-[rgb(var(--color-text-primary))] active:scale-[0.99] disabled:opacity-60';
  const sectionLabelClassName = 'text-sm font-semibold text-[rgb(var(--color-text-primary))]';

  return (
    <>
      <div className="min-h-screen overflow-hidden bg-[rgb(var(--color-background))] text-[rgb(var(--color-text-primary))]">
        <TransparentWindowTitleBar />
        <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(135deg,rgb(var(--color-background))_0%,rgb(var(--color-surface-secondary)/0.82)_52%,rgb(var(--color-accent-muted)/0.46)_100%)]" />
        <div className="relative grid min-h-screen grid-cols-1 lg:grid-cols-[1fr_520px]">
          <section className="hidden lg:flex min-h-screen flex-col justify-center px-[12vw]">
            <div className="relative h-[420px] w-[360px]">
              <img
                src={APP_BRAND.logoSrc}
                alt=""
                className="absolute left-0 top-0 h-[260px] w-[260px] object-contain opacity-90"
              />
              <div className="absolute left-0 bottom-20 flex items-center gap-3">
                <img src={APP_BRAND.logoSrc} alt="" className="h-10 w-10 object-contain" />
                <div className="text-4xl font-semibold tracking-[0] text-[rgb(var(--color-text-primary))]">{APP_BRAND.displayName}</div>
              </div>
              <p className="absolute bottom-10 left-0 max-w-[300px] text-[13px] leading-6 text-[rgb(var(--color-text-secondary))]">
                {APP_BRAND.tagline || 'The AI content workspace that helps your ideas thrive.'}
              </p>
            </div>
            <div className="absolute bottom-10 left-12 flex items-center gap-2 text-xs text-[rgb(var(--color-text-tertiary))]">
              <ShieldCheck className="h-4 w-4 text-[rgb(var(--color-accent-primary))]" />
              本地优先，登录态加密保存。
            </div>
          </section>

          <main className="flex min-h-screen items-center justify-center px-6 py-8 lg:justify-start lg:px-0">
            <div className="w-full max-w-[432px]">
              <div className="mb-10 text-center lg:text-left">
                <h1 className="text-4xl font-semibold tracking-[0] text-[rgb(var(--color-text-primary))]">{title}</h1>
                <p className="mt-3 text-base text-[rgb(var(--color-text-secondary))]">{subtitle}</p>
              </div>

              {mode === 'checking' ? (
                <div className="flex h-52 items-center justify-center rounded-[24px] bg-[rgb(var(--color-surface-secondary)/0.52)] text-[rgb(var(--color-text-secondary))]">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在恢复账号
                </div>
              ) : (
                <div className="space-y-5">
                  {activeSetupTab === 'custom' ? (
                    <form
                      className="space-y-4"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleCustomApiSetup();
                      }}
                    >
                      <div className={sectionLabelClassName}>自定义 API</div>
                      <div className="relative">
                        <select
                          value={customForm.presetId}
                          onChange={(event) => handleCustomPresetChange(event.target.value)}
                          disabled={authBusy}
                          className={selectClassName}
                        >
                          {AI_SOURCE_PRESETS.filter((preset) => preset.id !== 'redbox-official').map((preset) => (
                            <option key={preset.id} value={preset.id}>{preset.label}</option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--color-text-tertiary))]" />
                      </div>
                      <input
                        type="url"
                        value={customForm.baseURL}
                        onChange={(event) => setCustomForm((prev) => ({ ...prev, baseURL: event.target.value }))}
                        placeholder="API Base URL"
                        autoComplete="url"
                        disabled={authBusy}
                        className={inputClassName}
                      />
                      <input
                        type="password"
                        value={customForm.apiKey}
                        onChange={(event) => setCustomForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                        placeholder="API Key"
                        autoComplete="off"
                        disabled={authBusy}
                        className={inputClassName}
                      />
                      <button
                        type="submit"
                        disabled={authBusy}
                        className={primaryButtonClassName}
                      >
                        {customBusy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : '继续'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSetupTab('official');
                          setLoginNotice('idle', '');
                        }}
                        disabled={authBusy}
                        className={secondaryButtonClassName}
                      >
                        返回登录
                      </button>
                    </form>
                  ) : showMainlandWechatQr ? (
                    <div className="space-y-5">
                      <div className="flex items-center justify-between gap-3">
                        <div className={sectionLabelClassName}>微信扫码登录</div>
                        <button
                          type="button"
                          onClick={returnToSmsLogin}
                          className="text-sm font-semibold text-[rgb(var(--color-text-secondary))] transition hover:text-[rgb(var(--color-accent-primary))]"
                        >
                          手机号/邀请码
                        </button>
                      </div>
                      <div className="flex justify-center py-2">
                        <img src={wechatQrUrl} alt="微信登录二维码" className="h-64 w-64 rounded-[20px] bg-white object-contain p-3" />
                      </div>
                    </div>
                  ) : isMainlandRealm && (
                    <form
                      className="space-y-4"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleSmsAuth('login');
                      }}
                    >
                      <div className={sectionLabelClassName}>手机号登录 / 注册</div>
                      <input
                        type="tel"
                        value={smsForm.phone}
                        onChange={(event) => setSmsForm((prev) => ({ ...prev, phone: event.target.value }))}
                        placeholder="手机号"
                        autoComplete="tel"
                        disabled={authBusy}
                        className={inputClassName}
                      />
                      <div className="grid grid-cols-[1fr_auto] gap-3">
                        <input
                          type="text"
                          value={smsForm.code}
                          onChange={(event) => setSmsForm((prev) => ({ ...prev, code: event.target.value }))}
                          placeholder="短信验证码"
                          autoComplete="one-time-code"
                          disabled={authBusy}
                          className={inputClassName}
                        />
                        <button
                          type="button"
                          onClick={() => void sendSmsCode()}
                          disabled={authBusy}
                          className="h-12 rounded-2xl bg-[rgb(var(--color-surface-secondary)/0.62)] px-4 text-sm font-semibold text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-primary)/0.78)] hover:text-[rgb(var(--color-text-primary))] disabled:opacity-60"
                        >
                          发送验证码
                        </button>
                      </div>
                      <input
                        type="text"
                        value={smsForm.inviteCode}
                        onChange={(event) => setSmsForm((prev) => ({ ...prev, inviteCode: event.target.value }))}
                        placeholder="好友邀请码（注册可选）"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        disabled={authBusy}
                        className={inputClassName}
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="submit"
                          disabled={authBusy}
                          className={primaryButtonClassName}
                        >
                          {smsAuthMode === 'login' ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : '登录账户'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSmsAuth('register')}
                          disabled={authBusy}
                          className="h-12 w-full rounded-2xl bg-[rgb(var(--color-surface-secondary)/0.62)] text-sm font-semibold text-[rgb(var(--color-text-secondary))] transition hover:bg-[rgb(var(--color-surface-primary)/0.78)] hover:text-[rgb(var(--color-text-primary))] active:scale-[0.99] disabled:opacity-60"
                        >
                          {smsAuthMode === 'register' ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : '注册新账号'}
                        </button>
                      </div>
                    </form>
                  )}

                  {activeSetupTab !== 'custom' && !showMainlandWechatQr && (
                    <div className="space-y-4">
                      {!isMainlandRealm && (
                        <button
                          type="button"
                          onClick={startGoogleLogin}
                          disabled={authBusy}
                          className={secondaryButtonClassName}
                        >
                          <img src={googleIcon} alt="" className="h-5 w-5" />
                          Continue with Google
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => void startWechatLogin()}
                        disabled={authBusy}
                        className={secondaryButtonClassName}
                      >
                        {wechatBusy ? <Loader2 className="h-5 w-5 animate-spin text-[rgb(var(--color-accent-primary))]" /> : <img src={wechatIcon} alt="" className="h-5 w-5" />}
                        微信登录
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          stopWechatPolling();
                          setActiveSetupTab((current) => current === 'custom' ? 'official' : 'custom');
                          setLoginNotice('idle', '');
                        }}
                        disabled={authBusy}
                        className={secondaryButtonClassName}
                      >
                        自定义 API
                      </button>
                    </div>
                  )}

                  {activeSetupTab !== 'custom' && wechatQrUrl && !showMainlandWechatQr && (
                    <div className="flex items-center gap-4">
                      <img src={wechatQrUrl} alt="微信登录二维码" className="h-24 w-24 rounded-2xl bg-white object-contain p-1" />
                      <div className="min-w-0 text-sm text-[rgb(var(--color-text-secondary))]">
                        <div className="font-semibold text-[rgb(var(--color-text-primary))]">微信扫码登录</div>
                      </div>
                    </div>
                  )}

                  {notice && (
                    <div className={`rounded-2xl border px-3 py-2 text-center text-sm ${
                      noticeType === 'error'
                        ? 'border-red-500/20 bg-red-500/10 text-red-500'
                        : noticeType === 'success'
                          ? 'border-[rgb(var(--color-accent-primary)/0.22)] bg-[rgb(var(--color-accent-primary)/0.08)] text-[rgb(var(--color-accent-primary))]'
                          : 'border-[rgb(var(--color-border)/0.72)] bg-[rgb(var(--color-surface-secondary)/0.54)] text-[rgb(var(--color-text-secondary))]'
                    }`}>
                      {notice}
                    </div>
                  )}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
      <AppDialogsHost />
    </>
  );
}
