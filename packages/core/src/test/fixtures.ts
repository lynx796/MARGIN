// Test helpers: load fixture PDFs from the repository (tests run in Node only).
import { readFileSync } from 'node:fs';
import { PdfDoc } from '../pdf/document.ts';
import { FontSet } from '../text/fonts.ts';

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

export const FONTS_DIR = new URL('../../../../fonts/', import.meta.url).pathname;

let fontSet: FontSet | undefined;

export function testFonts(): FontSet {
  const read = (name: string) => new Uint8Array(readFileSync(`${FONTS_DIR}${name}.ttf`));
  fontSet ??= new FontSet({
    sans: read('FiraSans-Regular'),
    'sans-italic': read('FiraSans-Italic'),
    'sans-bold': read('FiraSans-SemiBold'),
    'sans-bolditalic': read('FiraSans-SemiBoldItalic'),
    mono: read('FiraMono-Regular'),
  });
  return fontSet;
}
