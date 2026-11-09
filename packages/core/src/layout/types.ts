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
  /** What the primitive is part of, so a front-end can hide a comment's box while editing it. */
  role?: 'mark' | 'leader' | 'box';
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

/** Geometry of one annotation on a page, for hit testing and editor placement (not painted). */
export interface PageItem {
  id: string;
  /** Margin the comment box sits in; absent for highlights. */
  side?: 'left' | 'right';
  /** Comment box `[x, y, w, h]` in output coordinates; absent for highlights. */
  box?: [number, number, number, number];
  /** True when the comment was spilled to a notes page; `box` is then its small margin tag. */
  spilled?: true;
  /** Anchor rectangles in output coordinates: one per line fragment, or the region rectangle. */
  anchor: [number, number, number, number][];
}

export interface PageLayout {
  page: number;
  width: number;
  height: number;
  /** Font size used for comments on this page (may be stepped down on overflow). */
  fontSize: number;
  /** Comments spilled to notes pages after the font step-down was exhausted (§6.7). */
  overflow: string[];
  /** One entry per placed annotation, sorted by id. */
  items: PageItem[];
  prims: Prim[];
  /** Cross-references (`\ref`) in comment boxes: clickable areas pointing at another comment. */
  links?: LinkRect[];
  /** Notes pages inserted directly after this page for spilled comments. */
  notes?: NotesPage[];
}

/** A clickable area `[x, y, w, h]` in output coordinates that jumps to comment `target`. */
export interface LinkRect {
  rect: [number, number, number, number];
  target: string;
}

/** An extra page of the same size as its source page holding the bodies of spilled comments. */
export interface NotesPage {
  width: number;
  height: number;
  /** Placed note boxes, for link targets. */
  items: { id: string; box: [number, number, number, number] }[];
  prims: Prim[];
  links?: LinkRect[];
}

export interface Layout {
  pages: PageLayout[];
  /** Display numbers by annotation ID (comments only, 1…N in reading order). */
  numbers: Record<string, number>;
}
