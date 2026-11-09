import {
  BlendMode,
  beginText,
  endText,
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFRef,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  type PDFFont,
  type PDFPage,
} from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import { MarginError } from '../errors.ts';
import { visibleRect, type DocGeometry } from '../geometry/geometry.ts';
import type { Color, FontKey, GlyphRunPrim, Layout, LinkRect, Prim } from '../layout/types.ts';
import type { AnnotFile } from '../model/types.ts';
import { sha256Hex } from '../hash.ts';
import { serialize } from '../model/serialize.ts';
import { ANNOT_ATTACHMENT, ORIGINAL_ATTACHMENT } from './embedded.ts';
import { FONT_FEATURES, type FontSet } from '../text/fonts.ts';

// Export (spec §8.1): each original page is embedded as a form XObject, clipped to the crop and
// drawn with transform T on an enlarged page; the display list is drawn on top (highlights below
// the content with multiply blending). Output is deterministic: dates come from the annotations,
// the document ID from a content hash, font subsets have fixed names.

export interface RenderOptions {
  pdfBytes: Uint8Array;
  file: AnnotFile;
  layout: Layout;
  geometry: DocGeometry;
  fonts: FontSet;
  /** Producer string, e.g. "Margin 0.1.0". */
  producer: string;
  /** CreationDate/ModDate; defaults to the latest annotation `modified`. */
  date?: Date;
  /** Compiled grading report placed before or after the annotated pages (§8.4). */
  report?: { bytes: Uint8Array; position: 'before' | 'after' };
}

const FONT_NAMES: Record<FontKey, string> = {
  sans: 'MarginFiraSans-Regular',
  'sans-italic': 'MarginFiraSans-Italic',
  'sans-bold': 'MarginFiraSans-SemiBold',
  'sans-bolditalic': 'MarginFiraSans-SemiBoldItalic',
  mono: 'MarginFiraMono-Regular',
};

/** Fallback date for documents without annotations, so exports stay deterministic. */
const EPOCH = new Date('2026-01-01T00:00:00Z');

