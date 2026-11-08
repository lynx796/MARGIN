// The display list (spec §3): the contract between layout and rendering. A flat array of
// primitives in output-page coordinates (pt, origin top-left, y down), each tagged with the ID of
// the annotation that produced it. The web overlay renders it as SVG; render-pdf writes PDF operators.
// Paint order is array order within each layer.

/** `#rrggbb` */
export type Color = string;

export type FontKey = 'sans' | 'sans-italic' | 'sans-bold' | 'sans-bolditalic' | 'mono';

/** Highlights are painted beneath the page content with multiply blending; everything else above. */
export type Layer = 'under' | 'over';

interface PrimBase {
  /** Annotation that produced the primitive. */
  id: string;
  layer: Layer;
}

export interface RectPrim extends PrimBase {
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: Color;
  fillOpacity?: number;
  stroke?: Color;
  strokeWidth?: number;
  /** Stroke dash pattern, pt. */
  dash?: number[];
  radius?: number;
  blend?: 'multiply';
}

export interface PathPrim extends PrimBase {
  type: 'path';
  /** SVG path data with absolute M, L, C, Z commands in output coordinates. */
  d: string;
  stroke: Color;
  strokeWidth: number;
  dash?: number[];
  lineCap?: 'butt' | 'round';
}

export interface GlyphRunPrim extends PrimBase {
  type: 'glyphRun';
  font: FontKey;
  size: number;
  color: Color;
  /** Baseline origin of the first glyph. */
  x: number;
  y: number;
  text: string;
  /** Advance of each code point of `text` in pt, including kerning. */
  advances: number[];
}

export interface SvgPrim extends PrimBase {
  type: 'svg';
  /** Baseline-left origin of the math box. */
  x: number;
  y: number;
  /** Output pt per path unit. */
  scale: number;
  /** SVG path data, absolute M, L, Q, C, Z; units of 1/1000 em, y down, baseline at y = 0. */
  paths: string[];
  color: Color;
}

export type Prim = RectPrim | PathPrim | GlyphRunPrim | SvgPrim;

export interface PageLayout {
  page: number;
  width: number;
  height: number;
  /** Font size used for comments on this page (may be stepped down on overflow). */
  fontSize: number;
  /** Comments that did not fit their column even after reassignment. */
  overflow: string[];
  prims: Prim[];
}

export interface Layout {
  pages: PageLayout[];
  /** Display numbers by annotation ID (comments only, 1…N in reading order). */
  numbers: Record<string, number>;
}
