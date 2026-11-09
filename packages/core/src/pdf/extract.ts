import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from '../model/types.ts';

// Text extraction with per-character boxes (spec §3 `pdf`, §7.5).
//
// pdf.js's getTextContent() only reports runs of text. To get exact character boxes we replay the
// page's operator list through a minimal text-state machine, mirroring how pdf.js's own canvas
// renderer positions glyphs (CanvasGraphics.showText). The result is independent of any browser
// rendering, so stored geometry is the same in the web app and the CLI.

/** Vertical extent of a character box as fractions of the font size, above / below the baseline.
 *  Fixed (not per font) so that the baseline is recoverable from any quad: see `baselineOf`. */
export const ASCENT = 0.75;
export const DESCENT = 0.22;

/** Baseline y of a line quad produced by this module. */
export function baselineOf(quad: Rect): number {
  return quad[1] + (ASCENT / (ASCENT + DESCENT)) * (quad[3] - quad[1]);
}

export interface TextLine {
  /** Range [start, end) into PageText.text, excluding the trailing newline. */
  start: number;
  end: number;
  /** Box of the whole line, using the line's dominant font size for the vertical extent. */
  box: Rect;
  baseline: number;
  fontSize: number;
}

export interface PageText {
  page: number;
  /** Page text in content-stream order; lines separated by '\n', word gaps by ' '. */
  text: string;
  /** One box per UTF-16 code unit of `text`. Inserted spaces span their gap; newlines are empty. */
  boxes: Rect[];
  /** Present if some characters lie outside the clipping region: true for each such code unit. */
  hidden?: boolean[];
  /** Line index of each code unit. */
  lineOf: number[];
  lines: TextLine[];
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  // Result applies n first, then m (same convention as pdf.js Util.transform(m, n)).
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Operator arguments carry matrices as plain arrays, typed arrays, or spread numbers. */
function toMatrix(args: unknown[]): Matrix | undefined {
  const m = (Array.isArray(args[0]) || ArrayBuffer.isView(args[0]) ? args[0] : args) as ArrayLike<number>;
  if (!m || m.length < 6) return undefined;
  return [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

interface Glyph {
  unicode: string;
  width: number;
  isSpace: boolean;
}

interface FontInfo {
  fontMatrix?: number[];
  vertical?: boolean;
}

export interface RawChar {
  c: string;
  /** Page coordinates, top-left origin, y down. */
  box: Rect;
  baseline: number;
  fontSize: number;
  /** Writing direction is horizontal and upright on the page. */
  upright: boolean;
  /** Drawn later in the stream at a position inside a line: a pseudonymization token (see
   *  TOKEN_TAG). Characters of the same token share the number. */
  inline?: number;
  /** Outside the current clipping region (e.g. the cropped-away part of an included PDF page). */
  clipped?: true;
}

/**
 * Marked-content tag around the tokens drawn by pseudonymization (spec §10.3). They are appended to
 * the page's content, but belong where the removed text was; `buildPageText` moves them there.
 */
export const TOKEN_TAG = 'MarginToken';

export interface OperatorList {
  fnArray: number[];
  argsArray: unknown[][];
}

/**
 * Replay an operator list and return positioned characters.
 * @param viewport transform from PDF user space to page coordinates (pdf.js viewport.transform at scale 1)
 * @param getFont font object by loaded name (page.commonObjs.get)
 */
export function glyphsFromOperatorList(ops: OperatorList, viewport: Matrix, getFont: (name: string) => FontInfo | undefined): RawChar[] {
  interface State {
    ctm: Matrix;
    textMatrix: Matrix;
    x: number;
    y: number;
    lineX: number;
    lineY: number;
    font: FontInfo | undefined;
    fontSize: number;
    fontDirection: number;
    charSpacing: number;
    wordSpacing: number;
    hScale: number;
    leading: number;
    rise: number;
    /** Bounding box of the clipping region in page coordinates, if any clip was set. */
    clip: Rect | undefined;
  }
  let s: State = {
    ctm: IDENTITY, textMatrix: IDENTITY, x: 0, y: 0, lineX: 0, lineY: 0, font: undefined,
    fontSize: 0, fontDirection: 1, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, clip: undefined,
  };
  let pendingClip = false;
  /** Intersect the clip with a box given in current user space. */
  const clipTo = (x0: number, y0: number, x1: number, y1: number) => {
    const m = multiply(viewport, s.ctm);
    const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
    const r: Rect = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    s.clip = s.clip ? [Math.max(s.clip[0], r[0]), Math.max(s.clip[1], r[1]), Math.min(s.clip[2], r[2]), Math.min(s.clip[3], r[3])] : r;
  };
  const stack: State[] = [];
  const out: RawChar[] = [];
  /** Open marked-content sequences: the token's number for TOKEN_TAG, else 0. */
  const marked: number[] = [];
  let tokens = 0;

  const moveText = (x: number, y: number) => {
    s.x = s.lineX += x;
    s.y = s.lineY += y;
  };

  const showText = (glyphs: (Glyph | number | null)[]) => {
    const font = s.font;
    if (!font || s.fontSize === 0) return;
    const fontMatrix = font.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
    const widthAdvanceScale = s.fontSize * (fontMatrix[0] ?? 0.001);
    const hScale = s.hScale * s.fontDirection;
    // Text space → page: viewport · ctm · textMatrix · translate(x, y + rise) · scale(hScale, 1)
    const base = multiply(viewport, multiply(s.ctm, s.textMatrix));
    const effSize = s.fontSize * Math.hypot(base[2], base[3]);
    const upright = Math.abs(base[1]) < 1e-6 && Math.abs(base[2]) < 1e-6 && base[0] > 0 && base[3] < 0;
    let x = 0;
    for (const g of glyphs) {
      if (g === null || g === undefined) continue;
      if (typeof g === 'number') {
        x -= (g * s.fontSize) / 1000;
        continue;
      }
      const spacing = (g.isSpace ? s.wordSpacing : 0) + s.charSpacing;
      const advance = g.width * widthAdvanceScale;
      const left = s.x + x * hScale;
      const right = s.x + (x + advance) * hScale;
      const yb = s.y + s.rise;
      const corners = [
        apply(base, left, yb - DESCENT * s.fontSize),
        apply(base, right, yb - DESCENT * s.fontSize),
        apply(base, left, yb + ASCENT * s.fontSize),
        apply(base, right, yb + ASCENT * s.fontSize),
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const [, baseline] = apply(base, left, yb);
      if (g.unicode) {
        const box: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        const cx = (box[0] + box[2]) / 2;
        const cy = (box[1] + box[3]) / 2;
        const clipped = s.clip !== undefined && (cx < s.clip[0] || cx > s.clip[2] || cy < s.clip[1] || cy > s.clip[3]);
        out.push({
          c: g.unicode,
          box,
          baseline,
          fontSize: effSize,
          upright,
          ...(clipped ? { clipped: true as const } : {}),
          ...(marked.some((m) => m > 0) ? { inline: marked.findLast((m) => m > 0)! } : {}),
        });
      }
      x += advance + spacing * s.fontDirection;
    }
    s.x += x * hScale;
  };

  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] ?? [];
    switch (fn) {
      case OPS.save:
        stack.push({ ...s });
        break;
      case OPS.restore:
        s = stack.pop() ?? s;
        break;
      case OPS.transform: {
        const m = toMatrix(args);
        if (m) s.ctm = multiply(s.ctm, m);
        break;
      }
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...s });
        const fm = args[0] ? toMatrix([args[0]]) : undefined;
        if (fm) s.ctm = multiply(s.ctm, fm);
        const bbox = args[1] as ArrayLike<number> | null | undefined;
        if (bbox && bbox.length >= 4) clipTo(bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!);
        break;
      }
      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        break;
      case OPS.constructPath: {
        // [paint op, path data, minMax]; a pending clip takes the path's bounding box.
        const minMax = args[2] as ArrayLike<number> | null | undefined;
        if (pendingClip && minMax && minMax.length >= 4 && Number.isFinite(minMax[0])) clipTo(minMax[0]!, minMax[1]!, minMax[2]!, minMax[3]!);
        pendingClip = false;
        break;
      }
      case OPS.paintFormXObjectEnd:
        s = stack.pop() ?? s;
        break;
      case OPS.beginText:
        s.textMatrix = IDENTITY;
        s.x = s.lineX = s.y = s.lineY = 0;
        break;
      case OPS.setFont: {
        const [name, size] = args as [string, number];
        s.font = getFont(name);
        s.fontDirection = size < 0 ? -1 : 1;
        s.fontSize = Math.abs(size);
        break;
      }
      case OPS.setCharSpacing:
        s.charSpacing = args[0] as number;
        break;
      case OPS.setWordSpacing:
        s.wordSpacing = args[0] as number;
        break;
      case OPS.setHScale:
        s.hScale = (args[0] as number) / 100;
        break;
      case OPS.setLeading:
        s.leading = -(args[0] as number);
        break;
      case OPS.setTextRise:
        s.rise = args[0] as number;
        break;
      case OPS.moveText:
        moveText(args[0] as number, args[1] as number);
        break;
      case OPS.setLeadingMoveText:
        s.leading = args[1] as number;
        moveText(args[0] as number, args[1] as number);
        break;
      case OPS.setTextMatrix: {
        s.textMatrix = toMatrix(args) ?? IDENTITY;
        s.x = s.lineX = s.y = s.lineY = 0;
        break;
      }
      case OPS.nextLine:
        moveText(0, s.leading);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        showText(args[0] as Glyph[]);
        break;
      case OPS.nextLineShowText:
        moveText(0, s.leading);
        showText(args[0] as Glyph[]);
        break;
      case OPS.nextLineSetSpacingShowText:
        s.wordSpacing = args[0] as number;
        s.charSpacing = args[1] as number;
        moveText(0, s.leading);
        showText(args[2] as Glyph[]);
        break;
      case OPS.beginMarkedContent:
      case OPS.beginMarkedContentProps: {
        // pdf.js passes the tag as a Name object ({ name }).
        const tag = args[0] as { name?: string } | string | undefined;
        marked.push((typeof tag === 'string' ? tag : tag?.name) === TOKEN_TAG ? ++tokens : 0);
        break;
      }
      case OPS.endMarkedContent:
        marked.pop();
        break;
      default:
        break;
    }
  }
  return out;
}

