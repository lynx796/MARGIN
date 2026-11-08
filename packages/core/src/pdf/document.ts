import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MarginError } from '../errors.ts';
import { sha256Hex } from '../hash.ts';
import type { DocumentInfo, PageSize } from '../model/types.ts';
import { buildPageText, glyphsFromOperatorList, type PageText } from './extract.ts';

/** RGBA bitmap, row-major, 4 bytes per pixel. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

type Matrix = [number, number, number, number, number, number];

/** A loaded PDF with the operations the rest of core needs. Pages are 1-based. */
export class PdfDoc {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly pages: PageSize[];
  private readonly proxy: PDFDocumentProxy;
  private readonly task: PDFDocumentLoadingTask;
  private readonly textCache = new Map<number, Promise<PageText>>();

  private constructor(bytes: Uint8Array, sha256: string, task: PDFDocumentLoadingTask, proxy: PDFDocumentProxy, pages: PageSize[]) {
    this.task = task;
    this.bytes = bytes;
    this.sha256 = sha256;
    this.proxy = proxy;
    this.pages = pages;
  }

  static async open(bytes: Uint8Array): Promise<PdfDoc> {
    const sha256 = await sha256Hex(bytes);
    let proxy: PDFDocumentProxy;
    let task: PDFDocumentLoadingTask;
    try {
      // pdf.js may transfer (detach) the buffer it is given, so hand it a copy.
      task = getDocument({
        data: bytes.slice(),
        fontExtraProperties: true,
        disableFontFace: true,
        useSystemFonts: false,
        verbosity: 0,
      });
      proxy = await task.promise;
    } catch (e) {
      throw new MarginError('pdf-invalid', `Cannot open PDF: ${(e as Error).message}`);
    }
    const pages: PageSize[] = [];
    for (let i = 1; i <= proxy.numPages; i++) {
      const vp = (await proxy.getPage(i)).getViewport({ scale: 1 });
      pages.push({ width: round2(vp.width), height: round2(vp.height) });
    }
    return new PdfDoc(bytes, sha256, task, proxy, pages);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  info(fileName: string): DocumentInfo {
    return { fileName, sha256: this.sha256, pageCount: this.pageCount, pages: this.pages.map((p) => ({ ...p })) };
  }

  page(n: number): Promise<PDFPageProxy> {
    if (!Number.isInteger(n) || n < 1 || n > this.pageCount) {
      throw new MarginError('page-out-of-range', `Page ${n} does not exist (document has ${this.pageCount} pages).`);
    }
    return this.proxy.getPage(n);
  }

  /** Page text with character boxes in original-page coordinates (cached). */
  text(n: number): Promise<PageText> {
    let cached = this.textCache.get(n);
    if (!cached) {
      cached = (async () => {
        const page = await this.page(n);
        const ops = await page.getOperatorList();
        const viewport = page.getViewport({ scale: 1 }).transform as Matrix;
        const chars = glyphsFromOperatorList(ops, viewport, (name) => (page.commonObjs.has(name) ? page.commonObjs.get(name) : undefined));
        return buildPageText(n, chars);
      })();
      this.textCache.set(n, cached);
    }
    return cached;
  }

  async allText(): Promise<PageText[]> {
    const out: PageText[] = [];
    for (let i = 1; i <= this.pageCount; i++) out.push(await this.text(i));
    return out;
  }

  /** Render a page on white at the given resolution. */
  async rasterize(n: number, dpi: number): Promise<Bitmap> {
    const page = await this.page(n);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const factory = (this.proxy as unknown as { canvasFactory: CanvasFactory }).canvasFactory;
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const { canvas, context } = factory.create(width, height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    await page.render({ canvas: canvas as never, canvasContext: context as never, viewport, background: '#ffffff' }).promise;
    const image = context.getImageData(0, 0, width, height);
    factory.destroy({ canvas, context });
    return { width, height, data: image.data };
  }

  async destroy(): Promise<void> {
    await this.task.destroy();
  }
}

interface Canvas2D {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

interface CanvasFactory {
  create(width: number, height: number): { canvas: unknown; context: Canvas2D };
  destroy(c: { canvas: unknown; context: Canvas2D }): void;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
