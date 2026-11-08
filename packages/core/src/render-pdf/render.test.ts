import { beforeAll, describe, expect, it } from 'vitest';
import { createAnnotFile } from '../model/load.ts';
import type { AnnotFile } from '../model/types.ts';
import { PdfDoc } from '../pdf/document.ts';
import { documentGeometry, layoutDocument, resolveAll } from '../pipeline.ts';
import { fixturePdf, testFonts } from '../test/fixtures.ts';
import { renderPdf, type RenderOptions } from './render.ts';

let options: RenderOptions;
let file: AnnotFile;

beforeAll(async () => {
  const doc = await fixturePdf('plain');
  file = createAnnotFile(doc.info('plain.pdf'));
  const add = (id: string, category: string, quote: string, body: string) =>
    file.annotations.push({ id, category, body, side: 'auto', origin: 'human', anchor: { type: 'text', quote: { exact: quote } }, created: '2026-11-08T10:00:00Z', modified: `2026-11-08T1${id.at(-1)}:00:00Z` });
  add('a00001', 'error', 'differentiable on its', 'Kerning test: AVAToffice \\(x^2\\).');
  add('a00002', 'hl', 'fluffy notion', '');
  add('a00003', 'remark', 'Second page', 'On page two.');
  await resolveAll(doc, file);
  const geometry = await documentGeometry(doc, file);
  const layout = await layoutDocument(file, geometry, testFonts());
  options = { pdfBytes: doc.bytes, file, layout, geometry, fonts: testFonts(), producer: 'Margin test' };
});

describe('renderPdf', () => {
  it('is byte-for-byte deterministic', async () => {
    const a = await renderPdf(options);
    const b = await renderPdf(options);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it('writes enlarged pages with the original text still selectable and comments as text', async () => {
    const out = await PdfDoc.open(await renderPdf(options));
    expect(out.pageCount).toBe(2);
    const g = options.geometry.pages[0]!;
    expect(out.pages[0]!.width).toBeCloseTo(g.outWidth, 1);
    expect(out.pages[0]!.height).toBeCloseTo(g.outHeight, 1);
    const text = (await out.text(1)).text;
    expect(text).toContain('The map f is continuous');
    expect(text).toContain('Kerning test: AVAToffice');
    expect((await out.text(2)).text).toContain('On page two.');
    await out.destroy();
  });

  it('places comment glyphs where the layout put them', async () => {
    const out = await PdfDoc.open(await renderPdf(options));
    const t = await out.text(1);
    const run = options.layout.pages[0]!.prims.find((p) => p.type === 'glyphRun' && p.text.startsWith('Kerning'));
    if (run?.type !== 'glyphRun') throw new Error('run missing');
    const at = t.text.indexOf('Kerning test');
    expect(t.boxes[at]![0]).toBeCloseTo(run.x, 1);
    // Last glyph of the run ends where the layout's advances say.
    const end = run.x + run.advances.reduce((s, v) => s + v, 0);
    const last = t.text.indexOf('AVAToffice') + 'AVAToffice'.length - 1;
    expect(t.boxes[last]![2]).toBeCloseTo(end - run.advances.slice(Array.from('Kerning test: AVAToffice').length).reduce((s, v) => s + v, 0), 1);
    await out.destroy();
  });

  it('sets deterministic metadata from the annotations', async () => {
    const { PDFDocument } = await import('@cantoo/pdf-lib');
    const pdf = await PDFDocument.load(await renderPdf(options), { updateMetadata: false });
    expect(pdf.getProducer()).toBe('Margin test');
    expect(pdf.getModificationDate()?.toISOString()).toBe('2026-11-08T13:00:00.000Z');
    expect(pdf.getAuthor()).toBeUndefined();
  });
});
