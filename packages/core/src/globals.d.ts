// Minimal declarations for web-platform globals that exist in both browsers and Node.
// Core is compiled without the DOM and Node type libraries so that accidental use of
// platform-specific APIs fails to typecheck.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string);
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer> };
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};
declare function structuredClone<T>(value: T): T;
declare const performance: { now(): number };
