import type { Annotation, AnnotFile, Category, Rect } from '../model/types.ts';
import { baselineOf } from '../pdf/extract.ts';
import { toOutputRect, type Column, type DocGeometry, type PageGeometry } from '../geometry/geometry.ts';
import { layoutBox, type CommentBox } from '../text/box.ts';
import type { FontSet } from '../text/fonts.ts';
import { placeColumn } from './pava.ts';
import type { Layout, PageLayout, Prim } from './types.ts';

// Comment layout engine (spec §6): a pure function from (geometry, annotation file, fonts) to a
// display list. Each page is laid out independently; numbering is document-wide.

/** Vertical gap between boxes in a column, pt (§6.4). */
export const BOX_GAP = 4;
export const UNDERLINE_WIDTH = 1;
/** Underline distance below the baseline, and extra drop per overlap level, pt (§6.3). */
export const UNDERLINE_OFFSET = 1.5;
export const LEVEL_STEP = 1.5;
export const MAX_LEVEL = 2;
export const HIGHLIGHT_OPACITY = 0.3;
export const REGION_STROKE = 1;
export const REGION_RADIUS = 1.5;
export const LEADER_WIDTH = 0.6;
export const LEADER_DASH = [0.6, 1.2];
export const GUTTER_TICK = 4;

export interface LayoutInput {
  file: AnnotFile;
  geometry: DocGeometry;
  fonts: FontSet;
  /** Pages to lay out (1-based); default all. Numbering always covers the whole document. */
  pages?: number[];
}

export interface Diagnostics {
  mathErrors: { id: string; message: string }[];
  danglingRefs: { id: string; target: string }[];
  /** Comments that did not fit their margin column. */
  overflow: { page: number; ids: string[] }[];
  /** Annotations without resolvable geometry (unresolved or ambiguous anchors, bad page). */
  unplaced: string[];
}

export interface LayoutResult extends Layout {
  diagnostics: Diagnostics;
}

/** Geometry of an annotation's anchor in output coordinates. */
interface AnchorGeo {
  a: Annotation;
  cat: Category;
  kind: 'text' | 'region';
  /** Output rects: line quads, or the region rectangle. */
  rects: Rect[];
  /** Output baseline per rect (text anchors). */
  baselines: number[];
  first: Rect;
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function roundPrim(p: Prim): Prim {
  const q = { ...p } as Record<string, unknown>;
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === 'number') q[k] = round3(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) q[k] = v.map(round3);
  }
  return q as unknown as Prim;
}

function translate(p: Prim, dx: number, dy: number): Prim {
  if (p.type === 'path') return p;
  return { ...p, x: p.x + dx, y: p.y + dy };
}

function fmt(v: number): string {
  return String(round3(v));
}

function line(x0: number, y0: number, x1: number, y1: number): string {
  return `M${fmt(x0)} ${fmt(y0)}L${fmt(x1)} ${fmt(y1)}`;
}

function anchorRect(a: Annotation): Rect | undefined {
  return a.anchor.type === 'region' ? a.anchor.rect : a.anchor.quads?.[0];
}

