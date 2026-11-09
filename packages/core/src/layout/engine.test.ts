import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createAnnotFile } from '../model/load.ts';
import { seededRandomBytes, newId } from '../model/ids.ts';
import type { Annotation, AnnotFile } from '../model/types.ts';
import { computeGeometry, type DocGeometry } from '../geometry/geometry.ts';
import { pageIndexes, measureInk, layoutDocument } from '../pipeline.ts';
import { resolveAnnotation, type PageIndex } from '../anchor/resolve.ts';
import { fixturePdf, testFonts } from '../test/fixtures.ts';
import type { PdfDoc } from '../pdf/document.ts';
import type { PathPrim, PageLayout, RectPrim } from './types.ts';
import { computeNumbers } from './engine.ts';

let doc: PdfDoc;
let indexes: PageIndex[];
let geometry: DocGeometry;
const fonts = testFonts();

beforeAll(async () => {
  doc = await fixturePdf('plain');
  indexes = await pageIndexes(doc);
  geometry = computeGeometry(doc.pages, await measureInk(doc), { marginWidth: 150, maxEnlargement: 1.3 });
});

function fileWith(specs: { quote: string; category?: string; body?: string; side?: 'auto' | 'left' | 'right'; page?: number }[]): AnnotFile {
  const file = createAnnotFile(doc.info('plain.pdf'));
  const random = seededRandomBytes(7);
  const taken = new Set<string>();
  for (const s of specs) {
    const id = newId(taken, random);
    taken.add(id);
    const a: Annotation = {
      id, category: s.category ?? 'remark', body: s.body ?? 'A comment.', side: s.side ?? 'auto', origin: 'agent',
      anchor: { type: 'text', ...(s.page ? { page: s.page } : {}), quote: { exact: s.quote } }, created: '2026-11-08T00:00:00Z', modified: '2026-11-08T00:00:00Z',
    };
    const r = resolveAnnotation(a, indexes, doc.pageCount);
    if (r.status !== 'ok') throw new Error(`fixture quote ${s.quote}: ${r.status}`);
    file.annotations.push(a);
  }
  return file;
}

const boxRects = (p: PageLayout) => {
  // The background rect of each box is the first rect with fillOpacity 0.08 for that id.
  const out = new Map<string, RectPrim>();
  for (const prim of p.prims) if (prim.type === 'rect' && prim.fillOpacity === 0.08 && !out.has(prim.id)) out.set(prim.id, prim);
  return [...out.values()];
};

function gutterSegments(p: PageLayout): { id: string; x0: number; y0: number; x1: number; y1: number }[] {
  return p.prims
    .filter((q): q is PathPrim => q.type === 'path' && q.strokeWidth === 0.6 && !q.dash)
    .map((q) => {
      const [x0, y0, x1, y1] = q.d.match(/-?[\d.]+/g)!.map(Number) as [number, number, number, number];
      return { id: q.id, x0, y0, x1, y1 };
    })
    .filter((s) => Math.abs(s.x1 - s.x0) > 4.5);
}

