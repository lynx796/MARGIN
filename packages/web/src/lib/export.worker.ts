import { FontSet } from '@margin/core/fonts';
import { renderPdf, type RenderOptions } from '@margin/core/render-pdf';
import type { FontBytes } from '@margin/core/fonts';

// Export runs off the main thread (spec §8.3). Everything arrives and leaves as structured clones.

export interface ExportRequest extends Omit<RenderOptions, 'fonts'> {
  fonts: FontBytes;
}

export type ExportResponse = { ok: true; bytes: Uint8Array } | { ok: false; message: string };

self.onmessage = async (event: MessageEvent<ExportRequest>) => {
  try {
    const { fonts, ...rest } = event.data;
    const bytes = await renderPdf({ ...rest, fonts: new FontSet(fonts) });
    (self as unknown as Worker).postMessage({ ok: true, bytes } satisfies ExportResponse, [bytes.buffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ ok: false, message: (e as Error).message } satisfies ExportResponse);
  }
};
