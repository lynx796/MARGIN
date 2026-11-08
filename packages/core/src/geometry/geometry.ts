import type { Bitmap } from '../pdf/document.ts';
import type { PageSize, Rect, Settings } from '../model/types.ts';

// Page geometry (spec §5): crop to the horizontal ink extent, enlarge every page uniformly by one
// factor k ≤ k_max, scale content down by s only if the cap is reached, and place a comment
// column in each margin.

/** Padding p added on both sides of the ink extent, pt (§5.1). */
export const CROP_PADDING = 8;
/** Outer page margin g_out, pt (§5.3). */
export const OUTER_MARGIN = 18;
/** Resolution used to find the ink extent (§5.1). */
export const INK_DPI = 36;
/** A pixel counts as ink if any channel is darker than this. */
const INK_THRESHOLD = 240;

/** Horizontal ink extent [x0, x1] of a page rendered on white at INK_DPI, in pt; null if blank. */
export function inkExtent(bitmap: Bitmap, dpi = INK_DPI): [number, number] | null {
  const { width, height, data } = bitmap;
  let lo = width;
  let hi = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      if (data[i + 3]! > 0 && (data[i]! < INK_THRESHOLD || data[i + 1]! < INK_THRESHOLD || data[i + 2]! < INK_THRESHOLD)) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
  }
  if (hi < 0) return null;
  const pt = 72 / dpi;
  return [lo * pt, (hi + 1) * pt];
}

export interface Column {
  side: 'left' | 'right';
  /** Horizontal extent of comment boxes, output pt. */
  x0: number;
  x1: number;
  /** Text-block edge e the leaders start from (§6.6), output pt. */
  edge: number;
}

export interface PageGeometry {
  page: number;
  /** Original page size W × H, pt. */
  width: number;
  height: number;
  /** Enlargement factor; the output page is kW × kH. */
  k: number;
  /** Content scale. */
  s: number;
  outWidth: number;
  outHeight: number;
  /** Offsets of the transform T (§5.4). */
  ox: number;
  oy: number;
  /** Crop: left ink edge x₀ in original pt, padding p, padded content width t. */
  cropX0: number;
  padding: number;
  t: number;
  /** Vertical extent [T, B] available to comment columns, output pt. */
  top: number;
  bottom: number;
  left: Column;
  right: Column;
}

export interface DocGeometry {
  /** Horizontal crop [x₀, x₁] in original pt (ink extent, before padding). */
  crop: [number, number];
  s: number;
  pages: PageGeometry[];
}

/**
 * Compute output geometry for all pages (§5.2–5.3).
 * @param inks per-page ink extents (null for blank pages); ignored when `settings.crop` is set
 */
export function computeGeometry(pages: PageSize[], inks: ([number, number] | null)[], settings: Pick<Settings, 'marginWidth' | 'maxEnlargement' | 'crop'>): DocGeometry {
  const maxW = Math.max(...pages.map((p) => p.width));
  let x0: number;
  let x1: number;
  if (settings.crop) {
    [x0, x1] = settings.crop;
  } else {
    const found = inks.filter((e): e is [number, number] => e !== null);
    x0 = found.length ? Math.min(...found.map((e) => e[0])) : 0;
    x1 = found.length ? Math.max(...found.map((e) => e[1])) : maxW;
  }
  x0 = Math.max(0, x0);
  x1 = Math.min(maxW, Math.max(x1, x0 + 1));
  const p = CROP_PADDING;
  const t = x1 - x0 + 2 * p;
  const m = settings.marginWidth;
  const kMax = settings.maxEnlargement;
  // k and s from the largest page width, so all output pages are consistent; k applies per page.
  const k = Math.min(kMax, Math.max(1, (t + 2 * m) / maxW));
  const s = Math.min(1, (k * maxW - 2 * m) / t);
  const wMax = 1.3 * m;

  const out = pages.map((size, i): PageGeometry => {
    const W = size.width;
    const H = size.height;
    const outWidth = k * W;
    const outHeight = k * H;
    const ox = (outWidth - s * t) / 2;
    const oy = (outHeight - s * H) / 2;
    const avail = (outWidth - s * t) / 2 - OUTER_MARGIN;
    const wCol = Math.max(0, Math.min(wMax, avail));
    const textLeft = ox + s * p;
    const textRight = ox + s * (t - p);
    return {
      page: i + 1,
      width: W,
      height: H,
      k,
      s,
      outWidth,
      outHeight,
      ox,
      oy,
      cropX0: x0,
      padding: p,
      t,
      top: OUTER_MARGIN,
      bottom: outHeight - OUTER_MARGIN,
      left: { side: 'left', x0: OUTER_MARGIN, x1: OUTER_MARGIN + wCol, edge: textLeft },
      right: { side: 'right', x0: outWidth - OUTER_MARGIN - wCol, x1: outWidth - OUTER_MARGIN, edge: textRight },
    };
  });
  return { crop: [x0, x1], s, pages: out };
}

/** T: original-page point → output-page point (§5.4). */
export function toOutput(g: PageGeometry, x: number, y: number): [number, number] {
  return [g.ox + g.s * (x - g.cropX0 + g.padding), g.oy + g.s * y];
}

export function toOutputRect(g: PageGeometry, r: Rect): Rect {
  const [a, b] = toOutput(g, r[0], r[1]);
  const [c, d] = toOutput(g, r[2], r[3]);
  return [a, b, c, d];
}

/** Inverse of T, for hit testing in the UI. */
export function toOriginal(g: PageGeometry, x: number, y: number): [number, number] {
  return [(x - g.ox) / g.s + g.cropX0 - g.padding, (y - g.oy) / g.s];
}

/** The original-page rectangle shown on the output page: the crop box (§8.1). */
export function visibleRect(g: PageGeometry): Rect {
  return [g.cropX0 - g.padding, 0, g.cropX0 - g.padding + g.t, g.height];
}
