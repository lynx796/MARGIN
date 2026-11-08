import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

// Content Security Policy of spec §11, injected into production builds (the dev server needs inline
// scripts for hot reload). `margin serve` also sends it as a header.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self' http://127.0.0.1:*",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'margin-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
});

export default defineConfig({
  plugins: [svelte(), csp()],
  build: {
    target: 'es2023',
    // Every asset is a real file, so `font-src 'self'` and `img-src 'self'` suffice (no data: URLs).
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
  },
  worker: { format: 'es' },
  server: { port: 5173, fs: { allow: ['../..'] } },
});
