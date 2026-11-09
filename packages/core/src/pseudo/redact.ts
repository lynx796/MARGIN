import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  PDFRef,
  PDFStream,
  PDFString,
  beginMarkedContent,
  beginText,
  endMarkedContent,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFillingGrayscaleColor,
  setFontAndSize,
  setTextMatrix,
  type PDFContext,
  type PDFFont,
  type PDFObject,
} from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import { MarginError } from '../errors.ts';
import type { Rect } from '../model/types.ts';
import { ASCENT, baselineOf, DESCENT, TOKEN_TAG, type PageText } from '../pdf/extract.ts';
import { visibleBox } from '../render-pdf/render.ts';
import { FONT_FEATURES, type FontSet } from '../text/fonts.ts';
import { findTerms, substituteTerms, tokenText, type TermMatch } from './match.ts';
import type { TermGroup } from './terms.ts';

// Redaction (spec §10.3). MuPDF removes the text glyphs under the matched quads (images and line
// art untouched, so nothing else moves). pdf-lib then draws each token on a light gray box, scrubs
// metadata and everything else that can carry names, renames named destinations, regenerates the
// document ID and drops unreferenced objects, so removed data is not merely unlinked.

export const TOKEN_FONT_NAME = 'MarginToken-FiraSans';
const BOX_GRAY = 0.9;
const TEXT_GRAY = 0.25;
/** Inset of the redaction rectangle inside the character boxes, as fractions of the font size:
 *  MuPDF removes every glyph that touches the rectangle, so it must not reach the neighbors. */
const INSET_X = 0.2;
const INSET_Y = 0.15;

export interface RedactInput {
  pdfBytes: Uint8Array;
  /** Text of every page, from `PdfDoc.allText()`. */
  texts: PageText[];
  groups: TermGroup[];
  fonts: FontSet;
  /** Random bytes for the new document ID (injectable for reproducible tests). */
  random?: (n: number) => Uint8Array;
}

export interface RedactResult {
  bytes: Uint8Array;
  matches: TermMatch[];
  /** What was removed besides page text, for the report. */
  scrubbed: string[];
}

function defaultRandom(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function fontSizeOf(q: Rect): number {
  return (q[3] - q[1]) / (ASCENT + DESCENT);
}

/** The rectangle handed to MuPDF: inside the character boxes, clear of the neighbors. */
export function redactionRect(q: Rect): Rect {
  const fs = fontSizeOf(q);
  const dx = Math.min(INSET_X * fs, 0.25 * (q[2] - q[0]));
  const dy = INSET_Y * fs;
  return [q[0] + dx, q[1] + dy, q[2] - dx, q[3] - dy];
}

async function removeText(bytes: Uint8Array, matches: TermMatch[], pageCount: number): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  let doc: InstanceType<typeof mupdf.PDFDocument>;
  try {
    doc = mupdf.Document.openDocument(bytes, 'application/pdf') as InstanceType<typeof mupdf.PDFDocument>;
  } catch (e) {
    throw new MarginError('pdf-invalid', `Cannot read PDF for redaction: ${(e as Error).message}`);
  }
  try {
    if (doc.needsPassword()) throw new MarginError('pdf-encrypted', 'The PDF is password-protected; remove the password first.');
    for (let p = 1; p <= pageCount; p++) {
      const onPage = matches.filter((m) => m.page === p);
      if (onPage.length === 0) continue;
      const page = doc.loadPage(p - 1) as InstanceType<typeof mupdf.PDFPage>;
      const rotate = page.getObject().getInheritable('Rotate');
      if (rotate.isNumber() && rotate.asNumber() % 360 !== 0) {
        throw new MarginError('rotated-page', `Page ${p} is rotated; rotated pages are not supported yet.`, { path: `/pages/${p}` });
      }
      for (const m of onPage) {
        for (const q of m.quads) {
          const annot = page.createAnnotation('Redact');
          annot.setRect(redactionRect(q));
        }
      }
      page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    }
    return doc.saveToBuffer('compress').asUint8Array().slice();
  } finally {
    doc.destroy();
  }
}

// ── Scrubbing ─────────────────────────────────────────────────────────────────────────────────

const CATALOG_REMOVE = ['Metadata', 'AcroForm', 'OpenAction', 'AA', 'StructTreeRoot', 'MarkInfo', 'PieceInfo', 'Threads', 'URI', 'SpiderInfo', 'Perms', 'Legal', 'Collection', 'Dests'];
const PAGE_REMOVE = ['Annots', 'Thumb', 'AA', 'B', 'PieceInfo', 'Metadata', 'StructParents'];
/**
 * Removed from every dictionary in the file: pdfTeX keys (local paths, the Info of included PDFs),
 * XMP, private application data, and associated files (/AF, PDF 2.0), which embed files too.
 */
function strippable(key: string): boolean {
  return key.startsWith('PTEX.') || key === 'Metadata' || key === 'PieceInfo' || key === 'AF';
}

function text(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : undefined;
}

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

