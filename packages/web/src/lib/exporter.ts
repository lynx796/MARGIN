import type { ExportRequest, ExportResponse } from './export.worker.ts';

/** Render the flattened PDF in a short-lived Web Worker. */
export function exportInWorker(req: ExportRequest): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ExportResponse>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.bytes);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'export worker failed'));
    };
    // Copies: the main thread keeps using the PDF and font bytes.
    worker.postMessage({ ...req, pdfBytes: req.pdfBytes.slice() });
  });
}