describe('layout engine', () => {
  const words = ['We study', 'trivial', 'differentiable', 'efficient computation', 'fixed points', 'affine case', 'general one', 'earlier work', 'fluffy notion', 'nice', 'definition', 'remedy', 'subtlety', 'overlook', 'first reading', 'argument', 'has a fixed', 'intermediate value theorem', 'typesetter', 'right margin'];

  it('places boxes without overlap inside the margin columns, leaders not crossing', async () => {
    const file = fileWith(words.map((quote, i) => ({ quote, page: 1, body: i % 3 === 0 ? `Longer remark number ${i} with a formula \\(x_${i}^2 + \\frac{1}{n}\\) that wraps across more than one line of the box.` : `Short ${i}.` })));
    const { pages, diagnostics } = await layoutDocument(file, geometry, fonts, [1]);
    const page = pages[0]!;
    const g = geometry.pages[0]!;
    expect(diagnostics.overflow).toEqual([]);
    const rects = boxRects(page);
    expect(rects).toHaveLength(words.length);
    for (const side of ['left', 'right'] as const) {
      const col = g[side];
      const inCol = rects.filter((r) => Math.abs(r.x - col.x0) < 1e-6).sort((a, b) => a.y - b.y);
      for (const r of inCol) {
        expect(r.y).toBeGreaterThanOrEqual(g.top - 1e-6);
        expect(r.y + r.h).toBeLessThanOrEqual(g.bottom + 1e-6);
        expect(r.x + r.w).toBeLessThanOrEqual(col.x1 + 1e-6);
      }
      for (let i = 1; i < inCol.length; i++) expect(inCol[i]!.y).toBeGreaterThanOrEqual(inCol[i - 1]!.y + inCol[i - 1]!.h + 4 - 1e-3);
    }
    expect(rects.filter((r) => r.x < g.ox).length).toBeGreaterThan(0);
    expect(rects.filter((r) => r.x > g.ox).length).toBeGreaterThan(0);
    // Gutter leaders within a column never cross.
    const segs = gutterSegments(page);
    for (const s of segs) for (const t of segs) {
      if (s.id >= t.id || Math.sign(s.x1 - s.x0) !== Math.sign(t.x1 - t.x0)) continue;
      expect((s.y0 - t.y0) * (s.y1 - t.y1)).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('numbers comments 1…N in reading order, skipping highlights', () => {
    const file = fileWith([{ quote: 'Second page', page: 2 }, { quote: 'intermediate value theorem' }, { quote: 'We study the', page: 1, category: 'hl' }, { quote: 'efficient computation' }]);
    const numbers = computeNumbers(file);
    const byQuote = (q: string) => numbers[file.annotations.find((a) => a.anchor.type === 'text' && a.anchor.quote?.exact === q)!.id];
    expect(byQuote('efficient computation')).toBe(1);
    expect(byQuote('intermediate value theorem')).toBe(2);
    expect(byQuote('Second page')).toBe(3);
    expect(byQuote('We study the')).toBeUndefined();
  });

  it('draws highlights beneath the content and underlines with leaders for comments', async () => {
    const file = fileWith([{ quote: 'We study the', page: 1, category: 'hl', body: '' }, { quote: 'fixed points' }]);
    const page = (await layoutDocument(file, geometry, fonts, [1])).pages[0]!;
    const hl = page.prims.filter((p) => p.layer === 'under');
    expect(hl).toHaveLength(1);
    expect(hl[0]).toMatchObject({ type: 'rect', blend: 'multiply', fillOpacity: 0.3 });
    expect(page.prims.filter((p) => p.type === 'path' && p.strokeWidth === 1)).toHaveLength(1);
    expect(page.prims.some((p) => p.type === 'path' && p.dash)).toBe(true);
  });

  it('gives overlapping anchors on the same line distinct underline levels', async () => {
    const file = fileWith([{ quote: 'efficient computation of fixed', page: 1 }, { quote: 'computation of fixed points', page: 1 }]);
    const page = (await layoutDocument(file, geometry, fonts, [1])).pages[0]!;
    const ys = page.prims.filter((p): p is PathPrim => p.type === 'path' && p.strokeWidth === 1).map((p) => Number(p.d.split(/[ L]/)[1]));
    expect(ys).toHaveLength(2);
    expect(Math.abs(ys[0]! - ys[1]!)).toBeCloseTo(1.5, 6);
  });

  it('honors pinned sides and region anchors', async () => {
    const file = fileWith([{ quote: 'right margin', side: 'left' }]);
    file.annotations.push({ id: 'rg0001', category: 'error', body: 'Check this formula.', side: 'right', origin: 'human', anchor: { type: 'region', page: 1, rect: [250, 500, 400, 540] }, created: '2026-11-08T00:00:00Z', modified: '2026-11-08T00:00:00Z' });
    const page = (await layoutDocument(file, geometry, fonts, [1])).pages[0]!;
    const g = geometry.pages[0]!;
    const rects = boxRects(page);
    expect(rects.find((r) => r.id === file.annotations[0]!.id)!.x).toBeCloseTo(g.left.x0, 6);
    expect(rects.find((r) => r.id === 'rg0001')!.x).toBeCloseTo(g.right.x0, 6);
    expect(page.prims.some((p) => p.type === 'rect' && p.id === 'rg0001' && p.stroke === '#dc2626')).toBe(true);
  });

  it('reports dangling refs and unplaced anchors', async () => {
    const file = fileWith([{ quote: words[0]!, page: 1 }]);
    file.annotations[0]!.body = 'See \\ref{zzzzzz}.';
    file.annotations.push({ id: 'un0001', category: 'remark', body: 'x', side: 'auto', origin: 'agent', anchor: { type: 'text', quote: { exact: 'nowhere' } }, status: 'unresolved', created: '2026-11-08T00:00:00Z', modified: '2026-11-08T00:00:00Z' });
    const { diagnostics } = await layoutDocument(file, geometry, fonts, [1]);
    expect(diagnostics.danglingRefs).toEqual([{ id: file.annotations[0]!.id, target: 'zzzzzz' }]);
    expect(diagnostics.unplaced).toEqual(['un0001']);
  });

  it('steps the font size down in 0.5 pt steps before spilling (§6.7)', async () => {
    const some = Array.from({ length: 22 }, (_, i) => `word${i}`).join(' ');
    // Fits at the configured size: untouched.
    const small = await layoutDocument(fileWith(words.slice(0, 3).map((quote) => ({ quote, page: 1, body: some }))), geometry, fonts, [1]);
    expect(small.pages[0]!.fontSize).toBe(9);
    expect(small.pages[0]!.overflow).toEqual([]);
    // Needs a smaller size but no spill.
    let stepped: PageLayout | undefined;
    for (let n = 4; n < 12 && !stepped; n++) {
      const page = (await layoutDocument(fileWith(words.slice(0, n).map((quote) => ({ quote, page: 1, body: some.repeat(2) }))), geometry, fonts, [1])).pages[0]!;
      if (page.fontSize < 9 && page.overflow.length === 0) stepped = page;
    }
    expect(stepped).toBeDefined();
    expect((9 - stepped!.fontSize) % 0.5).toBe(0);
    expect(stepped!.fontSize).toBeGreaterThanOrEqual(7.5);
  });

  it('spills the lightest comments to notes pages, leaving numbered tags (§6.7)', async () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const file = fileWith(words.slice(0, 12).map((quote, i) => ({ quote, page: 1, body: long, category: i === 0 ? 'error' : 'remark' })));
    const weight = (c: string) => file.categories.find((x) => x.id === c)!.weight;
    const result = await layoutDocument(file, geometry, fonts, [1]);
    const page = result.pages[0]!;
    expect(page.fontSize).toBe(7.5);
    expect(page.overflow.length).toBeGreaterThan(0);
    expect(result.diagnostics.overflow).toEqual([{ page: 1, ids: page.overflow }]);
    // The heaviest comment (if lighter ones exist) stays in the margin.
    if (weight('error') > weight('remark')) expect(page.overflow).not.toContain(file.annotations[0]!.id);
    // Every spilled comment has a tag in the margin and a full box on a notes page.
    expect(page.notes?.length).toBeGreaterThan(0);
    const noted = page.notes!.flatMap((n) => n.items.map((i) => i.id)).sort();
    expect(noted).toEqual(page.overflow);
    for (const id of page.overflow) {
      const item = page.items.find((i) => i.id === id)!;
      expect(item.spilled).toBe(true);
      expect(item.box![2]).toBeLessThan(30);
    }
    for (const n of page.notes!) {
      expect(n.width).toBe(page.width);
      expect(n.height).toBe(page.height);
      for (const it of n.items) expect(it.box[1] + it.box[3]).toBeLessThanOrEqual(page.height);
    }
    // Margin boxes that remain fit their column.
    const g = geometry.pages[0]!;
    for (const it of page.items) if (it.box && !it.spilled) expect(it.box[1] + it.box[3]).toBeLessThanOrEqual(g.bottom + 1e-6);
  });

  it('records cross-reference links to the target comment', async () => {
    const file = fileWith([{ quote: words[0]!, page: 1 }, { quote: words[1]!, page: 1 }]);
    file.annotations[0]!.body = `See \\ref{${file.annotations[1]!.id}}.`;
    const page = (await layoutDocument(file, geometry, fonts, [1])).pages[0]!;
    expect(page.links).toHaveLength(1);
    expect(page.links![0]!.target).toBe(file.annotations[1]!.id);
    const box = page.items.find((i) => i.id === file.annotations[0]!.id)!.box!;
    const [x, y, w, h] = page.links![0]!.rect;
    expect(x).toBeGreaterThan(box[0]);
    expect(x + w).toBeLessThanOrEqual(box[0] + box[2]);
    expect(y).toBeGreaterThanOrEqual(box[1]);
    expect(y + h).toBeLessThanOrEqual(box[1] + box[3] + 1);
  });

  it('is deterministic and independent of annotation order', async () => {
    const file = fileWith(words.slice(0, 10).map((quote) => ({ quote, page: 1 })));
    const a = JSON.stringify(await layoutDocument(file, geometry, fonts));
    fc.assert(
      fc.property(fc.shuffledSubarray(file.annotations, { minLength: file.annotations.length }), (shuffled) => {
        return JSON.stringify(computeLayoutSync({ ...file, annotations: shuffled })) === a;
      }),
      { numRuns: 20 },
    );
  });
});

import { computeLayout } from './engine.ts';
function computeLayoutSync(file: AnnotFile) {
  return computeLayout({ file, geometry, fonts });
}
