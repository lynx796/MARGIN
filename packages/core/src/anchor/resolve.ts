import type { PageText } from '../pdf/extract.ts';
import type { Annotation, AnchorStatus, Rect, TextAnchor, TextQuote } from '../model/types.ts';
import { normalizeContext, normalizeQuote, normalizeText, type NormText } from './normalize.ts';

// Anchor resolution (spec §9.2): quote → quads by matching normalized text, and quads → quote by
// collecting the characters under the quads. Fuzzy matching arrives in phase 3; until then a quote
// that does not occur exactly (after normalization) is `unresolved`.

/** Length of stored quote prefix and suffix (spec §7.5). */
export const CONTEXT_LENGTH = 32;

export interface Match {
  page: number;
  /** Range [start, end) of code units in PageText.text. */
  start: number;
  end: number;
}

export interface Candidate {
  page: number;
  quads: Rect[];
  /** The matched text with some context, for error messages. */
  context: string;
}

export interface Resolution {
  status: AnchorStatus;
  page?: number;
  quads?: Rect[];
  quote?: TextQuote;
  /** All matches when ambiguous. */
  candidates: Candidate[];
}

/** Normalized views of one page, built lazily and cached by the caller via `PageIndex`. */
export class PageIndex {
  readonly page: PageText;
  readonly joined: NormText;
  readonly kept: NormText;

  constructor(page: PageText) {
    this.page = page;
    this.joined = normalizeText(page.text, true);
    this.kept = normalizeText(page.text, false);
  }

