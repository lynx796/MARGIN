import type { PageText } from '../pdf/extract.ts';
import type { Annotation, AnchorStatus, Rect, TextAnchor, TextQuote } from '../model/types.ts';
import { normalizeContext, normalizeQuote, normalizeText, type NormText } from './normalize.ts';

// Anchor resolution (spec §9.2): quote → quads by matching normalized text, and quads → quote by
// collecting the characters under the quads. A quote that does not occur exactly (after
// normalization) is matched fuzzily: normalized edit distance ≤ FUZZY_MAX, accepted only if unique.

/** Largest accepted edit distance relative to the quote length (spec §9.2). */
export const FUZZY_MAX = 0.1;

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

  /**
   * All occurrences of an already normalized needle, as source ranges, sorted and deduplicated.
   * With `ignoreCase` the needle must be lower case (used by search, not by anchoring).
   */
  find(needle: string, options: { ignoreCase?: boolean } = {}): Match[] {
    const seen = new Set<string>();
    const out: Match[] = [];
    if (needle.length === 0) return out;
    for (const view of [this.joined, this.kept]) {
      let from = 0;
      // Lower-casing keeps the index map valid only if it does not change the length.
      const lowered = options.ignoreCase ? view.text.toLowerCase() : view.text;
      const haystack = lowered.length === view.text.length ? lowered : view.text;
      for (;;) {
        const at = haystack.indexOf(needle, from);
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

  /**
   * Approximate occurrences of an already normalized needle: non-overlapping ranges whose edit
   * distance to the needle is at most `maxRate` × needle length, best first within each region.
   */
  findFuzzy(needle: string, maxRate = FUZZY_MAX): Match[] {
    const budget = Math.floor(needle.length * maxRate);
    if (budget < 1) return [];
    const found: (Match & { dist: number })[] = [];
    for (const view of [this.joined, this.kept]) {
      for (const h of approximate(view.text, needle, budget)) {
        // Edits at the edges often cut a word in two; quotes are whole words, so extend to the boundary.
        const word = /[\p{L}\p{N}]/u;
        let [s, e] = [h.start, h.end];
        if (word.test(needle[0]!)) while (s > 0 && word.test(view.text[s - 1]!) && word.test(view.text[s]!)) s--;
        if (word.test(needle[needle.length - 1]!)) while (e < view.text.length && word.test(view.text[e]!) && word.test(view.text[e - 1]!)) e++;
        const start = view.map[s]!;
        const last = view.map[e - 1]!;
        found.push({ page: this.page.page, start, end: last + codeUnitLength(this.page.text, last), dist: h.dist });
      }
    }
    // Best first; drop candidates overlapping a better one (both views often find the same place).
    found.sort((a, b) => a.dist - b.dist || a.start - b.start);
    const kept: (Match & { dist: number })[] = [];
    for (const f of found) if (!kept.some((k) => f.start < k.end && k.start < f.end)) kept.push(f);
    return kept.sort((a, b) => a.start - b.start).map(({ page, start, end }) => ({ page, start, end }));
  }
}

/**
 * Sellers' approximate substring matching: ranges [start, end) of `text` within `budget` edits of
 * `needle`, one per region (the cheapest, then the one closest in length to the needle).
 */
function approximate(text: string, needle: string, budget: number): { start: number; end: number; dist: number }[] {
  const m = needle.length;
  let dist = new Array<number>(m + 1);
  let from = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) {
    dist[i] = i;
    from[i] = 0;
  }
  const hits: { start: number; end: number; dist: number }[] = [];
  for (let j = 1; j <= text.length; j++) {
    const nd = new Array<number>(m + 1);
    const nf = new Array<number>(m + 1);
    nd[0] = 0;
    nf[0] = j;
    for (let i = 1; i <= m; i++) {
      const sub = dist[i - 1]! + (needle[i - 1] === text[j - 1] ? 0 : 1);
      const del = dist[i]! + 1;
      const ins = nd[i - 1]! + 1;
      if (sub <= del && sub <= ins) {
        nd[i] = sub;
        nf[i] = from[i - 1]!;
      } else if (del <= ins) {
        nd[i] = del;
        nf[i] = from[i]!;
      } else {
        nd[i] = ins;
        nf[i] = nf[i - 1]!;
      }
    }
    if (nd[m]! <= budget) hits.push({ start: nf[m]!, end: j, dist: nd[m]! });
    dist = nd;
    from = nf;
  }
  hits.sort((a, b) => a.dist - b.dist || Math.abs(a.end - a.start - m) - Math.abs(b.end - b.start - m) || a.start - b.start);
  const kept: typeof hits = [];
  for (const h of hits) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  return kept;
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

/** Source range of visible characters whose centers lie inside any of the quads (clipped-away text never counts). */
export function rangeForQuads(page: PageText, quads: Rect[]): [number, number] | null {
  let lo = -1;
  let hi = -1;
  page.boxes.forEach((b, i) => {
    const c = page.text[i]!;
    if (c === '\n' || c === ' ' || page.hidden?.[i]) return;
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
export function findQuote(quote: TextQuote, indexes: PageIndex[], page?: number): { status: AnchorStatus; match?: Match; matches: Match[]; fuzzy: boolean } {
  const needle = normalizeQuote(quote.exact);
  const scope = page === undefined ? indexes : indexes.filter((x) => x.page.page === page);
  let matches = scope.flatMap((x) => x.find(needle));
  let fuzzy = false;
  if (matches.length === 0) {
    matches = scope.flatMap((x) => x.findFuzzy(needle));
    fuzzy = matches.length > 0;
  }
  if (matches.length === 1) return { status: 'ok', match: matches[0]!, matches, fuzzy };
  if (matches.length === 0) return { status: 'unresolved', matches, fuzzy };
  // Disambiguate by prefix/suffix similarity.
  const prefix = quote.prefix ? normalizeContext(quote.prefix) : '';
  const suffix = quote.suffix ? normalizeContext(quote.suffix) : '';
  if (!prefix && !suffix) return { status: 'ambiguous', matches, fuzzy };
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
  if (scored[0]!.score > 0 && scored[0]!.score > scored[1]!.score) return { status: 'ok', match: scored[0]!.m, matches, fuzzy };
  return { status: 'ambiguous', matches, fuzzy };
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
  // Keep the caller's exact text but complete missing context from the document; a fuzzy match
  // replaces it by what the document really says, so the next resolution is exact.
  const quote: TextQuote = found.fuzzy
    ? { ...anchor.quote, exact: derived.exact, prefix: derived.prefix, suffix: derived.suffix }
    : { ...anchor.quote, prefix: anchor.quote.prefix ?? derived.prefix, suffix: anchor.quote.suffix ?? derived.suffix };
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
