import './ipc/bootstrap';
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import 'tippy.js/dist/tippy.css'
import './index.css'

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
    ? <React.StrictMode>{appTree}</React.StrictMode>
    : appTree,
)
