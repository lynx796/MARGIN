import { quadsForRange, quoteForRange, type PageText, type Rect, type TextAnchor } from '@margin/core';

// Text selection on the core's character boxes (spec §7.5). The browser's own selection is not used:
// positions come from the same extraction that stores anchors, so what is highlighted while dragging
// is exactly what is stored, in every browser.

/** Distance from y to the vertical extent [y0, y1] (0 inside). */
function gap(y: number, y0: number, y1: number): number {
  return y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
}

/**
 * Caret position (boundary before character i, 0…text.length) nearest to a point in original-page
 * coordinates: the line with the smallest vertical gap, then the boundary nearest in x.
 */
export function caretAt(t: PageText, x: number, y: number): number {
  if (t.lines.length === 0) return 0;
  let best = 0;
  let bestGap = Infinity;
  let bestMid = Infinity;
  t.lines.forEach((l, i) => {
    const g = gap(y, l.box[1], l.box[3]);
    const mid = Math.abs(y - (l.box[1] + l.box[3]) / 2);
    if (g < bestGap - 1e-9 || (Math.abs(g - bestGap) <= 1e-9 && mid < bestMid)) {
      best = i;
      bestGap = g;
      bestMid = mid;
    }
  });
  const line = t.lines[best]!;
  for (let i = line.start; i < line.end; i++) {
    const b = t.boxes[i]!;
    if (x < (b[0] + b[2]) / 2) return i;
  }
  return line.end;
}

/** Selected range between two carets, trimmed of surrounding whitespace; null if empty. */
export function rangeBetween(t: PageText, a: number, b: number): [number, number] | null {
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  const blank = (c: string | undefined) => c === ' ' || c === '\n';
  while (lo < hi && blank(t.text[lo])) lo++;
  while (hi > lo && blank(t.text[hi - 1])) hi--;
  return lo < hi ? [lo, hi] : null;
}

export function textAnchorFor(t: PageText, lo: number, hi: number): TextAnchor {
  return { type: 'text', page: t.page, quads: quadsForRange(t, lo, hi), quote: quoteForRange(t, lo, hi) };
}

/** True if the text is mostly not letters or digits, e.g. a formula (spec §7.5 hint). */
export function mostlySymbols(s: string): boolean {
  const chars = [...s].filter((c) => !/\s/.test(c));
  if (chars.length < 2) return false;
  const alnum = chars.filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  return alnum / chars.length < 0.5;
}

export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

export function rectContains(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad;
}
