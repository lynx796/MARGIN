import { normalizeQuote, normalizeText, type NormText } from '../anchor/normalize.ts';
import { quadsForRange } from '../anchor/resolve.ts';
import type { Rect } from '../model/types.ts';
import type { PageText } from '../pdf/extract.ts';
import { isRegexVariant, variantRegExp, type TermGroup } from './terms.ts';

// Term matching (spec §10.2) on the core's extracted text: the normalization of §9.2 (ligatures
// expanded, accents and OT1 accent glyphs dropped, hyphenation across lines joined) plus case
// folding. Literal variants match whole words; a possessive or genitive ending may follow
// ("Müller's", "Müllers"). Regular expressions match as written, case-insensitively.

export interface TermMatch {
  page: number;
  token: string;
  /** Source range [start, end) in the page text. */
  start: number;
  end: number;
  /** The matched text as it appears on the page. */
  text: string;
  /** One rectangle per line fragment, original-page coordinates. */
  quads: Rect[];
  /** False if all its characters lie outside the clipping region (removed, but never visible). */
  visible: boolean;
}

const WORD = /[\p{L}\p{N}]/u;

interface Range {
  start: number;
  end: number;
  token: string;
}

function codeUnitLength(s: string, i: number): number {
  const cp = s.codePointAt(i);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
}

/** A literal match must not be part of a longer word; a trailing genitive `s` is allowed. */
function wholeWord(view: string, at: number, len: number): boolean {
  if (at > 0 && WORD.test(view[at - 1]!)) return false;
  const next = view[at + len];
  if (next === undefined || !WORD.test(next)) return true;
  return (next === 's' || next === 'S') && !WORD.test(view[at + len + 1] ?? ' ');
}

function rangesIn(src: string, view: NormText, groups: TermGroup[], out: Range[]): void {
  const lowered = view.text.toLowerCase();
  const text = lowered.length === view.text.length ? lowered : view.text;
  const add = (at: number, len: number, token: string) => {
    if (len === 0) return;
    const start = view.map[at]!;
    const last = view.map[at + len - 1]!;
    out.push({ start, end: last + codeUnitLength(src, last), token });
  };
  for (const g of groups) {
    for (const v of g.variants) {
      if (isRegexVariant(v)) {
        for (const m of view.text.matchAll(variantRegExp(v))) add(m.index!, m[0].length, g.token);
        continue;
      }
      const needle = normalizeQuote(v).toLowerCase();
      if (!needle) continue;
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
        if (wholeWord(text, at, needle.length)) add(at, needle.length, g.token);
      }
    }
  }
}

/** Non-overlapping matches of all groups in `src`, longest first, then sorted by position. */
export function matchRanges(src: string, groups: TermGroup[]): Range[] {
  const all: Range[] = [];
  rangesIn(src, normalizeText(src, true), groups, all);
  rangesIn(src, normalizeText(src, false), groups, all);
  all.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  const kept: Range[] = [];
  for (const r of all) if (!kept.some((k) => r.start < k.end && k.start < r.end)) kept.push(r);
  return kept.sort((a, b) => a.start - b.start);
}

/** Every occurrence of every term on the given pages. */
export function findTerms(texts: PageText[], groups: TermGroup[]): TermMatch[] {
  const out: TermMatch[] = [];
  for (const page of texts) {
    for (const r of matchRanges(page.text, groups)) {
      out.push({ page: page.page, token: r.token, start: r.start, end: r.end, text: page.text.slice(r.start, r.end), quads: quadsForRange(page, r.start, r.end), visible: !page.hidden || page.hidden.slice(r.start, r.end).some((h) => !h) });
    }
  }
  return out;
}

export function tokenText(token: string): string {
  return `[${token}]`;
}

/** Replace every term in a string (titles, outline entries, comment bodies, quotes, file names). */
export function substituteTerms(s: string, groups: TermGroup[], render: (token: string) => string = tokenText): string {
  let out = s;
  for (const r of matchRanges(s, groups).reverse()) out = out.slice(0, r.start) + render(r.token) + out.slice(r.end);
  return out;
}
