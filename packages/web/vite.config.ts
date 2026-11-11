import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';
import { CSP } from '../bridge/src/csp.ts';
import { offline } from './offline.ts';

// The CSP of spec §11 (shared with `margin serve`) is injected into production builds; the dev
// server needs inline scripts for hot reload.
const csp = (): Plugin => ({
  name: 'margin-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
});

export default defineConfig({
  plugins: [svelte(), csp(), offline()],
  build: {
    target: 'es2023',
    // Every asset is a real file, so `font-src 'self'` and `img-src 'self'` suffice (no data: URLs).
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
  },
  worker: { format: 'es' },
  // MuPDF finds its WASM via new URL(…, import.meta.url), which pre-bundling would break.
  optimizeDeps: { exclude: ['mupdf'] },
  server: { port: 5173, fs: { allow: ['../..'] } },
});