/** Gap (in units of font size) above which a space is inserted between characters. */
const SPACE_GAP = 0.15;
/** Baseline difference (in units of font size) that starts a new line. */
const LINE_GAP = 0.6;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Move each run of `inline` characters (a pseudonymization token) next to the character it
 * replaced text beside: on the same baseline, the nearest one ending to its left within a few
 * spaces, else the nearest one starting to its right; a run with no such neighbor stays in place.
 */
function placeInline(chars: RawChar[]): RawChar[] {
  if (!chars.some((c) => c.inline)) return chars;
  const runs: RawChar[][] = [];
  const rest: RawChar[] = [];
  chars.forEach((ch, i) => {
    if (!ch.inline) rest.push(ch);
    else if (chars[i - 1]?.inline === ch.inline) runs[runs.length - 1]!.push(ch);
    else runs.push([ch]);
  });
  const after = new Map<number, RawChar[][]>();
  const before = new Map<number, RawChar[][]>();
  const unplaced: RawChar[] = [];
  for (const run of runs) {
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const size = first.fontSize;
    const reach = 3 * size;
    let left = -1;
    let right = -1;
    rest.forEach((ch, i) => {
      if (Math.abs(ch.baseline - first.baseline) > LINE_GAP * Math.max(size, ch.fontSize)) return;
      const gl = first.box[0] - ch.box[2];
      if (gl >= -0.5 * size && gl <= reach && (left < 0 || ch.box[2] > rest[left]!.box[2])) left = i;
      const gr = ch.box[0] - last.box[2];
      if (gr >= -0.5 * size && gr <= reach && (right < 0 || ch.box[0] < rest[right]!.box[0])) right = i;
    });
    if (left >= 0) after.set(left, [...(after.get(left) ?? []), run]);
    else if (right >= 0) before.set(right, [...(before.get(right) ?? []), run]);
    else unplaced.push(...run);
  }
  const out: RawChar[] = [];
  rest.forEach((ch, i) => {
    for (const run of before.get(i) ?? []) out.push(...run);
    out.push(ch);
    for (const run of after.get(i) ?? []) out.push(...run);
  });
  return [...out, ...unplaced];
}