/** Display numbers 1…N for comments (not highlights) in reading order: page, anchor y, anchor x (§6.8). */
export function computeNumbers(file: AnnotFile): Record<string, number> {
  const kinds = new Map(file.categories.map((c) => [c.id, c.kind]));
  const placed = file.annotations.filter((a) => kinds.get(a.category) !== 'highlight' && a.anchor.page !== undefined && anchorRect(a));
  placed.sort((a, b) => {
    const ra = anchorRect(a)!;
    const rb = anchorRect(b)!;
    return a.anchor.page! - b.anchor.page! || ra[1] - rb[1] || ra[0] - rb[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const out: Record<string, number> = {};
  placed.forEach((a, i) => (out[a.id] = i + 1));
  return out;
}

function anchorGeo(a: Annotation, cat: Category, g: PageGeometry): AnchorGeo | undefined {
  if (a.anchor.type === 'region') {
    const r = toOutputRect(g, a.anchor.rect);
    return { a, cat, kind: 'region', rects: [r], baselines: [r[1]], first: r };
  }
  const quads = a.anchor.quads;
  if (!quads || quads.length === 0) return undefined;
  const rects = quads.map((q) => toOutputRect(g, q));
  const baselines = quads.map((q) => g.oy + g.s * baselineOf(q));
  return { a, cat, kind: 'text', rects, baselines, first: rects[0]! };
}

interface Item {
  geo: AnchorGeo;
  box: CommentBox;
  side: 'left' | 'right';
  level: number;
  /** Leader start height λ (§6.5). */
  lambda: number;
  /** Outer end of the anchor's first line on the column side. */
  outerX: number;
}

function lineKey(y: number): number {
  return Math.round(y * 2) / 2;
}

/** Assign underline levels (§6.3, §6.6). */
function assignLevels(items: Item[], all: AnchorGeo[]): Map<string, number> {
  const levels = new Map<string, number>();
  const column = new Map(items.map((it) => [it.geo.a.id, it]));
  const textGeos = all.filter((g) => g.kind === 'text' && g.cat.kind === 'comment');
  const edgeDistance = (geo: AnchorGeo): number => {
    const it = column.get(geo.a.id);
    if (!it) return 0;
    return it.side === 'left' ? geo.first[0] : -geo.first[2];
  };
  const order = [...textGeos].sort(
    (p, q) => lineKey(p.baselines[0]!) - lineKey(q.baselines[0]!) || edgeDistance(p) - edgeDistance(q) || (p.a.id < q.a.id ? -1 : 1),
  );
  const done: AnchorGeo[] = [];
  for (const geo of order) {
    const used = new Set<number>();
    let minAbove = 0;
    for (const other of done) {
      const lo = levels.get(other.a.id)!;
      // Same first line and same column: the farther anchor's dotted leader runs below the nearer.
      const itA = column.get(geo.a.id);
      const itB = column.get(other.a.id);
      if (itA && itB && itA.side === itB.side && lineKey(geo.baselines[0]!) === lineKey(other.baselines[0]!)) {
        minAbove = Math.max(minAbove, lo + 1);
      }
      // Overlapping fragments on a shared line need distinct levels.
      geo.rects.forEach((r, i) => {
        other.rects.forEach((s, j) => {
          if (lineKey(geo.baselines[i]!) === lineKey(other.baselines[j]!) && r[0] < s[2] && s[0] < r[2]) used.add(lo);
        });
      });
    }
    let level = minAbove;
    while (used.has(level)) level++;
    levels.set(geo.a.id, level);
    done.push(geo);
  }
  return levels;
}

function columnOf(g: PageGeometry, side: 'left' | 'right'): Column {
  return side === 'left' ? g.left : g.right;
}

export function computeLayout(input: LayoutInput): LayoutResult {
  const { file, geometry, fonts } = input;
  const fontSize = file.settings.fontSize;
  const leaderStyle = file.settings.leaderStyle;
  const categories = new Map(file.categories.map((c) => [c.id, c]));
  const numbers = computeNumbers(file);
  const diagnostics: Diagnostics = { mathErrors: [], danglingRefs: [], overflow: [], unplaced: [] };
  const wanted = new Set(input.pages ?? geometry.pages.map((p) => p.page));

  for (const a of file.annotations) {
    const ok = a.anchor.page !== undefined && a.anchor.page >= 1 && a.anchor.page <= geometry.pages.length && anchorRect(a) && a.status !== 'unresolved' && a.status !== 'ambiguous';
    if (!ok) diagnostics.unplaced.push(a.id);
  }
  const unplaced = new Set(diagnostics.unplaced);

  const pages: PageLayout[] = [];
  for (const g of geometry.pages) {
    if (!wanted.has(g.page)) continue;
    const onPage = file.annotations
      .filter((a) => a.anchor.page === g.page && !unplaced.has(a.id) && categories.has(a.category))
      .map((a) => anchorGeo(a, categories.get(a.category)!, g))
      .filter((x): x is AnchorGeo => x !== undefined)
      .sort((p, q) => (p.a.id < q.a.id ? -1 : 1));

    const under: Prim[] = [];
    const marks: Prim[] = [];
    const leaders: Prim[] = [];
    const boxes: Prim[] = [];

    // Highlights (§6.3): filled quads, multiply blend, beneath the page content.
    for (const geo of onPage.filter((x) => x.cat.kind === 'highlight')) {
      for (const r of geo.rects) {
        under.push({ type: 'rect', id: geo.a.id, layer: 'under', x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1], fill: geo.cat.color, fillOpacity: HIGHLIGHT_OPACITY, blend: 'multiply' });
      }
    }

    // Comment boxes and column assignment (§6.4).
    const comments = onPage.filter((x) => x.cat.kind === 'comment');
    const colWidth = g.left.x1 - g.left.x0;
    const textCenter = (g.left.edge + g.right.edge) / 2;
    const items: Item[] = comments.map((geo) => {
      const box = layoutBox(geo.a.body, {
        id: geo.a.id,
        width: colWidth,
        fontSize,
        color: geo.cat.color,
        number: numbers[geo.a.id],
        refNumber: (id) => numbers[id],
        fonts,
      });
      for (const message of box.mathErrors) diagnostics.mathErrors.push({ id: geo.a.id, message });
      for (const target of box.danglingRefs) diagnostics.danglingRefs.push({ id: geo.a.id, target });
      const center = (geo.first[0] + geo.first[2]) / 2;
      const side = geo.a.side === 'left' || geo.a.side === 'right' ? geo.a.side : center < textCenter ? 'left' : 'right';
      return { geo, box, side, level: 0, lambda: 0, outerX: 0 };
    });

    const capacity = g.bottom - g.top;
    const demand = (side: 'left' | 'right') => {
      const col = items.filter((it) => it.side === side);
      return col.reduce((acc, it) => acc + it.box.height, 0) + Math.max(0, col.length - 1) * BOX_GAP;
    };
    for (const side of ['left', 'right'] as const) {
      const other = side === 'left' ? 'right' : 'left';
      if (demand(side) <= capacity) continue;
      const movable = items
        .filter((it) => it.side === side && it.geo.a.side === 'auto')
        .sort((p, q) => Math.abs((p.geo.first[0] + p.geo.first[2]) / 2 - textCenter) - Math.abs((q.geo.first[0] + q.geo.first[2]) / 2 - textCenter) || (p.geo.a.id < q.geo.a.id ? -1 : 1));
      for (const it of movable) {
        if (demand(side) <= capacity) break;
        if (demand(other) + it.box.height + BOX_GAP > capacity) break;
        it.side = other;
      }
    }

    // Levels, leader heights and outer ends.
    const levels = assignLevels(items, onPage);
    for (const it of items) {
      const geo = it.geo;
      it.level = Math.min(levels.get(geo.a.id) ?? 0, MAX_LEVEL);
      if (geo.kind === 'region') {
        const r = geo.first;
        it.lambda = r[1] + Math.min((r[3] - r[1]) / 2, 6);
      } else {
        it.lambda = geo.baselines[0]! + UNDERLINE_OFFSET + LEVEL_STEP * it.level;
      }
      it.outerX = it.side === 'left' ? geo.first[0] : geo.first[2];
    }

    // Anchor marks (§6.3).
    for (const it of items) {
      const { geo } = it;
      if (geo.kind === 'region') {
        const r = geo.first;
        marks.push({ type: 'rect', id: geo.a.id, layer: 'over', x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1], stroke: geo.cat.color, strokeWidth: REGION_STROKE, radius: REGION_RADIUS });
        continue;
      }
      geo.rects.forEach((r, i) => {
        const y = geo.baselines[i]! + UNDERLINE_OFFSET + LEVEL_STEP * it.level;
        marks.push({ type: 'path', id: geo.a.id, layer: 'over', d: line(r[0], y, r[2], y), stroke: geo.cat.color, strokeWidth: UNDERLINE_WIDTH });
      });
    }

    // Placement within each column (§6.5) and leaders (§6.6).
    const overflow: string[] = [];
    for (const side of ['left', 'right'] as const) {
      const col = columnOf(g, side);
      const inCol = items
        .filter((it) => it.side === side)
        .sort((p, q) => p.lambda - q.lambda || p.outerX - q.outerX || (p.geo.a.id < q.geo.a.id ? -1 : 1));
      const delta = inCol.map((it) => it.box.firstBaseline + UNDERLINE_OFFSET);
      const placement = placeColumn({
        targets: inCol.map((it, i) => it.lambda - delta[i]!),
        heights: inCol.map((it) => it.box.height),
        weights: inCol.map((it) => it.geo.cat.weight),
        gap: BOX_GAP,
        top: g.top,
        bottom: g.bottom,
      });
      inCol.forEach((it, i) => {
        const y = placement.y[i]!;
        if (y + it.box.height > g.bottom + 1e-6) overflow.push(it.geo.a.id);
        const color = it.geo.cat.color;
        const id = it.geo.a.id;
        const e = col.edge;
        const boxX = side === 'left' ? col.x1 : col.x0;
        const end = y + delta[i]!;
        if (leaderStyle === 'full') {
          const reachesEdge = side === 'left' ? it.outerX > e : it.outerX < e;
          if (reachesEdge) leaders.push({ type: 'path', id, layer: 'over', d: line(it.outerX, it.lambda, e, it.lambda), stroke: color, strokeWidth: LEADER_WIDTH, dash: LEADER_DASH });
        } else {
          const tickEnd = side === 'left' ? e + GUTTER_TICK : e - GUTTER_TICK;
          leaders.push({ type: 'path', id, layer: 'over', d: line(tickEnd, it.lambda, e, it.lambda), stroke: color, strokeWidth: LEADER_WIDTH });
        }
        leaders.push({ type: 'path', id, layer: 'over', d: line(e, it.lambda, boxX, end), stroke: color, strokeWidth: LEADER_WIDTH });
        for (const p of it.box.prims) boxes.push(translate(p, col.x0, y));
      });
    }
    if (overflow.length) diagnostics.overflow.push({ page: g.page, ids: overflow.sort() });

    pages.push({
      page: g.page,
      width: round3(g.outWidth),
      height: round3(g.outHeight),
      fontSize,
      overflow: overflow.sort(),
      prims: [...under, ...marks, ...leaders, ...boxes].map(roundPrim),
    });
  }
  return { pages, numbers, diagnostics };
}
