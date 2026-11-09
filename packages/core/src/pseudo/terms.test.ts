import { describe, expect, it } from 'vitest';
import { MarginError } from '../errors.ts';
import { parseTerms, restoreText, variantRegExp } from './terms.ts';

describe('parseTerms', () => {
  it('reads groups, literal variants and regexes (which may contain |)', () => {
    const groups = parseTerms(`# comment
AUTHOR_1: Anna Müller | A. Müller | Müller | Anna

EMAIL: /[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/
ID: /\\b(?:\\d{2}-\\d{3}-\\d{3}|S\\d{6})\\b/ | Matrikel 123
`);
    expect(groups.map((g) => g.token)).toEqual(['AUTHOR_1', 'EMAIL', 'ID']);
    expect(groups[0]!.variants).toEqual(['Anna Müller', 'A. Müller', 'Müller', 'Anna']);
    expect(groups[2]!.variants).toEqual(['/\\b(?:\\d{2}-\\d{3}-\\d{3}|S\\d{6})\\b/', 'Matrikel 123']);
    expect('see 12-345-678 or S123456'.match(variantRegExp(groups[2]!.variants[0]!))).toEqual(['12-345-678', 'S123456']);
  });

  it('rejects malformed lines with the line number', () => {
    const bad = ['no colon here', 'lower: x', 'A: ', 'A: /unterminated', 'A: /(/', 'A: //', 'A: x\nA: y', 'A: /x/ y'];
    for (const t of bad) {
      expect(() => parseTerms(t), t).toThrow(MarginError);
    }
    expect(() => parseTerms('A: x\nb: y')).toThrow(/Line 2/);
  });

  it('restores to the configured text, else the first literal variant', () => {
    expect(restoreText({ token: 'A', variants: ['/x/', 'Anna Müller', 'Anna'] })).toBe('Anna Müller');
    expect(restoreText({ token: 'A', variants: ['Anna Müller'], restore: 'Anna' })).toBe('Anna');
    expect(restoreText({ token: 'E', variants: ['/x/'] })).toBe('[E]');
  });
});