  /** All occurrences of an already normalized needle, as source ranges, sorted and deduplicated. */
  find(needle: string): Match[] {
    const seen = new Set<string>();
    const out: Match[] = [];
    if (needle.length === 0) return out;
    for (const view of [this.joined, this.kept]) {
      let from = 0;
      for (;;) {
        const at = view.text.indexOf(needle, from);
        if (at < 0) break;
        const start = view.map[at]!;
        const last = view.map[at + needle.length - 1]!;
        const end = last + codeUnitLength(this.page.text, last);
        const key = `${start}:${end}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ page: this.page.page, start, end });
        }
        from = at + 1;
      }
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    // Drop matches nested in another match (same text found via both views with different extents).
    return out.filter((m, i) => !out.some((o, j) => j !== i && o.start <= m.start && o.end >= m.end && (o.start !== m.start || o.end !== m.end)));
  }
}

function codeUnitLength(s: string, i: number): number {
  const cp = s.codePointAt(i);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** One quad per line fragment covered by the source range. */
export function quadsForRange(page: PageText, start: number, end: number): Rect[] {
  const byLine = new Map<number, [number, number]>();
  for (let i = start; i < end; i++) {
    const c = page.text[i]!;
    if (c === '\n' || c === ' ') continue;
    const line = page.lineOf[i]!;
    const box = page.boxes[i]!;
    const cur = byLine.get(line);
    byLine.set(line, cur ? [Math.min(cur[0], box[0]), Math.max(cur[1], box[2])] : [box[0], box[2]]);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, [x0, x1]]) => {
      const lb = page.lines[line]!.box;
      return [round2(x0), lb[1], round2(x1), lb[3]] as Rect;
    });
}

/** Collapse whitespace and join line-end hyphenation ("interme-\ndiate" → "intermediate"). */
function collapse(s: string): string {
  return s.replace(/(\p{L})-\n(?=\p{L})/gu, '$1').replace(/\s+/g, ' ');
}

/** Quote with 32-character context for a source range (spec §7.5). */
export function quoteForRange(page: PageText, start: number, end: number): TextQuote {
  const exact = collapse(page.text.slice(start, end)).trim();
  const before = collapse(page.text.slice(0, start));
  const after = collapse(page.text.slice(end));
  return { exact, prefix: before.slice(-CONTEXT_LENGTH), suffix: after.slice(0, CONTEXT_LENGTH) };
}

/** Source range of characters whose centers lie inside any of the quads. */
export function rangeForQuads(page: PageText, quads: Rect[]): [number, number] | null {
  let lo = -1;
  let hi = -1;
  page.boxes.forEach((b, i) => {
    const c = page.text[i]!;
    if (c === '\n' || c === ' ') return;
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    if (quads.some((q) => cx >= q[0] - 0.5 && cx <= q[2] + 0.5 && cy >= q[1] - 0.5 && cy <= q[3] + 0.5)) {
      if (lo < 0) lo = i;
      hi = i + 1;
    }
  });
  return lo < 0 ? null : [lo, hi];
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function contextFor(page: PageText, m: Match): string {
  const s = Math.max(0, m.start - 20);
  const e = Math.min(page.text.length, m.end + 20);
  return collapse((s > 0 ? '…' : '') + page.text.slice(s, m.start) + '[' + page.text.slice(m.start, m.end) + ']' + page.text.slice(m.end, e) + (e < page.text.length ? '…' : ''));
}

/**
 * Find the source range of a quote. `pages` must contain the page index for `page` if given,
 * else all pages of the document.
 */
export function findQuote(quote: TextQuote, indexes: PageIndex[], page?: number): { status: AnchorStatus; match?: Match; matches: Match[] } {
  const needle = normalizeQuote(quote.exact);
  const scope = page === undefined ? indexes : indexes.filter((x) => x.page.page === page);
  const matches = scope.flatMap((x) => x.find(needle));
  if (matches.length === 1) return { status: 'ok', match: matches[0]!, matches };
  if (matches.length === 0) return { status: 'unresolved', matches };
  // Disambiguate by prefix/suffix similarity.
  const prefix = quote.prefix ? normalizeContext(quote.prefix) : '';
  const suffix = quote.suffix ? normalizeContext(quote.suffix) : '';
  if (!prefix && !suffix) return { status: 'ambiguous', matches };
  const scored = matches.map((m) => {
    const idx = indexes.find((x) => x.page.page === m.page)!;
    const before = normalizeText(idx.page.text.slice(Math.max(0, m.start - 4 * CONTEXT_LENGTH), m.start), true).text;
    const after = normalizeText(idx.page.text.slice(m.end, m.end + 4 * CONTEXT_LENGTH), true).text;
    // Normalization trims; restore the separating space if the source had one.
    const b = /\s$/.test(idx.page.text.slice(0, m.start)) ? before + ' ' : before;
    const a = /^\s/.test(idx.page.text.slice(m.end)) ? ' ' + after : after;
    return { m, score: commonSuffix(b, prefix) + commonPrefix(a, suffix) };
  });
  scored.sort((x, y) => y.score - x.score);
  if (scored[0]!.score > 0 && scored[0]!.score > scored[1]!.score) return { status: 'ok', match: scored[0]!.m, matches };
  return { status: 'ambiguous', matches };
}

/**
 * Resolve one text anchor against the document text: fill missing quads from the quote and a
 * missing quote from the quads (spec §9.1 `margin resolve`).
 */
export function resolveTextAnchor(anchor: TextAnchor, indexes: PageIndex[]): Resolution {
  if (anchor.quads && anchor.quads.length > 0 && anchor.page !== undefined) {
    const idx = indexes.find((x) => x.page.page === anchor.page);
    if (anchor.quote || !idx) return { status: idx ? 'ok' : 'unresolved', page: anchor.page, quads: anchor.quads, ...(anchor.quote ? { quote: anchor.quote } : {}), candidates: [] };
    const range = rangeForQuads(idx.page, anchor.quads);
    if (!range) return { status: 'unresolved', page: anchor.page, quads: anchor.quads, candidates: [] };
    return { status: 'ok', page: anchor.page, quads: anchor.quads, quote: quoteForRange(idx.page, range[0], range[1]), candidates: [] };
  }
  if (!anchor.quote) return { status: 'unresolved', candidates: [] };
  const found = findQuote(anchor.quote, indexes, anchor.page);
  const candidates = found.matches.map((m) => {
    const idx = indexes.find((x) => x.page.page === m.page)!;
    return { page: m.page, quads: quadsForRange(idx.page, m.start, m.end), context: contextFor(idx.page, m) };
  });
  if (found.status !== 'ok' || !found.match) return { status: found.status, candidates };
  const m = found.match;
  const idx = indexes.find((x) => x.page.page === m.page)!;
  const derived = quoteForRange(idx.page, m.start, m.end);
  // Keep the caller's exact text but complete missing context from the document.
  const quote: TextQuote = { ...anchor.quote, prefix: anchor.quote.prefix ?? derived.prefix, suffix: anchor.quote.suffix ?? derived.suffix };
  return { status: 'ok', page: m.page, quads: quadsForRange(idx.page, m.start, m.end), quote, candidates };
}

/** Resolve an annotation in place; returns the resolution for reporting. */
export function resolveAnnotation(a: Annotation, indexes: PageIndex[], pageCount: number): Resolution {
  if (a.anchor.type === 'region') {
    const ok = a.anchor.page >= 1 && a.anchor.page <= pageCount;
    a.status = ok ? 'ok' : 'unresolved';
    return { status: a.status, page: a.anchor.page, candidates: [] };
  }
  const r = resolveTextAnchor(a.anchor, indexes);
  if (r.page !== undefined) a.anchor.page = r.page;
  if (r.quads) a.anchor.quads = r.quads;
  if (r.quote) a.anchor.quote = r.quote;
  a.status = r.status;
  return r;
}