function color(c: Color) {
  const n = parseInt(c.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function rectPath(x: number, y: number, w: number, h: number, r = 0): string {
  if (r <= 0) return `M${x} ${y}L${x + w} ${y}L${x + w} ${y + h}L${x} ${y + h}Z`;
  r = Math.min(r, w / 2, h / 2);
  const k = 0.5523 * r;
  return [
    `M${x + r} ${y}`, `L${x + w - r} ${y}`, `C${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r}`,
    `L${x + w} ${y + h - r}`, `C${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h}`,
    `L${x + r} ${y + h}`, `C${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r}`,
    `L${x} ${y + r}`, `C${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y}`, 'Z',
  ].join('');
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

class PageWriter {
  private readonly fontKeys = new Map<FontKey, PDFName>();

  constructor(
    private readonly page: PDFPage,
    private readonly fonts: Record<FontKey, PDFFont>,
    private readonly height: number,
  ) {}

  draw(p: Prim): void {
    const page = this.page;
    const base = { x: 0, y: this.height };
    switch (p.type) {
      case 'rect':
        page.drawSvgPath(rectPath(p.x, p.y, p.w, p.h, p.radius), {
          ...base,
          ...(p.fill ? { color: color(p.fill), opacity: p.fillOpacity ?? 1 } : {}),
          ...(p.stroke ? { borderColor: color(p.stroke), borderWidth: p.strokeWidth ?? 1 } : { borderWidth: 0 }),
          ...(p.dash ? { borderDashArray: p.dash } : {}),
          ...(p.blend === 'multiply' ? { blendMode: BlendMode.Multiply } : {}),
        });
        break;
      case 'path':
        page.drawSvgPath(p.d, { ...base, borderColor: color(p.stroke), borderWidth: p.strokeWidth, ...(p.dash ? { borderDashArray: p.dash } : {}) });
        break;
      case 'svg':
        for (const d of p.paths) page.drawSvgPath(d, { x: p.x, y: this.height - p.y, scale: p.scale, color: color(p.color), borderWidth: 0 });
        break;
      case 'glyphRun':
        this.glyphRun(p);
        break;
    }
  }

  /** Text as a TJ array: glyphs from the embedded subset, adjusted so advances match the layout. */
  private glyphRun(p: GlyphRunPrim): void {
    const font = this.fonts[p.font];
    let key = this.fontKeys.get(p.font);
    if (!key) {
      key = this.page.node.newFontDictionary(font.name, font.ref);
      this.fontKeys.set(p.font, key);
    }
    const ctx = this.page.doc.context;
    const array = PDFArray.withContext(ctx);
    const cps = Array.from(p.text);
    cps.forEach((cp, i) => {
      array.push(font.encodeText(cp));
      if (i < cps.length - 1) {
        const natural = font.widthOfTextAtSize(cp, p.size);
        const adjust = round3(((natural - p.advances[i]!) * 1000) / p.size);
        if (adjust !== 0) array.push(PDFNumber.of(adjust));
      }
    });
    const c = color(p.color);
    this.page.pushOperators(
      pushGraphicsState(),
      setFillingRgbColor(c.red, c.green, c.blue),
      beginText(),
      setFontAndSize(key, p.size),
      setTextMatrix(1, 0, 0, 1, p.x, this.height - p.y),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [array]),
      endText(),
      popGraphicsState(),
    );
  }
}

async function reportPageIndexes(bytes: Uint8Array): Promise<number[]> {
  const n = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  return Array.from({ length: n }, (_, i) => i);
}

export async function renderPdf(o: RenderOptions): Promise<Uint8Array> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(o.pdfBytes, { updateMetadata: false, ignoreEncryption: false });
  } catch (e) {
    throw new MarginError('pdf-invalid', `Cannot read PDF for export: ${(e as Error).message}`);
  }
  const out = await PDFDocument.create({ updateMetadata: false });
  out.registerFontkit(fontkit);
  const fonts = {} as Record<FontKey, PDFFont>;
  for (const key of Object.keys(FONT_NAMES) as FontKey[]) {
    fonts[key] = await out.embedFont(o.fonts.bytes[key], { subset: true, customName: FONT_NAMES[key], features: FONT_FEATURES as never });
  }

  const byPage = new Map(o.layout.pages.map((p) => [p.page, p]));
  const srcPages = src.getPages();
  const latest = o.file.annotations.map((a) => a.modified).sort().pop();
  const date = o.date ?? (latest ? new Date(latest) : EPOCH);

  // Link targets (§6.8): where each comment's box ended up in the output document.
  const targets = new Map<string, { ref: PDFRef; height: number; box: [number, number, number, number] }>();
  const pendingLinks: { page: PDFPage; height: number; links: LinkRect[] }[] = [];
  const reportPages = o.report ? await out.embedPdf(o.report.bytes, await reportPageIndexes(o.report.bytes)) : [];
  const addReport = (width: number, height: number) => {
    for (const rp of reportPages) {
      const scale = width / rp.width;
      const h = Math.max(height, rp.height * scale);
      const page = out.addPage([width, h]);
      page.drawPage(rp, { x: 0, y: (h - rp.height * scale) / 2, xScale: scale, yScale: scale });
    }
  };
  const first = o.geometry.pages[0];
  if (o.report?.position === 'before' && first) addReport(first.outWidth, first.outHeight);

  for (const g of o.geometry.pages) {
    const sp = srcPages[g.page - 1]!;
    if (sp.getRotation().angle % 360 !== 0) {
      throw new MarginError('rotated-page', `Page ${g.page} is rotated; rotated pages are not supported yet.`, { path: `/pages/${g.page}` });
    }
    const crop = sp.getCropBox();
    const [vx0, , vx1] = visibleRect(g);
    const embedded = await out.embedPage(sp, { left: crop.x + vx0, bottom: crop.y, right: crop.x + vx1, top: crop.y + crop.height });
    const page = out.addPage([g.outWidth, g.outHeight]);
    const writer = new PageWriter(page, fonts, g.outHeight);
    const layout = byPage.get(g.page);
    const prims = layout?.prims ?? [];
    for (const p of prims) if (p.layer === 'under') writer.draw(p);
    page.drawPage(embedded, { x: g.ox, y: g.outHeight - g.oy - g.s * g.height, xScale: g.s, yScale: g.s });
    for (const p of prims) if (p.layer === 'over') writer.draw(p);
    if (layout) {
      for (const it of layout.items) if (it.box) targets.set(it.id, { ref: page.ref, height: g.outHeight, box: it.box });
      if (layout.links) pendingLinks.push({ page, height: g.outHeight, links: layout.links });
      // Notes pages for spilled comments follow their page directly (§6.7).
      for (const note of layout.notes ?? []) {
        const np = out.addPage([note.width, note.height]);
        const nw = new PageWriter(np, fonts, note.height);
        for (const p of note.prims) nw.draw(p);
        for (const it of note.items) targets.set(it.id, { ref: np.ref, height: note.height, box: it.box });
        if (note.links) pendingLinks.push({ page: np, height: note.height, links: note.links });
      }
    }
  }
  const last = o.geometry.pages.at(-1);
  if (o.report?.position === 'after' && last) addReport(last.outWidth, last.outHeight);

  // \ref occurrences become internal GoTo links to the target box; a dangling one has no link.
  const ctx = out.context;
  for (const { page, height, links } of pendingLinks) {
    const annots = links.flatMap((l) => {
      const t = targets.get(l.target);
      if (!t) return [];
      const [x, y, w, h] = l.rect;
      return [ctx.register(ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [round3(x), round3(height - y - h), round3(x + w), round3(height - y)],
        Border: [0, 0, 0],
        Dest: [t.ref, 'XYZ', round3(Math.max(0, t.box[0] - 4)), round3(t.height - t.box[1] + 4), null],
      }))];
    });
    if (annots.length) page.node.set(PDFName.of('Annots'), ctx.obj(annots));
  }

  out.setTitle(src.getTitle() || o.file.document.fileName.replace(/\.pdf$/i, ''));
  out.setProducer(o.producer);
  out.setCreator('Margin');
  out.setCreationDate(date);
  out.setModificationDate(date);
  // The annotation file travels with the PDF (§8.2); the original only on request.
  const attachment = { mimeType: 'application/json', creationDate: date, modificationDate: date };
  await out.attach(new TextEncoder().encode(serialize(o.file)), ANNOT_ATTACHMENT, { ...attachment, description: 'Margin annotation file' });
  if (o.file.settings.embedOriginal) {
    await out.attach(o.pdfBytes, ORIGINAL_ATTACHMENT, { mimeType: 'application/pdf', creationDate: date, modificationDate: date, description: 'Original paper' });
  }
  // Deterministic document ID from the inputs (§8.3).
  const reportHash = o.report ? await sha256Hex(o.report.bytes) : '';
  const id = (await sha256Hex(new TextEncoder().encode(o.file.document.sha256 + reportHash + o.report?.position + JSON.stringify(o.layout) + o.file.settings.embedOriginal))).slice(0, 32);
  out.context.trailerInfo.ID = out.context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  return out.save({ useObjectStreams: true });
}
