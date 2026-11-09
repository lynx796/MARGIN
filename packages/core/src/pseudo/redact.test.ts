import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { PdfDoc } from '../pdf/document.ts';
import { testFonts } from '../test/fixtures.ts';
import { seededRandomBytes } from '../model/ids.ts';
import { redactPdf, redactionRect } from './redact.ts';
import { parseTerms } from './terms.ts';
import { verifyRedaction } from './verify.ts';

async function samplePdf(crop?: [number, number, number, number]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  if (crop) page.setCropBox(...crop);
  page.drawText('Graded for Jonas Keller by the tutor.', { x: 120, y: 600, size: 12, font });
  page.drawText('Nothing personal on this line.', { x: 120, y: 580, size: 12, font });
  pdf.setAuthor('Jonas Keller');
  pdf.setTitle('Report of Jonas Keller');
  return pdf.save();
}

async function run(bytes: Uint8Array) {
  const groups = parseTerms('STUDENT: Jonas Keller | Keller');
  const doc = await PdfDoc.open(bytes);
  const texts = await doc.allText();
  await doc.destroy();
  const r = await redactPdf({ pdfBytes: bytes, texts, groups, fonts: testFonts(), random: seededRandomBytes(1) });
  const out = await PdfDoc.open(r.bytes);
  const text = (await out.text(1)).text;
  await out.destroy();
  return { r, text, problems: await verifyRedaction(r.bytes, groups) };
}

describe('redactPdf', () => {
  it('removes the name, keeps its neighbors and puts the token in its place', async () => {
    const { r, text, problems } = await run(await samplePdf());
    expect(problems).toEqual([]);
    expect(text).toContain('Graded for [STUDENT] by the tutor.');
    expect(text).toContain('Nothing personal on this line.');
    const pdf = await PDFDocument.load(r.bytes, { updateMetadata: false });
    expect(pdf.getTitle()).toBe('Report of [STUDENT]');
    expect(pdf.getAuthor()).toBeUndefined();
  });

  it('uses the same coordinates as MuPDF when the crop box is offset, or larger than the media box', async () => {
    for (const crop of [[40, 300, 520, 400], [40, 300, 560, 760]] as [number, number, number, number][]) {
      const { text, problems } = await run(await samplePdf(crop));
      expect(problems).toEqual([]);
      expect(text, String(crop)).toContain('Graded for [STUDENT] by the tutor.');
    }
  });

  it('insets the rectangle so neighboring glyphs are not touched', () => {
    const r = redactionRect([100, 100, 160, 110]);
    expect(r[0]).toBeGreaterThan(100);
    expect(r[2]).toBeLessThan(160);
    expect(r[1]).toBeGreaterThan(100);
    expect(r[3]).toBeLessThan(110);
  });
});
