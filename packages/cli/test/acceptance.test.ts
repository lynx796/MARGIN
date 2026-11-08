import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  computeLayout,
  documentGeometry,
  normalizeQuote,
  pageIndexes,
  parseAnnotFile,
  PdfDoc,
  prepareFileMath,
  type AnnotFile,
  type DocGeometry,
  type PageLayout,
  type PathPrim,
  type RectPrim,
} from '@margin/core';
import { loadFonts } from '../src/workspace.ts';
import { run } from '../src/main.ts';

// Phase 1 acceptance (spec §12.3): a 20-page fixture with 60 comments lays out without overlap,
// all leaders non-crossing, in under 16 ms per page.

const DIR = new URL('../../../fixtures/long/', import.meta.url).pathname;
let file: AnnotFile;
let geometry: DocGeometry;

beforeAll(async () => {
  const doc = await PdfDoc.open(new Uint8Array(readFileSync(join(DIR, 'long.pdf'))));
  file = parseAnnotFile(readFileSync(join(DIR, 'long.annot.json'), 'utf8'));
  geometry = await documentGeometry(doc, file);
  await prepareFileMath(file);
});

function boxes(p: PageLayout): RectPrim[] {
  return p.prims.filter((q): q is RectPrim => q.type === 'rect' && q.fillOpacity === 0.08);
}

function gutterLeaders(p: PageLayout) {
  return p.prims
    .filter((q): q is PathPrim => q.type === 'path' && q.strokeWidth === 0.6 && !q.dash)
    .map((q) => q.d.match(/-?[\d.]+/g)!.map(Number) as [number, number, number, number]);
}

describe('acceptance: long fixture', () => {
  it('has 20 pages and 60 comments', () => {
    expect(file.document.pageCount).toBe(20);
    expect(file.annotations).toHaveLength(60);
  });

  it('lays out without overlap, inside the columns, with non-crossing leaders', () => {
    const { pages, diagnostics } = computeLayout({ file, geometry, fonts: loadFonts() });
    expect(diagnostics.overflow).toEqual([]);
    expect(diagnostics.unplaced).toEqual([]);
    let count = 0;
    for (const page of pages) {
      const g = geometry.pages[page.page - 1]!;
      const rects = boxes(page);
      count += rects.length;
      for (const side of ['left', 'right'] as const) {
        const col = g[side];
        const inCol = rects.filter((r) => Math.abs(r.x - col.x0) < 1e-3).sort((a, b) => a.y - b.y);
        inCol.forEach((r, i) => {
          expect(r.y).toBeGreaterThanOrEqual(g.top - 1e-3);
          expect(r.y + r.h).toBeLessThanOrEqual(g.bottom + 1e-3);
          if (i > 0) expect(r.y).toBeGreaterThanOrEqual(inCol[i - 1]!.y + inCol[i - 1]!.h - 1e-3);
        });
      }
      // Two gutter leaders on the same side cross iff their endpoint orders differ.
      const leaders = gutterLeaders(page);
      for (const a of leaders) for (const b of leaders) {
        if (a === b || Math.sign(a[2] - a[0]) !== Math.sign(b[2] - b[0])) continue;
        expect((a[1] - b[1]) * (a[3] - b[3])).toBeGreaterThanOrEqual(-1e-6);
      }
    }
    expect(count).toBe(60);
  });

  it('lays out each page in under 16 ms', () => {
    const fonts = loadFonts();
    computeLayout({ file, geometry, fonts }); // warm caches (glyph shaping, math)
    const times: number[] = [];
    for (const g of geometry.pages) {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        computeLayout({ file, geometry, fonts, pages: [g.page] });
        runs.push(performance.now() - t0);
      }
      times.push(runs.sort((a, b) => a - b)[2]!);
    }
    expect(Math.max(...times)).toBeLessThan(16);
  });

  it('margin apply with 100 operations completes in under 2 s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'margin-apply-'));
    copyFileSync(join(DIR, 'long.pdf'), join(dir, 'long.pdf'));
    const doc = await PdfDoc.open(new Uint8Array(readFileSync(join(dir, 'long.pdf'))));
    const indexes = await pageIndexes(doc);
    // 100 distinct, unique quotes: consecutive word pairs found exactly once in the document.
    const ops: unknown[] = [];
    for (const idx of indexes) {
      const words = idx.page.text.split(/\s+/).filter((w) => /^[a-z]{5,}$/.test(w));
      for (let i = 0; i + 1 < words.length && ops.length < 100; i += 5) {
        const quote = `${words[i]} ${words[i + 1]}`;
        if (indexes.flatMap((x) => x.find(normalizeQuote(quote))).length === 1) ops.push({ op: 'add', category: 'remark', quote, body: 'x' });
      }
    }
    expect(ops).toHaveLength(100);
    writeFileSync(join(dir, 'ops.json'), JSON.stringify(ops));
    const cwd = process.cwd();
    process.chdir(dir);
    const o = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await run(['init', 'long.pdf'])).toBe(0);
      const t0 = performance.now();
      expect(await run(['apply', 'ops.json'])).toBe(0);
      expect(performance.now() - t0).toBeLessThan(2000);
    } finally {
      o.mockRestore();
      process.chdir(cwd);
    }
  });
});
