// Content Security Policy of spec §11. The build injects it as a meta tag (which cannot carry
// `frame-ancestors`); `margin serve` sends it as a header, with `frame-ancestors` added.

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

export const CSP_HEADER = `${CSP}; frame-ancestors 'none'`;
