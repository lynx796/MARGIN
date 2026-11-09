import type { Annotation, AnnotFile, Category, Rect } from '../model/types.ts';
import { baselineOf } from '../pdf/extract.ts';
import { toOutputRect, type Column, type DocGeometry, type PageGeometry } from '../geometry/geometry.ts';
import { BOX_RADIUS, layoutBox, NUMBER_SIZE, type CommentBox } from '../text/box.ts';
import type { FontSet } from '../text/fonts.ts';
import { placeColumn } from './pava.ts';
import type { Layout, LinkRect, NotesPage, PageItem, PageLayout, Prim } from './types.ts';

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
/** Overflow step 1 (§6.7): comment font size steps down by this much, to at least MIN_FONT_SIZE. */
export const FONT_STEP = 0.5;
export const MIN_FONT_SIZE = 7.5;
/** Numbered tag left in the margin by a comment spilled to a notes page, pt. */
export const TAG_WIDTH = 16;
export const TAG_HEIGHT = 10;
export const NOTES_MARGIN = 36;
export const TAG_TEXT_COLOR = '#ffffff';

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
  /** Comments spilled to notes pages because they did not fit their margin column (§6.7). */
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
  /** Spilled comments occupy a small numbered tag instead of their box. */
  spilled: boolean;
  /** Distance from the top of what is placed (box or tag) to where the leader ends. */
  delta: number;
  /** Width of what is placed, and its x offset from the column's x0. */
  w: number;
  dx: number;
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

interface Attempt {
  items: Item[];
  prims: Prim[];
  placed: Map<string, PageItem>;
  links: LinkRect[];
  /** Items whose box did not fit, per column side. */
  overflowing: Item[][];
}

