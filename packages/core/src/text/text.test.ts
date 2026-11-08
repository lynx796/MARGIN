import { beforeAll, describe, expect, it } from 'vitest';
import { prepareMath } from '../math/mathjax.ts';
import { testFonts } from '../test/fixtures.ts';
import { layoutBox, BOX_PADDING, LINE_HEIGHT } from './box.ts';
import { mathSources, parseMarkup, refIds } from './markup.ts';
import type { GlyphRunPrim, SvgPrim } from '../layout/types.ts';

describe('markup', () => {
  it('parses inline math, display math, styles, refs and escapes', () => {
    const [para] = parseMarkup('Only on \\((0,1]\\): **bold** *it* `f(x)` see \\ref{p8x2mz} \\* \\\\');
    const items = (para![0] as { items: unknown[] }).items;
    expect(items).toEqual([
      { kind: 'text', text: 'Only on ', style: { bold: false, italic: false, mono: false } },
      { kind: 'math', tex: '(0,1]' },
      { kind: 'text', text: ': ', style: { bold: false, italic: false, mono: false } },
      { kind: 'text', text: 'bold', style: { bold: true, italic: false, mono: false } },
      { kind: 'text', text: ' ', style: { bold: false, italic: false, mono: false } },
      { kind: 'text', text: 'it', style: { bold: false, italic: true, mono: false } },
      { kind: 'text', text: ' ', style: { bold: false, italic: false, mono: false } },
      { kind: 'text', text: 'f(x)', style: { bold: false, italic: false, mono: true } },
      { kind: 'text', text: ' see ', style: { bold: false, italic: false, mono: false } },
      { kind: 'ref', id: 'p8x2mz', style: { bold: false, italic: false, mono: false } },
      { kind: 'text', text: ' * \\', style: { bold: false, italic: false, mono: false } },
    ]);
  });

  it('treats unclosed delimiters as literal text', () => {
    const [para] = parseMarkup('a * b ** c \\( d ` e');
    expect(para).toEqual([{ kind: 'line', items: [{ kind: 'text', text: 'a * b ** c \\( d ` e', style: { bold: false, italic: false, mono: false } }] }]);
  });

  it('splits paragraphs on blank lines and lines on newlines; display math is its own block', () => {
    const paras = parseMarkup('one\ntwo\n\nthree \\[x^2\\] four');
    expect(paras).toHaveLength(2);
    expect(paras[0]!.map((b) => b.kind)).toEqual(['line', 'line']);
    expect(paras[1]!.map((b) => b.kind)).toEqual(['line', 'display', 'line']);
    expect(mathSources('a \\(x\\) b \\[y\\]')).toEqual([{ tex: 'x', display: false }, { tex: 'y', display: true }]);
    expect(refIds('see \\ref{abc123} and \\ref{xyz789}')).toEqual(['abc123', 'xyz789']);
  });
});

describe('layoutBox', () => {
  const fonts = testFonts();
  const base = { id: 'k3f9qd', width: 150, fontSize: 9, color: '#dc2626', fonts, refNumber: (id: string) => (id === 'p8x2mz' ? 7 : undefined) };
  const body = 'Only on \\((0,1]\\): \\(f(0)\\) is not defined. See also \\ref{p8x2mz}. A longer tail of words makes this wrap onto several lines.';

  beforeAll(async () => {
    await prepareMath([...mathSources(body), { tex: '\\frac{a}{b}', display: true }, { tex: 'x^{', display: false }, { tex: '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} + a + b + c + d + e + f + g + h', display: true }]);
  });

  it('wraps lines within the content width and grows by whole lines', () => {
    const one = layoutBox('Short.', base);
    expect(one.height).toBeCloseTo(2 * BOX_PADDING + LINE_HEIGHT * 9, 6);
    const box = layoutBox(body, { ...base, number: 3 });
    const lines = Math.round((box.height - 2 * BOX_PADDING) / (LINE_HEIGHT * 9));
    expect(lines).toBeGreaterThanOrEqual(3);
    const runs = box.prims.filter((p): p is GlyphRunPrim => p.type === 'glyphRun' && p.size === 9);
    for (const r of runs) expect(r.x + r.advances.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(150 - BOX_PADDING + 1e-6);
    expect(runs.map((r) => r.text).join(' ')).toContain('See also 7.');
    expect(box.prims.filter((p) => p.type === 'svg')).toHaveLength(2);
    expect(box.prims.some((p) => p.type === 'glyphRun' && p.text === '3' && p.size === 6.5)).toBe(true);
  });

  it('reports math errors and dangling references, rendering them in red', () => {
    const box = layoutBox('bad \\(x^{\\) and \\ref{zzzzzz}', base);
    expect(box.mathErrors).toHaveLength(1);
    expect(box.danglingRefs).toEqual(['zzzzzz']);
    const red = box.prims.filter((p): p is GlyphRunPrim => p.type === 'glyphRun' && p.color === '#dc2626').map((p) => p.text);
    expect(red).toEqual(['\\(x^{\\)', '??']);
  });

  it('centers display math and scales overly wide display math down', () => {
    const box = layoutBox('\\[\\frac{a}{b}\\]', base);
    const svg = box.prims.find((p): p is SvgPrim => p.type === 'svg')!;
    expect(svg.x).toBeGreaterThan(50);
    const wide = layoutBox('\\[\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} + a + b + c + d + e + f + g + h\\]', base);
    expect((wide.prims.find((p) => p.type === 'svg') as SvgPrim).scale).toBeLessThan(9 / 1000);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(layoutBox(body, base))).toBe(JSON.stringify(layoutBox(body, base)));
  });
});
