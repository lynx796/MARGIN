import { FontSet, type FontBytes } from '@margin/core/fonts';
import { redactPdf, type RedactInput, type TermMatch } from '@margin/core/pseudo';

// Redaction (spec §10.3) off the main thread: MuPDF (WASM) removes the glyphs, pdf-lib draws the
// tokens and scrubs the file. Verification runs afterwards on the main thread, independently.

export interface PseudoRequest extends Omit<RedactInput, 'fonts' | 'random'> {
  fonts: FontBytes;
}

export type PseudoResponse = { ok: true; bytes: Uint8Array; matches: TermMatch[]; scrubbed: string[] } | { ok: false; code: string; message: string };

self.onmessage = async (event: MessageEvent<PseudoRequest>) => {
  try {
    const { fonts, ...rest } = event.data;
    const r = await redactPdf({ ...rest, fonts: new FontSet(fonts) });
    (self as unknown as Worker).postMessage({ ok: true, bytes: r.bytes, matches: r.matches, scrubbed: r.scrubbed } satisfies PseudoResponse, [r.bytes.buffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ ok: false, code: (e as { code?: string }).code ?? 'internal', message: (e as Error).message } satisfies PseudoResponse);
  }
};
