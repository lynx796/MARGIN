// Text normalization for quote matching (spec §9.2): compatibility decomposition (expands
// ligatures), removal of combining marks, folding of typographic quotes and dashes, whitespace
// collapsed. In the "joined" variant, line-end hyphenation is removed ("exam-\nple" → "example");
// the other variant keeps the hyphen ("knowledge-\nbased" → "knowledge-based"). Matching tries both.

/** Spacing accents that old TeX encodings (OT1) typeset as separate glyphs next to the base letter. */
const SPACING_ACCENTS = new Set(['¨', '´', '`', 'ˆ', '˜', '¯', '˘', '˙', '˚', '˝', 'ˇ', '¸', '˛']);

const FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '−': '-',
  ' ': ' ',
};

export interface NormText {
  /** Normalized text. */
  text: string;
  /** For each code unit of `text`, the index of the source code unit it came from. */
  map: number[];
}

function foldChar(c: string): string {
  let t = c.normalize('NFKD').replace(/\p{M}/gu, '');
  t = Array.from(t, (ch) => FOLD[ch] ?? ch).join('');
  return t;
}

function isLetter(c: string | undefined): boolean {
  return c !== undefined && /\p{L}/u.test(c);
}

export function normalizeText(source: string, joinHyphens: boolean): NormText {
  const out: string[] = [];
  const map: number[] = [];
  const push = (s: string, i: number) => {
    for (const unit of s.split('')) {
      out.push(unit);
      map.push(i);
    }
  };
  let i = 0;
  while (i < source.length) {
    const cp = source.codePointAt(i)!;
    const c = String.fromCodePoint(cp);
    const len = c.length;
    if (c === '\n') {
      if (joinHyphens && out[out.length - 1] === '-' && isLetter(out[out.length - 2]) && isLetter(source[i + 1])) {
        out.pop();
        map.pop();
      } else if (out.length > 0 && out[out.length - 1] !== ' ') {
        push(' ', i);
      }
    } else if (/\s/u.test(c) || c === ' ') {
      if (out.length > 0 && out[out.length - 1] !== ' ') push(' ', i);
    } else if (SPACING_ACCENTS.has(c)) {
      // Dropped: matching is accent-insensitive, and OT1 accents are separate glyphs.
    } else {
      const t = foldChar(c);
      if (t.trim() === '' && t.length > 0) {
        if (out.length > 0 && out[out.length - 1] !== ' ') push(' ', i);
      } else {
        push(t, i);
      }
    }
    i += len;
  }
  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    map.pop();
  }
  return { text: out.join(''), map };
}

/** Normalize a quote, prefix or suffix typed by a human or agent. */
export function normalizeQuote(s: string): string {
  return normalizeText(s.trim(), true).text;
}

/** Normalize quote context (prefix/suffix), keeping a single leading/trailing space if present. */
export function normalizeContext(s: string): string {
  const core = normalizeQuote(s);
  if (core === '') return /\s/.test(s) ? ' ' : '';
  return (/^\s/.test(s) ? ' ' : '') + core + (/\s$/.test(s) ? ' ' : '');
}
