import { PageIndex, resolveAnnotation, type Resolution } from './anchor/resolve.ts';
import { computeGeometry, inkExtent, INK_DPI, type DocGeometry } from './geometry/geometry.ts';
import { computeLayout, type LayoutResult } from './layout/engine.ts';
import { prepareMath } from './math/mathjax.ts';
import type { AnnotFile } from './model/types.ts';
import type { PdfDoc } from './pdf/document.ts';
import type { FontSet } from './text/fonts.ts';
import { mathSources } from './text/markup.ts';

// Glue between the pure modules, shared by the CLI and (later) the web app.

/** Horizontal ink extent of every page (§5.1). */
export async function measureInk(doc: PdfDoc): Promise<([number, number] | null)[]> {
  const out: ([number, number] | null)[] = [];
  for (let p = 1; p <= doc.pageCount; p++) out.push(inkExtent(await doc.rasterize(p, INK_DPI), INK_DPI));
  return out;
}

export async function documentGeometry(doc: PdfDoc, file: AnnotFile): Promise<DocGeometry> {
  const inks = file.settings.crop ? doc.pages.map(() => null) : await measureInk(doc);
  return computeGeometry(doc.pages, inks, file.settings);
}

/** Page indexes for anchor resolution, for all pages. */
export async function pageIndexes(doc: PdfDoc): Promise<PageIndex[]> {
  return (await doc.allText()).map((t) => new PageIndex(t));
}

/** Resolve every annotation in place (`margin resolve`); returns resolutions by ID. */
export async function resolveAll(doc: PdfDoc, file: AnnotFile): Promise<Map<string, Resolution>> {
  const indexes = await pageIndexes(doc);
  const out = new Map<string, Resolution>();
  for (const a of file.annotations) out.set(a.id, resolveAnnotation(a, indexes, doc.pageCount));
  return out;
}

/** Render all math in the file's comment bodies into the cache. */
export async function prepareFileMath(file: AnnotFile): Promise<void> {
  await prepareMath(file.annotations.flatMap((a) => mathSources(a.body)));
}

export async function layoutDocument(file: AnnotFile, geometry: DocGeometry, fonts: FontSet, pages?: number[]): Promise<LayoutResult> {
  await prepareFileMath(file);
  return computeLayout({ file, geometry, fonts, ...(pages ? { pages } : {}) });
}
