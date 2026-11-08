import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeGeometry, inkExtent, OUTER_MARGIN, toOriginal, toOutput } from './geometry.ts';
import { fixturePdf } from '../test/fixtures.ts';

const A4 = { width: 595.28, height: 841.89 };
const settings = { marginWidth: 150, maxEnlargement: 1.3 };

describe('inkExtent', () => {
  it('finds the horizontal extent of non-white pixels', () => {
    const width = 10;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const set = (x: number, y: number) => data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    set(3, 1);
    set(6, 2);
    expect(inkExtent({ width, height, data }, 36)).toEqual([6, 14]);
    expect(inkExtent({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) })).toBeNull();
  });

  it('finds the text block of a LaTeX article', async () => {
    const doc = await fixturePdf('plain');
    const ink = inkExtent(await doc.rasterize(1, 36))!;
    expect(ink[0]).toBeGreaterThan(120);
    expect(ink[0]).toBeLessThan(140);
    expect(ink[1]).toBeGreaterThan(470);
    expect(ink[1]).toBeLessThan(490); // 2 pt pixels at 36 dpi
  });
});

describe('computeGeometry', () => {
  it('enlarges a standard article without scaling content (§5.2)', () => {
    const g = computeGeometry([A4], [[133.77, 477.48]], settings);
    const p = g.pages[0]!;
    const t = 477.48 - 133.77 + 16;
    expect(p.k).toBeCloseTo((t + 300) / A4.width, 6);
    expect(p.s).toBe(1);
    expect(p.outWidth / p.outHeight).toBeCloseTo(A4.width / A4.height, 9);
    // Text block centered.
    expect(p.ox).toBeCloseTo((p.outWidth - t) / 2, 6);
    expect(p.left.x0).toBe(OUTER_MARGIN);
    expect(p.left.x1).toBeLessThanOrEqual(p.left.edge);
    expect(p.right.x1).toBeCloseTo(p.outWidth - OUTER_MARGIN, 6);
    expect(p.right.x0).toBeGreaterThanOrEqual(p.right.edge);
  });

  it('caps k and scales content down for wide text (§5.2)', () => {
    const g = computeGeometry([A4], [[30, 565]], settings);
    const p = g.pages[0]!;
    expect(p.k).toBe(1.3);
    expect(p.s).toBeLessThan(1);
    expect(p.s * p.t + 2 * 150).toBeCloseTo(p.outWidth, 6);
  });

  it('never shrinks a page with narrow text (k ≥ 1)', () => {
    const g = computeGeometry([A4], [[200, 300]], settings);
    expect(g.pages[0]!.k).toBe(1);
    expect(g.pages[0]!.left.x1 - g.pages[0]!.left.x0).toBeCloseTo(195, 6); // capped at 1.3 m
  });

  it('shares s across mixed page sizes and applies k per page', () => {
    const g = computeGeometry([A4, { width: 841.89, height: 595.28 }], [[100, 500], [100, 740]], settings);
    expect(g.pages[0]!.s).toBe(g.pages[1]!.s);
    expect(g.pages[0]!.outWidth / A4.width).toBeCloseTo(g.pages[1]!.outWidth / 841.89, 9);
  });

  it('uses a manual crop when set', () => {
    const g = computeGeometry([A4], [[0, 595]], { ...settings, crop: [100, 400] });
    expect(g.crop).toEqual([100, 400]);
  });

  it('T maps the crop edges to the text-block edges and has an inverse', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200, noNaN: true }), fc.double({ min: 300, max: 595, noNaN: true }), fc.double({ min: 0, max: 595, noNaN: true }), fc.double({ min: 0, max: 841, noNaN: true }), (a, b, x, y) => {
        const p = computeGeometry([A4], [[a, b]], settings).pages[0]!;
        expect(toOutput(p, a, 0)[0]).toBeCloseTo(p.left.edge, 6);
        expect(toOutput(p, b, 0)[0]).toBeCloseTo(p.right.edge, 6);
        const [u, v] = toOriginal(p, ...toOutput(p, x, y));
        expect(u).toBeCloseTo(x, 6);
        expect(v).toBeCloseTo(y, 6);
      }),
    );
  });
});
