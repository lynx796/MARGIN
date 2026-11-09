import type { PseudoRequest, PseudoResponse } from './pseudo.worker.ts';

/** Run redaction in a short-lived Web Worker. */
export function redactInWorker(req: PseudoRequest): Promise<Extract<PseudoResponse, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pseudo.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<PseudoResponse>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data);
      else reject(Object.assign(new Error(event.data.message), { code: event.data.code }));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'redaction worker failed'));
    };
    worker.postMessage({ ...req, pdfBytes: req.pdfBytes.slice() });
  });
}