/** Group positioned characters into lines and words, producing searchable page text. */
export function buildPageText(page: number, chars: RawChar[]): PageText {
  chars = placeInline(chars);
  const text: string[] = [];
  const boxes: Rect[] = [];
  const lineOf: number[] = [];
  const hidden: boolean[] = [];
  const lines: TextLine[] = [];

  // A line is a maximal run of consecutive (stream-order) characters whose baseline stays within
  // LINE_GAP of the line's first baseline and which do not jump back to the left.
  let lineStart = 0;
  let lineChars: RawChar[] = [];
  let prev: RawChar | undefined;
  let mainBaseline = 0;

  const closeLine = () => {
    if (lineChars.length === 0) return;
    // Dominant font size: the one covering the most horizontal extent.
    const weight = new Map<number, number>();
    for (const ch of lineChars) {
      const k = round2(ch.fontSize);
      weight.set(k, (weight.get(k) ?? 0) + (ch.box[2] - ch.box[0]));
    }
    let fontSize = lineChars[0]!.fontSize;
    let best = -1;
    for (const [k, w] of [...weight.entries()].sort((a, b) => a[0] - b[0])) {
      if (w > best) {
        best = w;
        fontSize = k;
      }
    }
    const main = lineChars.filter((ch) => round2(ch.fontSize) === fontSize);
    const baseline = main.reduce((acc, ch) => acc + ch.baseline, 0) / main.length;
    const x0 = Math.min(...lineChars.map((ch) => ch.box[0]));
    const x1 = Math.max(...lineChars.map((ch) => ch.box[2]));
    lines.push({
      start: lineStart,
      end: text.length,
      box: [round2(x0), round2(baseline - ASCENT * fontSize), round2(x1), round2(baseline + DESCENT * fontSize)],
      baseline: round2(baseline),
      fontSize,
    });
    lineChars = [];
  };

  for (const ch of chars) {
    if (/^\s+$/.test(ch.c)) {
      // Real space glyphs: treat as a gap marker, handled by the gap logic below.
      continue;
    }
    if (prev) {
      const size = Math.max(prev.fontSize, ch.fontSize, 1);
      const newLine =
        Math.abs(ch.baseline - mainBaseline) > LINE_GAP * size ||
        ch.box[2] < prev.box[0] - 0.5 * size ||
        // A token is usually narrower than the text it replaced; the rest of its box is not a column gap.
        (ch.box[0] > prev.box[2] + 4 * size && !prev.inline);
      if (newLine) {
        closeLine();
        const lastBox = boxes[boxes.length - 1]!;
        text.push('\n');
        boxes.push([lastBox[2], lastBox[1], lastBox[2], lastBox[3]]);
        lineOf.push(lines.length - 1);
        lineStart = text.length;
        mainBaseline = ch.baseline;
      } else if (ch.box[0] - prev.box[2] > SPACE_GAP * Math.min(prev.fontSize, ch.fontSize)) {
        text.push(' ');
        boxes.push([round2(prev.box[2]), round2(Math.min(prev.box[1], ch.box[1])), round2(ch.box[0]), round2(Math.max(prev.box[3], ch.box[3]))]);
        lineOf.push(lines.length);
      }
    } else {
      mainBaseline = ch.baseline;
    }
    // A glyph may map to several code units (ligatures via ToUnicode, astral characters):
    // split its box evenly.
    const n = ch.c.length;
    const w = (ch.box[2] - ch.box[0]) / n;
    for (let k = 0; k < n; k++) {
      text.push(ch.c[k]!);
      hidden[text.length - 1] = ch.clipped === true;
      boxes.push([round2(ch.box[0] + k * w), round2(ch.box[1]), round2(ch.box[0] + (k + 1) * w), round2(ch.box[3])]);
      lineOf.push(lines.length);
    }
    lineChars.push(ch);
    prev = ch;
  }
  closeLine();
  const anyHidden = hidden.some((h) => h);
  return { page, text: text.join(''), boxes, lineOf, lines, ...(anyHidden ? { hidden: Array.from({ length: text.length }, (_, i) => hidden[i] === true) } : {}) };
}
