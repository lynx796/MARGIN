import { beforeAll, describe, expect, it } from 'vitest';
import { createAnnotFile } from '../model/load.ts';
import type { AnnotFile } from '../model/types.ts';
import { PdfDoc } from '../pdf/document.ts';
import { documentGeometry, layoutDocument, resolveAll } from '../pipeline.ts';
import { fixturePdf, testFonts } from '../test/fixtures.ts';
import { renderPdf, type RenderOptions } from './render.ts';
import { embeddedFiles, importExported } from './embedded.ts';
import { serialize } from '../model/serialize.ts';
import { PDFArray, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';

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

  it('attaches the annotation file and re-imports it loss-free (§8.2)', async () => {
    const bytes = await renderPdf(options);
    const files = await embeddedFiles(bytes);
    expect([...files.keys()]).toEqual(['margin.annot.json']);
    const imported = await importExported(bytes);
    expect(serialize(imported!.file)).toBe(serialize(file));
    expect(imported!.original).toBeUndefined();
  });

  it('attaches the original only with embedOriginal, and verifies it', async () => {
    const withOriginal = { ...options, file: { ...file, settings: { ...file.settings, embedOriginal: true } } };
    const bytes = await renderPdf(withOriginal);
    const imported = await importExported(bytes);
    expect(Buffer.compare(Buffer.from(imported!.original!), Buffer.from(options.pdfBytes))).toBe(0);
    expect(bytes.length).toBeGreaterThan((await renderPdf(options)).length + options.pdfBytes.length / 2);
  });

  it('returns undefined for a PDF Margin did not export', async () => {
    expect(await importExported(options.pdfBytes)).toBeUndefined();
  });

  it('exports exactly the annotated pages without a report', async () => {
    const pdf = await PDFDocument.load(await renderPdf(options));
    expect(pdf.getPageCount()).toBe(options.geometry.pages.length);
  });

  it('places a report before or after, scaled to the page width, without annotating it (§8.4)', async () => {
    const report = (await fixturePdf('plain')).bytes;
    const n = options.geometry.pages.length;
    const g0 = options.geometry.pages[0]!;
    const rep = await PDFDocument.load(report);
    const before = await PDFDocument.load(await renderPdf({ ...options, report: { bytes: report, position: 'before' } }));
    expect(before.getPageCount()).toBe(n + rep.getPageCount());
    expect(before.getPage(0).getWidth()).toBeCloseTo(g0.outWidth, 3);
    const after = await PDFDocument.load(await renderPdf({ ...options, report: { bytes: report, position: 'after' } }));
    expect(after.getPageCount()).toBe(n + rep.getPageCount());
    expect(after.getPage(n).getWidth()).toBeCloseTo(options.geometry.pages.at(-1)!.outWidth, 3);
    // The annotated pages are still where they were, after the report.
    const text = await PdfDoc.open(await renderPdf({ ...options, report: { bytes: report, position: 'before' } }));
    expect((await text.text(rep.getPageCount() + 1)).text).toContain('Kerning test');
    await text.destroy();
  });

  it('turns resolved \\ref into GoTo links and leaves dangling ones as text', async () => {
    const f: AnnotFile = { ...file, annotations: file.annotations.map((a) => ({ ...a })) };
    f.annotations[0]!.body = `See \\ref{${f.annotations[2]!.id} } and \\ref{${f.annotations[2]!.id}}.`.replace(' }', '}');
    const layout = await layoutDocument(f, options.geometry, testFonts());
    const bytes = await renderPdf({ ...options, file: f, layout });
    const pdf = await PDFDocument.load(bytes);
    const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(2);
    const link = pdf.context.lookup(annots.get(0), PDFDict);
    expect(link.get(PDFName.of('Subtype'))).toEqual(PDFName.of('Link'));
    const dest = link.lookup(PDFName.of('Dest'), PDFArray);
    // Target comment is on page 2.
    expect(dest.get(0)).toBe(pdf.getPage(1).ref);
  });

  it('inserts a notes page after a page that spilled comments', async () => {
    const f: AnnotFile = { ...file, annotations: [] };
    const doc = await fixturePdf('plain');
    const quotes = ['differentiable on its', 'fluffy notion', 'The map f is continuous', 'right margin'];
    const long = Array.from({ length: 260 }, (_, i) => `word${i}`).join(' ');
    quotes.forEach((q, i) => f.annotations.push({ id: `n0000${i + 1}`, category: 'remark', body: long, side: 'auto', origin: 'human', anchor: { type: 'text', page: 1, quote: { exact: q } }, created: '2026-11-08T10:00:00Z', modified: '2026-11-08T10:00:00Z' }));
    await resolveAll(doc, f);
    const geometry = await documentGeometry(doc, f);
    const layout = await layoutDocument(f, geometry, testFonts());
    const page1 = layout.pages[0]!;
    if (!page1.notes) throw new Error('fixture did not overflow');
    const pdf = await PDFDocument.load(await renderPdf({ ...options, file: f, layout, geometry }));
    expect(pdf.getPageCount()).toBe(geometry.pages.length + page1.notes.length);
    const out = await PdfDoc.open(await renderPdf({ ...options, file: f, layout, geometry }));
    expect((await out.text(2)).text).toContain('word0');
    expect(out.pages[1]!.width).toBeCloseTo(geometry.pages[0]!.outWidth, 1);
    await out.destroy();
  });

  it('places pages whose crop box exceeds the media box where the screen does', async () => {
    const { StandardFonts } = await import('@cantoo/pdf-lib');
    const { toOutputRect } = await import('../geometry/geometry.ts');
    const src = await PDFDocument.create({ updateMetadata: false });
    const page = src.addPage([600, 800]);
    page.setCropBox(40, 300, 560, 760);
    page.drawText('Oversized crop box', { x: 120, y: 600, size: 12, font: await src.embedFont(StandardFonts.Helvetica) });
    const doc = await PdfDoc.open(await src.save());
    const f = createAnnotFile(doc.info('crop.pdf'));
    const geometry = await documentGeometry(doc, f);
    const layout = await layoutDocument(f, geometry, testFonts());
    const before = (await doc.text(1)).boxes[0]!;
    const out = await PdfDoc.open(await renderPdf({ ...options, pdfBytes: doc.bytes, file: f, layout, geometry }));
    const after = (await out.text(1)).boxes[0]!;
    const expected = toOutputRect(geometry.pages[0]!, before);
    expect(after[0]).toBeCloseTo(expected[0], 1);
    expect(after[1]).toBeCloseTo(expected[1], 1);
    await out.destroy();
    await doc.destroy();
  });
});
