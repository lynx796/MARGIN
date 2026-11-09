import { beforeAll, describe, expect, it } from 'vitest';
import { fixturePdf } from '../test/fixtures.ts';
import type { PdfDoc } from '../pdf/document.ts';
import { baselineOf } from '../pdf/extract.ts';
import { normalizeQuote, normalizeText } from './normalize.ts';
import { findQuote, PageIndex, quoteForRange, rangeForQuads, resolveTextAnchor } from './resolve.ts';

let doc: PdfDoc;
let indexes: PageIndex[];

beforeAll(async () => {
  doc = await fixturePdf('plain');
  indexes = (await doc.allText()).map((t) => new PageIndex(t));
});

describe('normalize', () => {
  it('expands ligatures, strips accents, folds quotes and dashes, collapses whitespace', () => {
    expect(normalizeQuote('  eﬃcient  ﬁxed\tpoints ')).toBe('efficient fixed points');
    expect(normalizeQuote('Müller’s')).toBe("Muller's");
    expect(normalizeQuote('Müller – 1')).toBe('Muller - 1');
  });

  it('joins line-end hyphenation only in the joined variant, keeping the index map', () => {
    const src = 'inter-\nnational knowledge-\nbased';
    const joined = normalizeText(src, true);
    expect(joined.text).toBe('international knowledgebased');
    expect(src[joined.map[joined.text.indexOf('national')]!]).toBe('n');
    expect(normalizeText(src, false).text).toBe('inter- national knowledge- based');
  });
});

describe('extraction', () => {
  it('reports page sizes and a hash', () => {
    expect(doc.pageCount).toBe(2);
    expect(doc.pages[0]).toEqual({ width: 595.28, height: 841.89 });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('extracts words, spaces and lines in reading order', async () => {
    const t = await doc.text(1);
    expect(t.text).toContain('The map f is continuous on the closed interval');
    expect(t.text.length).toBe(t.boxes.length);
    expect(t.text.length).toBe(t.lineOf.length);
    for (let i = 1; i < t.lines.length; i++) expect(t.lines[i]!.start).toBeGreaterThan(t.lines[i - 1]!.start);
  });

  it('gives character boxes that advance left to right on a line', async () => {
    const t = await doc.text(1);
    const i = t.text.indexOf('continuous');
    for (let k = i; k < i + 9; k++) {
      // Adjacent within a word, up to TeX's kerning.
      expect(Math.abs(t.boxes[k + 1]![0] - t.boxes[k]![2])).toBeLessThan(0.5);
      expect(t.boxes[k]![1]).toBe(t.boxes[i]![1]);
    }
    const line = t.lines[t.lineOf[i]!]!;
    expect(baselineOf(line.box)).toBeCloseTo(line.baseline, 1);
  });
});

describe('quote anchoring', () => {
  it('resolves a unique quote on a given page to one quad', () => {
    const r = resolveTextAnchor({ type: 'text', page: 1, quote: { exact: 'differentiable on its' } }, indexes);
    expect(r.status).toBe('ok');
    expect(r.quads).toHaveLength(1);
    expect(r.quote?.prefix?.length).toBe(32);
  });

  it('finds quotes across ligatures, umlauts and curly apostrophes', () => {
    for (const exact of ['efficient computation', 'affine case', 'fluffy notion', "Muller's earlier", 'Müller’s earlier']) {
      expect(findQuote({ exact }, indexes).status, exact).toBe('ok');
    }
  });

  it('finds hyphenated words split across lines, with one quad per line', () => {
    const t = indexes[0]!.page;
    const hyphenated = ['incomprehensibilities', 'characteristically', 'internationalization', 'extraordinarily', 'considerably'].filter((w) => !t.text.includes(w));
    expect(hyphenated.length).toBeGreaterThan(0);
    for (const exact of hyphenated) {
      const r = resolveTextAnchor({ type: 'text', quote: { exact } }, indexes);
      expect(r.status, exact).toBe('ok');
      expect(r.quads, exact).toHaveLength(2);
    }
  });

  it('reports ambiguity and uses prefix/suffix or page to disambiguate', () => {
    const exact = 'The map f is continuous on the closed interval';
    const amb = resolveTextAnchor({ type: 'text', quote: { exact } }, indexes);
    expect(amb.status).toBe('ambiguous');
    expect(amb.candidates).toHaveLength(2);
    const bySuffix = resolveTextAnchor({ type: 'text', quote: { exact, suffix: ' only when' } }, indexes);
    expect(bySuffix.status).toBe('ok');
    expect(bySuffix.quads![0]![1]).toBe(amb.candidates[1]!.quads[0]![1]);
    const byPage = resolveTextAnchor({ type: 'text', page: 2, quote: { exact: 'The map f' } }, indexes);
    expect(byPage.status).toBe('ok');
    expect(byPage.page).toBe(2);
  });

  it('reports quotes that do not occur as unresolved', () => {
    expect(resolveTextAnchor({ type: 'text', quote: { exact: 'not in this paper' } }, indexes).status).toBe('unresolved');
  });

  it('matches fuzzily within 10 % edit distance and stores what the document says', () => {
    const r = resolveTextAnchor({ type: 'text', page: 1, quote: { exact: 'intermedate value theorm' } }, indexes);
    expect(r.status).toBe('ok');
    expect(r.quote?.exact).toBe('intermediate value theorem');
    expect(r.quads!.length).toBeGreaterThan(0);
    // A tolerated typo in a longer quote, without a page.
    const longer = resolveTextAnchor({ type: 'text', quote: { exact: 'differentable on its interor' } }, indexes);
    expect(longer.status).toBe('ok');
  });

  it('does not match fuzzily beyond the budget, nor for short quotes, nor when not unique', () => {
    expect(findQuote({ exact: 'intermediate value theorem' }, indexes).fuzzy).toBe(false);
    expect(findQuote({ exact: 'intermxxxte value thxxrem' }, indexes).status).toBe('unresolved');
    expect(findQuote({ exact: 'continuus' }, indexes).status).toBe('unresolved');
    // Two near-identical places stay ambiguous, with candidates reported.
    const amb = resolveTextAnchor({ type: 'text', quote: { exact: 'The map f is continous on the closed interval' } }, indexes);
    expect(amb.status).toBe('ambiguous');
    expect(amb.candidates).toHaveLength(2);
  });

  it('round-trips quads → quote → quads', () => {
    const r = resolveTextAnchor({ type: 'text', quote: { exact: 'intermediate value theorem' } }, indexes);
    const t = indexes[0]!.page;
    const range = rangeForQuads(t, r.quads!)!;
    expect(quoteForRange(t, range[0], range[1]).exact).toBe('intermediate value theorem');
    const back = resolveTextAnchor({ type: 'text', page: 1, quads: r.quads! }, indexes);
    expect(back.quote?.exact).toBe('intermediate value theorem');
  });
});
