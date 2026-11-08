import type { Color, FontKey, Prim } from '../layout/types.ts';
import { getMath, type MathBox } from '../math/mathjax.ts';
import type { FontSet } from './fonts.ts';
import { parseMarkup, type Inline, type Style } from './markup.ts';

// Comment box layout (spec §6.2): greedy first-fit line breaking over words, inline math and glue,
// inside a box with a colored left stripe, tinted background and the display number top-right.
// The result is a height and a list of primitives relative to the box's top-left corner.

export const BOX_PADDING = 4;
export const STRIPE_WIDTH = 2;
export const BOX_RADIUS = 2;
export const BACKGROUND_OPACITY = 0.08;
export const LINE_HEIGHT = 1.25;
export const PARAGRAPH_GAP = 3;
export const NUMBER_SIZE = 6.5;
export const NUMBER_COLOR = '#6b7280';
export const TEXT_COLOR = '#1a1a1a';
export const ERROR_COLOR = '#dc2626';
/** Inline math wider than the line is scaled down to at most this factor (§6.2). */
export const MIN_MATH_SCALE = 0.7;
const DISPLAY_GAP = 2;

export interface BoxOptions {
  id: string;
  /** Box width (column width), pt. */
  width: number;
  fontSize: number;
  color: Color;
  /** Display number shown top-right; omitted for unnumbered boxes. */
  number?: number;
  /** Display number of a referenced annotation, or undefined if dangling. */
  refNumber: (id: string) => number | undefined;
  fonts: FontSet;
}

export interface CommentBox {
  id: string;
  width: number;
  height: number;
  /** Distance from the box top to the first baseline. */
  firstBaseline: number;
  /** Primitives relative to the box origin, layer 'over'. */
  prims: Prim[];
  /** TeX errors in the body (§6.2 `mathError`). */
  mathErrors: string[];
  /** Dangling \ref targets. */
  danglingRefs: string[];
}

type Piece =
  | { kind: 'text'; font: FontKey; color: Color; text: string; advances: number[]; width: number }
  | { kind: 'math'; box: MathBox; scale: number; width: number };

/** A run of pieces with no breakpoint inside. */
type Chunk = { pieces: Piece[]; width: number; spaceBefore: number };

interface Line {
  chunks: Chunk[];
  width: number;
}

function fontFor(style: Style): FontKey {
  if (style.mono) return 'mono';
  if (style.bold && style.italic) return 'sans-bolditalic';
  if (style.bold) return 'sans-bold';
  if (style.italic) return 'sans-italic';
  return 'sans';
}

function chunkWidth(pieces: Piece[]): number {
  return pieces.reduce((a, p) => a + p.width, 0);
}

