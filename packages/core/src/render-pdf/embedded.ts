import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, PDFString, PDFHexString, type PDFObject } from '@cantoo/pdf-lib';
import { MarginError } from '../errors.ts';
import { parseAnnotFile, type LoadOptions } from '../model/load.ts';
import type { AnnotFile } from '../model/types.ts';
import { sha256Hex } from '../hash.ts';

// Re-import of exported PDFs (spec §8.2): the annotation file is attached as `margin.annot.json`,
// optionally together with the original paper as `margin.original.pdf`.

export const ANNOT_ATTACHMENT = 'margin.annot.json';
export const ORIGINAL_ATTACHMENT = 'margin.original.pdf';

/** Embedded files of a PDF by name (name tree walk, /Names and /Kids). */
export async function embeddedFiles(pdfBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false, ignoreEncryption: true });
  } catch (e) {
    throw new MarginError('pdf-invalid', `Cannot read PDF: ${(e as Error).message}`);
  }
  const out = new Map<string, Uint8Array>();
  const ctx = doc.context;
  const dict = (o: PDFObject | undefined): PDFDict | undefined => {
    const v = o && ctx.lookup(o);
    return v instanceof PDFDict ? v : undefined;
  };
  const text = (o: PDFObject | undefined): string | undefined => {
    const v = o && ctx.lookup(o);
    return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
  };
  const walk = (node: PDFDict | undefined, depth: number): void => {
    if (!node || depth > 8) return;
    const names = node.lookup(PDFName.of('Names'));
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const name = text(names.get(i));
        const ef = dict(dict(names.get(i + 1))?.get(PDFName.of('EF')));
        const stream = ef && ctx.lookup(ef.get(PDFName.of('F')) as PDFObject);
        if (name === undefined || !(stream instanceof PDFStream)) continue;
        out.set(name, stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents());
      }
    }
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(dict(kids.get(i)), depth + 1);
  };
  walk(dict(dict(doc.catalog.get(PDFName.of('Names')))?.get(PDFName.of('EmbeddedFiles'))), 0);
  return out;
}

export interface ImportedExport {
  file: AnnotFile;
  /** The original paper, when it was attached (`embedOriginal`). */
  original?: Uint8Array;
}

/**
 * Read the annotation file attached to an exported PDF. Returns undefined for PDFs that were not
 * exported by Margin. When the original is attached, its hash is verified against the file.
 */
export async function importExported(pdfBytes: Uint8Array, options: LoadOptions = {}): Promise<ImportedExport | undefined> {
  const files = await embeddedFiles(pdfBytes);
  const annot = files.get(ANNOT_ATTACHMENT);
  if (!annot) return undefined;
  const file = parseAnnotFile(new TextDecoder().decode(annot), options);
  const original = files.get(ORIGINAL_ATTACHMENT);
  if (original && (await sha256Hex(original)) !== file.document.sha256) {
    throw new MarginError('original-mismatch', 'The attached original does not match the annotation file (sha256 differs).');
  }
  return { file, ...(original ? { original } : {}) };
}