/** Named destinations from the /Names /Dests tree and the old-style /Dests dictionary. */
function collectDests(ctx: PDFContext, catalog: PDFDict): Map<string, PDFObject> {
  const out = new Map<string, PDFObject>();
  const walk = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 32) return;
    const names = node.lookup(PDFName.of('Names'));
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const k = text(names.lookup(i));
        if (k !== undefined) out.set(k, names.get(i + 1));
      }
    }
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(dictOf(ctx, kids.get(i)), depth + 1);
  };
  walk(dictOf(ctx, dictOf(ctx, catalog.get(PDFName.of('Names')))?.get(PDFName.of('Dests'))), 0);
  const old = dictOf(ctx, catalog.get(PDFName.of('Dests')));
  for (const [k, v] of old?.entries() ?? []) out.set(k.decodeText(), v);
  return out;
}

function scrub(pdf: PDFDocument, groups: TermGroup[]): string[] {
  const ctx = pdf.context;
  const catalog = pdf.catalog;
  const done: string[] = [];
  const note = (what: string) => {
    if (!done.includes(what)) done.push(what);
  };

  // Named destinations get opaque names: hyperref names them after labels and citation keys.
  const dests = collectDests(ctx, catalog);
  const rename = new Map<string, string>();
  [...dests.keys()].sort().forEach((k, i) => rename.set(k, `d${String(i + 1).padStart(4, '0')}`));
  const mapDest = (o: PDFObject | undefined): PDFObject | undefined => {
    const k = text(o);
    if (k === undefined) return o;
    const n = rename.get(k);
    return n === undefined ? undefined : PDFString.of(n);
  };

  // Outlines: titles token-substituted; only internal GoTo targets survive.
  const outlines = dictOf(ctx, catalog.get(PDFName.of('Outlines')));
  const seen = new Set<PDFDict>();
  const walkOutline = (item: PDFDict | undefined) => {
    while (item && !seen.has(item)) {
      seen.add(item);
      const title = text(item.lookup(PDFName.of('Title')));
      if (title !== undefined) {
        const t = substituteTerms(title, groups);
        if (t !== title) note('outline titles');
        item.set(PDFName.of('Title'), PDFHexString.fromText(t));
      }
      const dest = item.get(PDFName.of('Dest'));
      if (dest !== undefined && !(ctx.lookup(dest) instanceof PDFArray)) {
        const d = mapDest(ctx.lookup(dest));
        if (d) item.set(PDFName.of('Dest'), d);
        else item.delete(PDFName.of('Dest'));
      }
      const action = dictOf(ctx, item.get(PDFName.of('A')));
      if (action) {
        const kind = action.lookup(PDFName.of('S'));
        const target = action.get(PDFName.of('D'));
        if (kind === PDFName.of('GoTo') && target !== undefined) {
          const resolved = ctx.lookup(target);
          const d = resolved instanceof PDFArray ? resolved : mapDest(resolved);
          if (d) item.set(PDFName.of('A'), ctx.obj({ S: 'GoTo', D: d }));
          else item.delete(PDFName.of('A'));
        } else {
          item.delete(PDFName.of('A'));
          note('outline actions');
        }
      }
      item.delete(PDFName.of('SE'));
      walkOutline(dictOf(ctx, item.get(PDFName.of('First'))));
      item = dictOf(ctx, item.get(PDFName.of('Next')));
    }
  };
  walkOutline(dictOf(ctx, outlines?.get(PDFName.of('First'))));

  // Catalog: forms, scripts, embedded files, structure (which can carry alt texts) and XMP go.
  const names = dictOf(ctx, catalog.get(PDFName.of('Names')));
  if (names) {
    for (const [k] of names.entries()) if (k.decodeText() !== 'Dests') note(`/Names/${k.decodeText()}`);
  }
  for (const k of CATALOG_REMOVE) {
    if (catalog.has(PDFName.of(k)) && k !== 'Dests') note(`/${k}`);
    catalog.delete(PDFName.of(k));
  }
  catalog.delete(PDFName.of('Names'));
  if (rename.size) {
    const entries = [...dests.entries()].map(([k, v]) => [rename.get(k)!, v] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const arr = PDFArray.withContext(ctx);
    for (const [k, v] of entries) {
      arr.push(PDFString.of(k));
      arr.push(v);
    }
    catalog.set(PDFName.of('Names'), ctx.obj({ Dests: ctx.register(ctx.obj({ Names: arr })) }));
  }

  for (const page of pdf.getPages()) {
    for (const k of PAGE_REMOVE) {
      if (page.node.has(PDFName.of(k)) && k !== 'StructParents') note(`page /${k}`);
      page.node.delete(PDFName.of(k));
    }
  }

  // pdfTeX keys, XMP and private data anywhere in the file.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : undefined;
    if (!d) continue;
    for (const [k] of d.entries()) {
      if (strippable(k.decodeText())) {
        const name = k.decodeText();
        note(name.startsWith('PTEX.') ? 'pdfTeX keys' : name === 'AF' ? 'associated files' : `/${name}`);
        d.delete(k);
      }
    }
  }
  return done;
}