export function layoutBox(body: string, o: BoxOptions): CommentBox {
  const fs = o.fontSize;
  const contentX = STRIPE_WIDTH + BOX_PADDING;
  const contentW = Math.max(10, o.width - contentX - BOX_PADDING);
  const mathErrors: string[] = [];
  const danglingRefs: string[] = [];

  const numberText = o.number !== undefined ? String(o.number) : '';
  const numberShaped = numberText ? o.fonts.shape('sans', numberText, NUMBER_SIZE) : undefined;
  const firstLineW = numberShaped ? contentW - numberShaped.width - 3 : contentW;

  const textPiece = (font: FontKey, color: Color, text: string): Piece => {
    const s = o.fonts.shape(font, text, fs);
    return { kind: 'text', font, color, text, advances: s.advances, width: s.width };
  };

  // Turn inline items into chunks separated by breakable spaces.
  const toChunks = (items: Inline[]): Chunk[] => {
    const chunks: Chunk[] = [];
    let cur: Piece[] = [];
    let pendingSpace = 0;
    let curSpace = 0;
    const close = () => {
      if (cur.length) chunks.push({ pieces: cur, width: chunkWidth(cur), spaceBefore: curSpace });
      cur = [];
    };
    const addPiece = (p: Piece) => {
      if (cur.length === 0) {
        curSpace = chunks.length === 0 ? 0 : pendingSpace;
        pendingSpace = 0;
      }
      cur.push(p);
    };
    const addSpace = (font: FontKey) => {
      close();
      if (pendingSpace === 0) pendingSpace = o.fonts.width(font, ' ', fs);
    };
    for (const item of items) {
      if (item.kind === 'math') {
        const box = getMath(item.tex, false);
        if (box.error) {
          mathErrors.push(box.error);
          addPiece(textPiece('mono', ERROR_COLOR, `\\(${item.tex}\\)`));
        } else {
          addPiece({ kind: 'math', box, scale: 1, width: box.width * fs });
        }
        continue;
      }
      if (item.kind === 'ref') {
        const n = o.refNumber(item.id);
        if (n === undefined) danglingRefs.push(item.id);
        addPiece(textPiece(fontFor(item.style), n === undefined ? ERROR_COLOR : TEXT_COLOR, n === undefined ? '??' : String(n)));
        continue;
      }
      const font = fontFor(item.style);
      const parts = item.text.split(/( +)/);
      for (const part of parts) {
        if (part === '') continue;
        if (/^ +$/.test(part)) addSpace(font);
        else addPiece(textPiece(font, TEXT_COLOR, part));
      }
    }
    close();
    return chunks;
  };

  // Split a chunk that is wider than the line into character pieces (emergency break).
  const splitWide = (chunk: Chunk, maxW: number): Chunk[] => {
    const out: Chunk[] = [];
    let cur: Piece[] = [];
    let w = 0;
    const flush = () => {
      if (cur.length) out.push({ pieces: cur, width: w, spaceBefore: out.length === 0 ? chunk.spaceBefore : 0 });
      cur = [];
      w = 0;
    };
    for (const p of chunk.pieces) {
      if (p.kind === 'math') {
        let piece = p;
        if (p.width > maxW) {
          const scale = Math.max(MIN_MATH_SCALE, maxW / p.width);
          piece = { ...p, scale, width: p.width * scale };
        }
        if (w + piece.width > maxW && cur.length) flush();
        cur.push(piece);
        w += piece.width;
        continue;
      }
      const cps = Array.from(p.text);
      let start = 0;
      let segW = 0;
      for (let i = 0; i < cps.length; i++) {
        const a = p.advances[i]!;
        if (w + segW + a > maxW && (cur.length || i > start)) {
          if (i > start) cur.push({ ...p, text: cps.slice(start, i).join(''), advances: p.advances.slice(start, i), width: segW });
          w += segW;
          flush();
          start = i;
          segW = 0;
        }
        segW += a;
      }
      if (start < cps.length) {
        cur.push({ ...p, text: cps.slice(start).join(''), advances: p.advances.slice(start), width: segW });
        w += segW;
      }
    }
    flush();
    return out;
  };

  const breakLines = (chunks: Chunk[], firstW: number): Line[] => {
    const lines: Line[] = [];
    let line: Line = { chunks: [], width: 0 };
    const avail = () => (lines.length === 0 && lineIndex === 0 ? firstW : contentW);
    for (const chunk of chunks) {
      const parts = chunk.width > contentW ? splitWide(chunk, contentW) : [chunk];
      for (const part of parts) {
        const space = line.chunks.length ? part.spaceBefore : 0;
        if (line.chunks.length && line.width + space + part.width > avail()) {
          lines.push(line);
          lineIndex++;
          line = { chunks: [{ ...part, spaceBefore: 0 }], width: part.width };
        } else {
          line.chunks.push({ ...part, spaceBefore: space });
          line.width += space + part.width;
        }
      }
    }
    lines.push(line);
    lineIndex++;
    return lines;
  };

  const prims: Prim[] = [];
  const above0 = (LINE_HEIGHT - 1) / 2 * fs + 0.8 * fs;
  const below0 = LINE_HEIGHT * fs - above0;
  let y = BOX_PADDING;
  let lineIndex = 0;
  let firstBaseline: number | undefined;

  const emitLine = (line: Line) => {
    let above = above0;
    let below = below0;
    for (const c of line.chunks) {
      for (const p of c.pieces) {
        if (p.kind === 'math') {
          above = Math.max(above, (p.box.height * p.scale + 0.05) * fs);
          below = Math.max(below, (p.box.depth * p.scale + 0.05) * fs);
        }
      }
    }
    const baseline = y + above;
    firstBaseline ??= baseline;
    let x = contentX;
    let run: (Piece & { kind: 'text' }) | undefined;
    let runX = 0;
    const flushRun = () => {
      if (run) prims.push({ type: 'glyphRun', id: o.id, layer: 'over', font: run.font, size: fs, color: run.color, x: runX, y: baseline, text: run.text, advances: run.advances });
      run = undefined;
    };
    for (const c of line.chunks) {
      if (c.spaceBefore > 0) {
        // Keep spaces inside a glyph run when the next piece continues it, so exported text copies well.
        const next = c.pieces[0];
        if (run && next?.kind === 'text' && next.font === run.font && next.color === run.color) {
          run = { ...run, text: run.text + ' ', advances: [...run.advances, c.spaceBefore], width: run.width + c.spaceBefore };
        } else {
          flushRun();
        }
        x += c.spaceBefore;
      }
      for (const p of c.pieces) {
        if (p.kind === 'text') {
          if (run && run.font === p.font && run.color === p.color) {
            run = { ...run, text: run.text + p.text, advances: [...run.advances, ...p.advances], width: run.width + p.width };
          } else {
            flushRun();
            run = { ...p };
            runX = x;
          }
        } else {
          flushRun();
          prims.push({ type: 'svg', id: o.id, layer: 'over', x, y: baseline, scale: (fs * p.scale) / 1000, paths: p.box.paths, color: TEXT_COLOR });
        }
        x += p.width;
      }
    }
    flushRun();
    y = baseline + below;
  };

  const emitDisplay = (tex: string) => {
    const box = getMath(tex, true);
    if (box.error) {
      mathErrors.push(box.error);
      const chunks = splitWide({ pieces: [textPiece('mono', ERROR_COLOR, `\\[${tex}\\]`)], width: Infinity, spaceBefore: 0 }, contentW);
      for (const c of chunks) emitLine({ chunks: [c], width: c.width });
      return;
    }
    const natural = box.width * fs;
    const scale = natural > contentW ? Math.max(MIN_MATH_SCALE, contentW / natural) : 1;
    const w = natural * scale;
    y += DISPLAY_GAP;
    const baseline = y + box.height * fs * scale;
    firstBaseline ??= baseline;
    const x = contentX + Math.max(0, (contentW - w) / 2);
    prims.push({ type: 'svg', id: o.id, layer: 'over', x, y: baseline, scale: (fs * scale) / 1000, paths: box.paths, color: TEXT_COLOR });
    y = baseline + box.depth * fs * scale + DISPLAY_GAP;
    lineIndex++;
  };

  const paragraphs = parseMarkup(body);
  paragraphs.forEach((para, pi) => {
    if (pi > 0) y += PARAGRAPH_GAP;
    for (const block of para) {
      if (block.kind === 'display') emitDisplay(block.tex);
      else for (const line of breakLines(toChunks(block.items), firstLineW)) emitLine(line);
    }
  });
  if (paragraphs.length === 0) emitLine({ chunks: [], width: 0 });
  const height = y + BOX_PADDING;

  const decoration: Prim[] = [
    { type: 'rect', id: o.id, layer: 'over', x: 0, y: 0, w: o.width, h: height, fill: o.color, fillOpacity: BACKGROUND_OPACITY, radius: BOX_RADIUS },
    { type: 'rect', id: o.id, layer: 'over', x: 0, y: 0, w: STRIPE_WIDTH, h: height, fill: o.color },
  ];
  if (numberShaped) {
    decoration.push({
      type: 'glyphRun', id: o.id, layer: 'over', font: 'sans', size: NUMBER_SIZE, color: NUMBER_COLOR,
      x: o.width - BOX_PADDING - numberShaped.width, y: BOX_PADDING + 0.75 * NUMBER_SIZE, text: numberText, advances: numberShaped.advances,
    });
  }
  return { id: o.id, width: o.width, height, firstBaseline: firstBaseline ?? BOX_PADDING + above0, prims: [...decoration, ...prims], mathErrors, danglingRefs };
}
