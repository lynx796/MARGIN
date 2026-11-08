// Test helpers: load fixture PDFs from the repository (tests run in Node only).
import { readFileSync } from 'node:fs';
import { PdfDoc } from '../pdf/document.ts';

export const FIXTURES = new URL('../../../../fixtures/', import.meta.url).pathname;

const cache = new Map<string, Promise<PdfDoc>>();

export function fixturePdf(name: string): Promise<PdfDoc> {
  let doc = cache.get(name);
  if (!doc) {
    doc = PdfDoc.open(new Uint8Array(readFileSync(`${FIXTURES}${name}/${name}.pdf`)));
    cache.set(name, doc);
  }
  return doc;
}
