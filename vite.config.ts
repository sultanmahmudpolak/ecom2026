import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {execFileSync} from 'child_process';
import {defineConfig} from 'vite';

export default defineConfig(({command}) => {
  if (command === 'build') {
    process.env.NODE_ENV = 'production';
  }
  return {
    base: command === 'build' ? './' : '/',
    plugins: [
      react(),
      tailwindcss(),
    ],
    optimizeDeps: {
      entries: ['index.html'],
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname || '.', '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: false,
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: null,
    },
    build: {
      chunkSizeWarningLimit: 3500,
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          format: 'iife',
          name: 'StockMasterApp',
          codeSplitting: false,
          entryFileNames: 'assets/app.bundle.js',
          assetFileNames: (assetInfo) => {
            if (assetInfo.name && assetInfo.name.endsWith('.css')) {
              return 'assets/app.bundle.css';
            }
            return 'assets/[name][extname]';
          },
        },
      },
    },
  };
});