export function computeLayout(input: LayoutInput): LayoutResult {
  const { file, geometry, fonts } = input;
  const baseFontSize = file.settings.fontSize;
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

  const boxFor = (geo: AnchorGeo, width: number, fontSize: number): CommentBox =>
    layoutBox(geo.a.body, { id: geo.a.id, width, fontSize, color: geo.cat.color, number: numbers[geo.a.id], refNumber: (id) => numbers[id], fonts });

  const pages: PageLayout[] = [];
  for (const g of geometry.pages) {
    if (!wanted.has(g.page)) continue;
    const onPage = file.annotations
      .filter((a) => a.anchor.page === g.page && !unplaced.has(a.id) && categories.has(a.category))
      .map((a) => anchorGeo(a, categories.get(a.category)!, g))
      .filter((x): x is AnchorGeo => x !== undefined)
      .sort((p, q) => (p.a.id < q.a.id ? -1 : 1));

    const colWidth = g.left.x1 - g.left.x0;
    const textCenter = (g.left.edge + g.right.edge) / 2;
    const comments = onPage.filter((x) => x.cat.kind === 'comment');
    const boxCache = new Map<string, CommentBox>();
    const cachedBox = (geo: AnchorGeo, size: number) => {
      const key = `${geo.a.id}@${size}`;
      let b = boxCache.get(key);
      if (!b) boxCache.set(key, (b = boxFor(geo, colWidth, size)));
      return b;
    };

    const attempt = (fontSize: number, spilled: Set<string>): Attempt => {
      const under: Prim[] = [];
      const marks: Prim[] = [];
      const leaders: Prim[] = [];
      const boxes: Prim[] = [];
      const links: LinkRect[] = [];

      // Highlights (§6.3): filled quads, multiply blend, beneath the page content.
      for (const geo of onPage.filter((x) => x.cat.kind === 'highlight')) {
        for (const r of geo.rects) {
          under.push({ type: 'rect', id: geo.a.id, layer: 'under', role: 'mark', x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1], fill: geo.cat.color, fillOpacity: HIGHLIGHT_OPACITY, blend: 'multiply' });
        }
      }

      // Comment boxes and column assignment (§6.4).
      const items: Item[] = comments.map((geo) => {
        const box = cachedBox(geo, fontSize);
        const center = (geo.first[0] + geo.first[2]) / 2;
        const side = geo.a.side === 'left' || geo.a.side === 'right' ? geo.a.side : center < textCenter ? 'left' : 'right';
        const isSpilled = spilled.has(geo.a.id);
        return { geo, box, side, level: 0, lambda: 0, outerX: 0, spilled: isSpilled, delta: 0, w: isSpilled ? TAG_WIDTH : colWidth, dx: 0 };
      });
      const heightOf = (it: Item) => (it.spilled ? TAG_HEIGHT : it.box.height);

      const capacity = g.bottom - g.top;
      const demand = (side: 'left' | 'right') => {
        const col = items.filter((it) => it.side === side);
        return col.reduce((acc, it) => acc + heightOf(it), 0) + Math.max(0, col.length - 1) * BOX_GAP;
      };
      for (const side of ['left', 'right'] as const) {
        const other = side === 'left' ? 'right' : 'left';
        if (demand(side) <= capacity) continue;
        const movable = items
          .filter((it) => it.side === side && it.geo.a.side === 'auto')
          .sort((p, q) => Math.abs((p.geo.first[0] + p.geo.first[2]) / 2 - textCenter) - Math.abs((q.geo.first[0] + q.geo.first[2]) / 2 - textCenter) || (p.geo.a.id < q.geo.a.id ? -1 : 1));
        for (const it of movable) {
          if (demand(side) <= capacity) break;
          if (demand(other) + heightOf(it) + BOX_GAP > capacity) break;
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
        it.delta = it.spilled ? TAG_HEIGHT / 2 : it.box.firstBaseline + UNDERLINE_OFFSET;
        const col = columnOf(g, it.side);
        it.dx = it.spilled ? (it.side === 'left' ? col.x1 - col.x0 - TAG_WIDTH : 0) : 0;
      }

      // Anchor marks (§6.3).
      for (const it of items) {
        const { geo } = it;
        if (geo.kind === 'region') {
          const r = geo.first;
          marks.push({ type: 'rect', id: geo.a.id, layer: 'over', role: 'mark', x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1], stroke: geo.cat.color, strokeWidth: REGION_STROKE, radius: REGION_RADIUS });
          continue;
        }
        geo.rects.forEach((r, i) => {
          const y = geo.baselines[i]! + UNDERLINE_OFFSET + LEVEL_STEP * it.level;
          marks.push({ type: 'path', id: geo.a.id, layer: 'over', role: 'mark', d: line(r[0], y, r[2], y), stroke: geo.cat.color, strokeWidth: UNDERLINE_WIDTH });
        });
      }

      // Placement within each column (§6.5) and leaders (§6.6).
      const placed = new Map<string, PageItem>(onPage.map((geo) => [geo.a.id, { id: geo.a.id, anchor: geo.rects.map((r) => r.map(round3) as Rect) }]));
      const overflowing: Item[][] = [];
      for (const side of ['left', 'right'] as const) {
        const col = columnOf(g, side);
        const inCol = items
          .filter((it) => it.side === side)
          .sort((p, q) => p.lambda - q.lambda || p.outerX - q.outerX || (p.geo.a.id < q.geo.a.id ? -1 : 1));
        const placement = placeColumn({
          targets: inCol.map((it) => it.lambda - it.delta),
          heights: inCol.map(heightOf),
          weights: inCol.map((it) => it.geo.cat.weight),
          gap: BOX_GAP,
          top: g.top,
          bottom: g.bottom,
        });
        if (inCol.some((it, i) => placement.y[i]! + heightOf(it) > g.bottom + 1e-6)) overflowing.push(inCol.filter((it) => !it.spilled));
        inCol.forEach((it, i) => {
          const y = placement.y[i]!;
          const color = it.geo.cat.color;
          const id = it.geo.a.id;
          const e = col.edge;
          const boxX = side === 'left' ? col.x1 : col.x0;
          const end = y + it.delta;
          if (leaderStyle === 'full') {
            const reachesEdge = side === 'left' ? it.outerX > e : it.outerX < e;
            if (reachesEdge) leaders.push({ type: 'path', id, layer: 'over', role: 'leader', d: line(it.outerX, it.lambda, e, it.lambda), stroke: color, strokeWidth: LEADER_WIDTH, dash: LEADER_DASH });
          } else {
            const tickEnd = side === 'left' ? e + GUTTER_TICK : e - GUTTER_TICK;
            leaders.push({ type: 'path', id, layer: 'over', role: 'leader', d: line(tickEnd, it.lambda, e, it.lambda), stroke: color, strokeWidth: LEADER_WIDTH });
          }
          leaders.push({ type: 'path', id, layer: 'over', role: 'leader', d: line(e, it.lambda, boxX, end), stroke: color, strokeWidth: LEADER_WIDTH });
          const x = col.x0 + it.dx;
          if (it.spilled) {
            boxes.push(...tagPrims(id, color, numbers[id], x, y, fonts));
            Object.assign(placed.get(id)!, { side, box: [x, y, TAG_WIDTH, TAG_HEIGHT].map(round3), spilled: true });
          } else {
            for (const p of it.box.prims) boxes.push(translate({ ...p, role: 'box' }, x, y));
            for (const r of it.box.refs) links.push({ target: r.target, rect: [x + r.rect[0], y + r.rect[1], r.rect[2], r.rect[3]].map(round3) as LinkRect['rect'] });
            Object.assign(placed.get(id)!, { side, box: [x, y, colWidth, it.box.height].map(round3) });
          }
        });
      }
      return { items, prims: [...under, ...marks, ...leaders, ...boxes], placed, links, overflowing };
    };

    // Overflow (§6.7): first smaller type in 0.5 pt steps, then spill the least important comments.
    let fontSize = baseFontSize;
    let spilled = new Set<string>();
    let result = attempt(fontSize, spilled);
    while (result.overflowing.length && fontSize - FONT_STEP >= MIN_FONT_SIZE - 1e-9) {
      fontSize -= FONT_STEP;
      result = attempt(fontSize, spilled);
    }
    while (result.overflowing.length) {
      const candidates = result.overflowing.flat();
      if (candidates.length === 0) break;
      candidates.sort((p, q) => p.geo.cat.weight - q.geo.cat.weight || q.box.height - p.box.height || (p.geo.a.id < q.geo.a.id ? -1 : 1));
      spilled = new Set([...spilled, candidates[0]!.geo.a.id]);
      result = attempt(fontSize, spilled);
    }

    for (const geo of comments) {
      const box = cachedBox(geo, fontSize);
      for (const message of box.mathErrors) diagnostics.mathErrors.push({ id: geo.a.id, message });
      for (const target of box.danglingRefs) diagnostics.danglingRefs.push({ id: geo.a.id, target });
    }

    const spilledIds = [...spilled].sort();
    const notes = spilledIds.length ? notesPages(g.outWidth, g.outHeight, spilledIds.map((id) => ({ geo: comments.find((c) => c.a.id === id)!, box: cachedBox(comments.find((c) => c.a.id === id)!, fontSize) })), fontSize, (geo, width) => boxFor(geo, width, fontSize)) : [];
    if (spilledIds.length) diagnostics.overflow.push({ page: g.page, ids: spilledIds });

    pages.push({
      page: g.page,
      width: round3(g.outWidth),
      height: round3(g.outHeight),
      fontSize,
      overflow: spilledIds,
      items: [...result.placed.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
      prims: result.prims.map(roundPrim),
      ...(result.links.length ? { links: result.links } : {}),
      ...(notes.length ? { notes } : {}),
    });
  }
  return { pages, numbers, diagnostics };
}

