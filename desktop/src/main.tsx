import './ipc/bootstrap';
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import 'tippy.js/dist/tippy.css'
import './index.css'
import { appAlert, appConfirm } from './utils/appDialogs'
import { installRendererDiagnostics, reportRendererError } from './logging/client'

const THEME_STORAGE_KEY = 'redbox:theme-mode:v1';

const initializeThemeMode = () => {
  try {
    const saved = String(window.localStorage.getItem(THEME_STORAGE_KEY) || '').trim().toLowerCase();
    const mode = (saved === 'light' || saved === 'dark')
      ? saved
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.classList.toggle('dark', mode === 'dark');
  } catch {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.classList.remove('dark');
  }
};

initializeThemeMode();
installRendererDiagnostics();

window.alert = ((message?: unknown) => {
  void appAlert(String(message ?? ''));
}) as typeof window.alert;

const disableNativeContextMenu = (event: MouseEvent) => {
  event.preventDefault();
};

document.addEventListener('contextmenu', disableNativeContextMenu);

void window.ipcRenderer.on('diagnostics:report-pending', async (payload) => {
  const summary = typeof payload?.summary === 'string'
    ? payload.summary
    : '已生成新的诊断报告。';
  const reportId = typeof payload?.id === 'string' ? payload.id : '';
  const confirmed = await appConfirm(
    `${summary}\n\n是否现在上传这份诊断报告？你也可以稍后在“设置 > 常规设置 > 诊断与日志”里处理。`,
    {
      title: '发送诊断报告',
      confirmLabel: '立即上传',
      cancelLabel: '稍后处理',
    },
  );
  if (!confirmed || !reportId) {
    return;
  }
  const result = await window.ipcRenderer.logs.uploadReport(reportId);
  if (result?.success) {
    await appAlert('诊断报告已上传。');
    return;
  }
  await appAlert(`诊断报告上传失败：${result?.error || '未知错误'}`);
});

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    void reportRendererError(error, {
      category: 'plugin.bridge',
      event: 'react.error_boundary',
      fields: {
        componentStack: errorInfo.componentStack,
      },
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, color: 'red', fontFamily: 'monospace' }}>
          <h1>Something went wrong.</h1>
          <h3>{this.state.error?.message}</h3>
          <pre>{this.state.error?.stack}</pre>
        </div>
      );
    }

    return this.props.children;
  }
}

const appTree = (
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

const isDevRuntime = window.location.protocol !== 'file:';

ReactDOM.createRoot(document.getElementById('root')!).render(
  isDevRuntime
    ? appTree
    : appTree,
)
