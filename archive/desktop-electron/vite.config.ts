import { defineConfig } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// Custom plugin to copy prompt library files
function copyPromptLibrary() {
  return {
    name: 'copy-prompt-library',
    closeBundle: () => {
      const srcDir = path.resolve(__dirname, 'electron/prompts/library')
      const destDir = path.resolve(__dirname, 'dist-electron/library')

      if (fs.existsSync(srcDir)) {
        fs.cpSync(srcDir, destDir, { recursive: true })
        console.log(`[copy-prompt-library] Copied prompts from ${srcDir} to ${destDir}`)
      } else {
        console.warn(`[copy-prompt-library] Source directory not found: ${srcDir}`)
      }
    }
  }
}

function copyBuiltinSkills() {
  return {
    name: 'copy-builtin-skills',
    closeBundle: () => {
      const srcDir = path.resolve(__dirname, 'electron/builtin-skills')
      const destDir = path.resolve(__dirname, 'dist-electron/builtin-skills')

      if (fs.existsSync(srcDir)) {
        fs.cpSync(srcDir, destDir, { recursive: true })
        console.log(`[copy-builtin-skills] Copied builtin skills from ${srcDir} to ${destDir}`)
      } else {
        console.warn(`[copy-builtin-skills] Source directory not found: ${srcDir}`)
      }
    }
  }
}

function copyWorkerScripts() {
  return {
    name: 'copy-worker-scripts',
    closeBundle: () => {
      const srcDir = path.resolve(__dirname, 'electron/workers')
      const destDir = path.resolve(__dirname, 'dist-electron/workers')

      if (fs.existsSync(srcDir)) {
        fs.cpSync(srcDir, destDir, { recursive: true })
        console.log(`[copy-worker-scripts] Copied worker scripts from ${srcDir} to ${destDir}`)
      } else {
        console.warn(`[copy-worker-scripts] Source directory not found: ${srcDir}`)
      }
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react';
          }
          if (
            id.includes('/@codemirror/')
            || id.includes('/@uiw/')
            || id.includes('/@lezer/')
            || id.includes('/refractor/')
          ) {
            return 'vendor-editor';
          }
          if (
            id.includes('/react-markdown/')
            || id.includes('/remark-gfm/')
            || id.includes('/tippy.js/')
          ) {
            return 'vendor-content';
          }
          if (id.includes('/@xyflow/')) {
            return 'vendor-flow';
          }
          if (
            id.includes('/openai/')
            || id.includes('/ai/')
            || id.includes('/@ai-sdk/')
            || id.includes('/@google/genai/')
            || id.includes('/@mariozechner/')
          ) {
            return 'vendor-ai';
          }
          if (
            id.includes('/lucide-react/')
            || id.includes('/clsx/')
            || id.includes('/tailwind-merge/')
          ) {
            return 'vendor-ui';
          }
          return undefined;
        },
      },
    },
  },
  plugins: [
    react(),
    copyPromptLibrary(),
    copyBuiltinSkills(),
    copyWorkerScripts(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        vite: {
          resolve: {
            alias: [
              {
                find: /^ws$/,
                replacement: path.resolve(__dirname, 'electron/shims/ws-interop-safe.mjs'),
              },
            ],
          },
          build: {
            rollupOptions: {
              // Keep native/optional-node deps external.
              // `ws` has optional deps (`bufferutil` / `utf-8-validate`) that should be resolved at runtime
              // instead of being force-bundled by Rollup.
              external: (id) => (
                id === 'better-sqlite3'
                || id === 'bufferutil'
                || id === 'utf-8-validate'
                || id === 'undici'
                || id === 'jsdom'
                || id.startsWith('jsdom/')
                || id === 'canvas'
                || id.startsWith('canvas/')
                || id === '@weixin-claw/core'
                || id.startsWith('@weixin-claw/core/')
              ),
            },
          },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        input: 'electron/preload.ts',
      },
      // Ployfill the Electron and Node.js built-in modules for Renderer process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: {},
    }),
  ],
  server: {
    fs: {
      allow: [path.resolve(__dirname)],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/vendor/freecut'),
      '@redbox': path.resolve(__dirname, 'src'),
      '@tauri-apps/api/core': path.resolve(__dirname, 'src/compat/tauri-core.ts'),
      '@tauri-apps/api/event': path.resolve(__dirname, 'src/compat/tauri-event.ts'),
    },
  },
})
