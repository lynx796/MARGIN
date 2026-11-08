// Annotation file data model (spec §4).
//
// Coordinates are PDF points in the *original* page, origin at the top-left of the CropBox, y down.
// Pages are 1-based. Every object may carry unknown fields (including agent `x-*` metadata); they are
// preserved on load and save, which is why the interfaces have index signatures.

export const FORMAT = 'margin-annot';
export const FORMAT_VERSION = 1;

/** Axis-aligned rectangle `[x0, y0, x1, y1]` with x0 ≤ x1, y0 ≤ y1. */
export type Rect = [number, number, number, number];

export interface PageSize {
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface DocumentInfo {
  fileName: string;
  sha256: string;
  pageCount: number;
  pages: PageSize[];
  [key: string]: unknown;
}

export type CategoryKind = 'comment' | 'highlight';

export interface Category {
  id: string;
  name: string;
  /** `#rrggbb` */
  color: string;
  kind: CategoryKind;
  /** Placement weight in the layout objective (§6.5). */
  weight: number;
  [key: string]: unknown;
}

export type LeaderStyle = 'full' | 'gutter';

export interface Settings {
  /** Target margin width per side, pt (§5.2). */
  marginWidth: number;
  /** Cap k_max on the page enlargement factor (§5.2). */
  maxEnlargement: number;
  /** Comment font size, pt (§6.2). */
  fontSize: number;
  leaderStyle: LeaderStyle;
  /** Attach the original PDF to exports (§8.2). */
  embedOriginal: boolean;
  /** Manual horizontal crop `[x0, x1]` in original-page points; overrides ink detection (§5.1). */
  crop?: [number, number];
  [key: string]: unknown;
}

export interface TextQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
  [key: string]: unknown;
}

export interface TextAnchor {
  type: 'text';
  /** Optional on input if the quote is unique in the document; always set after resolution. */
  page?: number;
  /** One rectangle per line fragment. */
  quads?: Rect[];
  quote?: TextQuote;
  [key: string]: unknown;
}

export interface RegionAnchor {
  type: 'region';
  page: number;
  rect: Rect;
  [key: string]: unknown;
}

export type Anchor = TextAnchor | RegionAnchor;

export type Side = 'auto' | 'left' | 'right';
export type Origin = 'human' | 'agent';
export type AnchorStatus = 'ok' | 'unresolved' | 'ambiguous';

export interface Annotation {
  id: string;
  category: string;
  anchor: Anchor;
  /** Comment markup source (§6.1). Empty for highlight categories. */
  body: string;
  side: Side;
  origin: Origin;
  /** Set when a human accepted an agent comment (§9.4). */
  reviewed?: boolean;
  /** Written by the resolver. */
  status?: AnchorStatus;
  /** ISO 8601, seconds precision, UTC. */
  created: string;
  modified: string;
  [key: string]: unknown;
}

export interface ReportRef {
  fileName: string;
  sha256: string;
  position: 'before' | 'after';
  [key: string]: unknown;
}

export interface AnnotFile {
  format: typeof FORMAT;
  version: number;
  document: DocumentInfo;
  categories: Category[];
  settings: Settings;
  annotations: Annotation[];
  report?: ReportRef;
  [key: string]: unknown;
}
