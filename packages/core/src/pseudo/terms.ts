import { MarginError } from '../errors.ts';

// Term groups (spec §10.1): one group per line, `TOKEN: variant | variant | /regex/flags`.
// Variants are literal; `/…/` entries are regular expressions. `#` starts a comment line.

export interface TermGroup {
  /** Upper-case token, rendered as `[TOKEN]`. */
  token: string;
  /** Literal variants, or regular expressions written as `/source/flags`. */
  variants: string[];
  /** Text that replaces the token on restore (§10.5); default: the first literal variant. */
  restore?: string;
}

const TOKEN = /^[A-Z][A-Z0-9_]*$/;

export function isRegexVariant(v: string): boolean {
  return /^\/.+\/[a-z]*$/s.test(v);
}

/** The variant as a global, Unicode, case-insensitive RegExp (it runs on normalized text). */
export function variantRegExp(v: string): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(v);
  if (!m) throw new MarginError('terms-invalid', `Not a regular expression: ${v}`);
  const flags = new Set([...m[2]!.replace(/[gy]/g, ''), 'g', 'u', 'i']);
  return new RegExp(m[1]!, [...flags].sort().join(''));
}

/** Split a variant list on `|`, except inside `/regex/` entries. */
function splitVariants(s: string, line: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    let v: string;
    if (s[i] === '/') {
      let j = i + 1;
      while (j < s.length && s[j] !== '/') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) throw new MarginError('terms-invalid', `Line ${line}: unterminated regular expression.`, { path: `line ${line}` });
      j++;
      while (j < s.length && /[a-z]/.test(s[j]!)) j++;
      v = s.slice(i, j);
      if (!isRegexVariant(v)) throw new MarginError('terms-invalid', `Line ${line}: empty regular expression.`, { path: `line ${line}` });
      i = j;
      while (s[i] === ' ' || s[i] === '\t') i++;
      if (i < s.length && s[i] !== '|') throw new MarginError('terms-invalid', `Line ${line}: expected "|" after ${v}.`, { path: `line ${line}` });
    } else {
      const j = s.indexOf('|', i);
      v = (j < 0 ? s.slice(i) : s.slice(i, j)).trim();
      i = j < 0 ? s.length : j;
    }
    if (s[i] === '|') i++;
    if (v) out.push(v);
  }
  return out;
}

export function parseTerms(text: string): TermGroup[] {
  const groups: TermGroup[] = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = n + 1;
    const s = raw.trim();
    if (!s || s.startsWith('#')) return;
    const colon = s.indexOf(':');
    if (colon < 0) throw new MarginError('terms-invalid', `Line ${line}: expected "TOKEN: variant | variant".`, { path: `line ${line}` });
    const token = s.slice(0, colon).trim();
    if (!TOKEN.test(token)) throw new MarginError('terms-invalid', `Line ${line}: token "${token}" must be upper case letters, digits and _.`, { path: `line ${line}` });
    if (groups.some((g) => g.token === token)) throw new MarginError('terms-invalid', `Line ${line}: token ${token} is defined twice.`, { path: `line ${line}` });
    const variants = splitVariants(s.slice(colon + 1), line);
    if (variants.length === 0) throw new MarginError('terms-invalid', `Line ${line}: ${token} has no variants.`, { path: `line ${line}` });
    for (const v of variants) {
      if (!isRegexVariant(v)) continue;
      try {
        const re = variantRegExp(v);
        if (re.test('')) throw new Error('matches the empty string');
      } catch (e) {
        throw new MarginError('terms-invalid', `Line ${line}: bad regular expression ${v}: ${(e as Error).message}`, { path: `line ${line}` });
      }
    }
    groups.push({ token, variants });
  });
  return groups;
}

/** What a token is replaced with when annotations go back to the original (§10.5). */
export function restoreText(g: TermGroup): string {
  return g.restore ?? g.variants.find((v) => !isRegexVariant(v)) ?? `[${g.token}]`;
}
