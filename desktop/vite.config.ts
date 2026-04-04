import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const desktopRoot = path.resolve(repoRoot, 'desktop');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    fs: {
      allow: [repoRoot, desktopRoot],
    },
  },
  resolve: {
    alias: {
      '@lexbox': path.resolve(__dirname, 'src'),
      '@desktop': desktopRoot,
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
});
