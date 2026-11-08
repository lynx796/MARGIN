import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isotonic, placeColumn, type PlacementInput } from './pava.ts';

/** Reference solver: Hildreth's dual coordinate ascent for min Σ wᵢ(yᵢ−aᵢ)² s.t. G y ≤ h. */
function qp(input: PlacementInput): number[] {
  const { targets: a, heights: hs, weights: w, gap, top, bottom } = input;
  const n = a.length;
  const G: { coef: [number, number][]; h: number }[] = [];
  for (let i = 0; i + 1 < n; i++) G.push({ coef: [[i, 1], [i + 1, -1]], h: -(hs[i]! + gap) });
  G.push({ coef: [[0, -1]], h: -top });
  G.push({ coef: [[n - 1, 1]], h: bottom - hs[n - 1]! });
  const lam = new Array(G.length).fill(0);
  const y = [...a];
  for (let it = 0; it < 200000; it++) {
    let change = 0;
    G.forEach((c, k) => {
      const gy = c.coef.reduce((acc, [i, v]) => acc + v * y[i]!, 0);
      const gqg = c.coef.reduce((acc, [i, v]) => acc + (v * v) / (2 * w[i]!), 0);
      const next = Math.max(0, lam[k] + (gy - c.h) / gqg);
      const d = next - lam[k];
      if (d !== 0) {
        lam[k] = next;
        for (const [i, v] of c.coef) y[i] = y[i]! - (d * v) / (2 * w[i]!);
        change = Math.max(change, Math.abs(d));
      }
    });
    if (change < 1e-13) break;
  }
  return y;
}

const objective = (y: number[], i: PlacementInput) => y.reduce((acc, yi, k) => acc + i.weights[k]! * (yi - i.targets[k]!) ** 2, 0);

const instance = fc
  .array(fc.record({ a: fc.double({ min: 0, max: 800, noNaN: true }), h: fc.double({ min: 5, max: 120, noNaN: true }), w: fc.integer({ min: 1, max: 3 }) }), { minLength: 1, maxLength: 8 })
  .map((rows): PlacementInput => {
    const sorted = [...rows].sort((p, q) => p.a - q.a);
    return { targets: sorted.map((r) => r.a), heights: sorted.map((r) => r.h), weights: sorted.map((r) => r.w), gap: 4, top: 18, bottom: 900 };
  });

describe('isotonic', () => {
  it('pools adjacent violators by weighted mean', () => {
    expect(isotonic([1, 3, 2, 4], [1, 1, 1, 1])).toEqual([1, 2.5, 2.5, 4]);
    expect(isotonic([3, 1], [3, 1])).toEqual([2.5, 2.5]);
  });
});

describe('placeColumn', () => {
  it('is feasible: no overlaps, within the column', () => {
    fc.assert(
      fc.property(instance, (inst) => {
        const { y, fits } = placeColumn(inst);
        for (let i = 0; i + 1 < y.length; i++) expect(y[i + 1]! - y[i]! - inst.heights[i]! - inst.gap).toBeGreaterThanOrEqual(-1e-9);
        expect(y[0]!).toBeGreaterThanOrEqual(inst.top - 1e-9);
        if (fits) expect(y[y.length - 1]! + inst.heights[y.length - 1]!).toBeLessThanOrEqual(inst.bottom + 1e-9);
      }),
      { numRuns: 300 },
    );
  });

  it('is optimal: matches a QP solver to 1e-6', () => {
    fc.assert(
      fc.property(instance, (inst) => {
        const { y, fits } = placeColumn(inst);
        fc.pre(fits);
        const ref = qp(inst);
        expect(Math.abs(objective(y, inst) - objective(ref, inst))).toBeLessThan(1e-6 * Math.max(1, objective(ref, inst)));
        y.forEach((v, i) => expect(v).toBeCloseTo(ref[i]!, 5));
      }),
      { numRuns: 300 },
    );
  });

  it('leaves boxes at their targets when there is room', () => {
    expect(placeColumn({ targets: [100, 300], heights: [20, 20], weights: [1, 1], gap: 4, top: 18, bottom: 800 }).y).toEqual([100, 300]);
  });

  it('pushes colliding boxes apart around their weighted center', () => {
    const { y } = placeColumn({ targets: [100, 100], heights: [20, 20], weights: [1, 3], gap: 4, top: 18, bottom: 800 });
    expect(y[1]! - y[0]!).toBeCloseTo(24, 9);
    expect(1 * (y[0]! - 100) + 3 * (y[1]! - 100)).toBeCloseTo(0, 9);
  });

  it('reports when boxes do not fit', () => {
    expect(placeColumn({ targets: [0, 0], heights: [500, 500], weights: [1, 1], gap: 4, top: 18, bottom: 800 }).fits).toBe(false);
  });
});