/** Delete every indirect object not reachable from the trailer, so removed data is not saved. */
function collectGarbage(pdf: PDFDocument): void {
  const ctx = pdf.context;
  const reachable = new Set<string>();
  const stack: PDFObject[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter((o): o is PDFObject => o !== undefined);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (reachable.has(o.tag)) continue;
      reachable.add(o.tag);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!reachable.has(ref.tag)) ctx.delete(ref);
}

// ── Tokens ────────────────────────────────────────────────────────────────────────────────────

function drawTokens(pdf: PDFDocument, font: PDFFont, fonts: FontSet, matches: TermMatch[]): void {
  const pages = pdf.getPages();
  for (const [index, page] of pages.entries()) {
    const onPage = matches.filter((m) => m.page === index + 1);
    if (onPage.length === 0) continue;
    const crop = visibleBox(page);
    const key = page.node.newFontDictionary(font.name, font.ref);
    const ops: PDFOperator[] = [];
    const y = (v: number) => crop.y + crop.height - v;
    for (const m of onPage) {
      // Text that was clipped away (e.g. outside the crop of an included PDF page) was removed but
      // was never visible, so it gets no token either.
      if (!m.visible) continue;
      // The token goes into the widest fragment (a name hyphenated across lines has two).
      const widest = m.quads.reduce((a, b) => (b[2] - b[0] > a[2] - a[0] ? b : a));
      for (const q of m.quads) {
        ops.push(
          pushGraphicsState(),
          setFillingGrayscaleColor(BOX_GRAY),
          PDFOperator.of(PDFOperatorNames.AppendRectangle, [q[0] + crop.x, y(q[3]), q[2] - q[0], q[3] - q[1]].map((v) => PDFNumber.of(Math.round(v * 1000) / 1000))),
          PDFOperator.of(PDFOperatorNames.FillNonZero),
          popGraphicsState(),
        );
      }
      const label = tokenText(m.token);
      const size = Math.round(fontSizeOf(widest) * 100) / 100;
      const natural = fonts.width('sans', label, size);
      const scale = Math.min(1, (widest[2] - widest[0]) / natural);
      ops.push(
        beginMarkedContent(TOKEN_TAG),
        pushGraphicsState(),
        setFillingGrayscaleColor(TEXT_GRAY),
        beginText(),
        setFontAndSize(key, size),
        setTextMatrix(Math.round(scale * 10000) / 10000, 0, 0, 1, Math.round((widest[0] + crop.x) * 1000) / 1000, Math.round(y(baselineOf(widest)) * 1000) / 1000),
        PDFOperator.of(PDFOperatorNames.ShowText, [font.encodeText(label)]),
        endText(),
        popGraphicsState(),
        endMarkedContent(),
      );
    }
    // Isolate the original content's graphics state from what is appended.
    const start = pdf.context.register(pdf.context.contentStream([pushGraphicsState()]));
    const end = pdf.context.register(pdf.context.contentStream([popGraphicsState(), ...ops]));
    page.node.wrapContentStreams(start, end);
  }
}

/**
 * Produce the pseudonymized PDF: page text of every term removed and replaced by its token,
 * metadata scrubbed. Run `verifyRedaction` on the result before handing it out.
 */
export async function redactPdf(input: RedactInput): Promise<RedactResult> {
  const matches = findTerms(input.texts, input.groups);
  const removed = await removeText(input.pdfBytes, matches, input.texts.length);
  const pdf = await PDFDocument.load(removed, { updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const originalTitle = pdf.getTitle();
  const scrubbed = scrub(pdf, input.groups);

  const font = await pdf.embedFont(input.fonts.bytes.sans, { subset: true, customName: TOKEN_FONT_NAME, features: FONT_FEATURES as never });
  drawTokens(pdf, font, input.fonts, matches);
  // Drawing normalizes pages, which can add an empty /Annots again.
  for (const page of pdf.getPages()) page.node.delete(PDFName.of('Annots'));

  // Info: only the token-substituted title.
  const info = pdf.context.obj({}) as PDFDict;
  if (originalTitle) info.set(PDFName.of('Title'), PDFHexString.fromText(substituteTerms(originalTitle, input.groups)));
  pdf.context.trailerInfo.Info = pdf.context.register(info);
  scrubbed.unshift('document info', 'XMP metadata');
  const id = Array.from((input.random ?? defaultRandom)(16), (b) => b.toString(16).padStart(2, '0')).join('');
  pdf.context.trailerInfo.ID = pdf.context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  delete (pdf.context.trailerInfo as { Encrypt?: unknown }).Encrypt;

  // pdf-lib writes the font at save time; collect garbage only after that is in the context.
  await pdf.flush();
  collectGarbage(pdf);
  const bytes = await pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
  return { bytes, matches, scrubbed: [...new Set(scrubbed)] };
}
