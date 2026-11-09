import { describe, expect, it } from 'vitest';
import { substituteTerms } from './match.ts';
import { parseTerms } from './terms.ts';

const groups = parseTerms(`AUTHOR_1: Anna Müller | Müller | Anna
AUTHOR_2: Jonas Keller | Keller
EMAIL: /[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/`);
const sub = (s: string) => substituteTerms(s, groups);

describe('term matching (§10.2)', () => {
  it('prefers the longest variant and matches whole words only', () => {
    expect(sub('Report by Anna Müller.')).toBe('Report by [AUTHOR_1].');
    expect(sub('Anna and Annabelle; Müllerei; Kellerman')).toBe('[AUTHOR_1] and Annabelle; Müllerei; Kellerman');
  });

  it('folds case, accents, OT1 accent glyphs and ligatures', () => {
    expect(sub('ANNA MÜLLER, anna muller, Anna M¨uller')).toBe('[AUTHOR_1], [AUTHOR_1], [AUTHOR_1]');
    expect(sub('Anna Müller')).toBe('[AUTHOR_1]');
    expect(substituteTerms('Prof. Ruﬃeux', parseTerms('S: Ruffieux'))).toBe('Prof. [S]');
  });

  it('keeps possessives and genitives next to the token', () => {
    expect(sub("Müller's and Müller’s lemma; Kellers Beweis")).toBe("[AUTHOR_1]'s and [AUTHOR_1]’s lemma; [AUTHOR_2]s Beweis");
  });

  it('joins names hyphenated across lines', () => {
    expect(sub('proved by Jonas Kel-\nler, is')).toBe('proved by [AUTHOR_2], is');
  });

  it('applies regular expressions as written', () => {
    expect(sub('Contact: anna.mueller@student.ethz.ch, now')).toBe('Contact: [EMAIL], now');
  });

  it('renders tokens as asked (file names have no brackets)', () => {
    expect(substituteTerms('Müller-thesis', groups, (t) => t)).toBe('AUTHOR_1-thesis');
  });
});