/** The tag a spilled comment leaves in the margin: its number on a filled rounded rectangle. */
function tagPrims(id: string, color: string, n: number | undefined, x: number, y: number, fonts: FontSet): Prim[] {
  const prims: Prim[] = [{ type: 'rect', id, layer: 'over', role: 'box', x, y, w: TAG_WIDTH, h: TAG_HEIGHT, fill: color, radius: BOX_RADIUS }];
  if (n !== undefined) {
    const shaped = fonts.shape('sans-bold', String(n), NUMBER_SIZE);
    prims.push({ type: 'glyphRun', id, layer: 'over', role: 'box', font: 'sans-bold', size: NUMBER_SIZE, color: TAG_TEXT_COLOR, x: x + (TAG_WIDTH - shaped.width) / 2, y: y + (TAG_HEIGHT + 0.7 * NUMBER_SIZE) / 2, text: String(n), advances: shaped.advances });
  }
  return prims;
}

/**
 * Notes pages for spilled comments (§6.7): same size as the page, one wide column of boxes in
 * reading order, continued on further pages if needed.
 */
function notesPages(
  width: number,
  height: number,
  spilled: { geo: AnchorGeo; box: CommentBox }[],
  fontSize: number,
  layout: (geo: AnchorGeo, width: number) => CommentBox,
): NotesPage[] {
  const noteWidth = Math.max(100, Math.min(width - 2 * NOTES_MARGIN, 40 * fontSize));
  const x = (width - noteWidth) / 2;
  const ordered = [...spilled].sort((p, q) => p.geo.first[1] - q.geo.first[1] || p.geo.first[0] - q.geo.first[0] || (p.geo.a.id < q.geo.a.id ? -1 : 1));
  const out: NotesPage[] = [];
  let cur: (NotesPage & { links: LinkRect[] }) | undefined;
  let y = NOTES_MARGIN;
  for (const { geo } of ordered) {
    const box = layout(geo, noteWidth);
    if (!cur || (y + box.height > height - NOTES_MARGIN && y > NOTES_MARGIN)) {
      cur = { width: round3(width), height: round3(height), items: [], prims: [], links: [] };
      out.push(cur);
      y = NOTES_MARGIN;
    }
    for (const p of box.prims) cur.prims.push(roundPrim(translate({ ...p, role: 'box' }, x, y)));
    for (const r of box.refs) cur.links.push({ target: r.target, rect: [x + r.rect[0], y + r.rect[1], r.rect[2], r.rect[3]].map(round3) as LinkRect['rect'] });
    cur.items.push({ id: geo.a.id, box: [x, y, noteWidth, box.height].map(round3) as [number, number, number, number] });
    y += box.height + BOX_GAP;
  }
  for (const n of out) if (n.links?.length === 0) delete n.links;
  return out;
}
