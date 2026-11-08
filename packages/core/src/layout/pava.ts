// Placement within a column (spec §6.5).
//
//   min Σ wᵢ (yᵢ − aᵢ)²  s.t.  yᵢ₊₁ ≥ yᵢ + hᵢ + g,  y₁ ≥ T,  yₙ + hₙ ≤ B
//
// With cᵢ = Σ_{j<i}(hⱼ + g) and zᵢ = yᵢ − cᵢ this becomes weighted isotonic regression of the
// targets aᵢ − cᵢ under z₁ ≤ … ≤ zₙ, with the constant box zᵢ ∈ [T, B − hₙ − cₙ]. Pool-adjacent-
// violators solves the isotonic part exactly in O(n); clipping to a constant interval then yields
// the projection onto the intersection.

export interface PlacementInput {
  /** Targets aᵢ (desired box tops), in column order. */
  targets: number[];
  heights: number[];
  weights: number[];
  gap: number;
  top: number;
  bottom: number;
}

export interface Placement {
  /** Box tops yᵢ. */
  y: number[];
  /** False if the boxes do not fit between top and bottom; they then start at `top` and overflow. */
  fits: boolean;
}

/** Weighted isotonic regression (non-decreasing) by pool-adjacent-violators. */
export function isotonic(values: number[], weights: number[]): number[] {
  const n = values.length;
  const mean: number[] = [];
  const weight: number[] = [];
  const count: number[] = [];
  for (let i = 0; i < n; i++) {
    let m = values[i]!;
    let w = weights[i]!;
    let c = 1;
    while (mean.length > 0 && mean[mean.length - 1]! >= m) {
      const pm = mean.pop()!;
      const pw = weight.pop()!;
      const pc = count.pop()!;
      m = (pm * pw + m * w) / (pw + w);
      w += pw;
      c += pc;
    }
    mean.push(m);
    weight.push(w);
    count.push(c);
  }
  const out: number[] = [];
  mean.forEach((m, b) => {
    for (let k = 0; k < count[b]!; k++) out.push(m);
  });
  return out;
}

export function placeColumn(input: PlacementInput): Placement {
  const { targets, heights, gap, top, bottom } = input;
  const n = targets.length;
  if (n === 0) return { y: [], fits: true };
  // Zero weights would make the objective degenerate; keep a tiny positive weight instead.
  const weights = input.weights.map((w) => Math.max(w, 1e-3));
  const c: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    c.push(acc);
    acc += heights[i]! + gap;
  }
  const lo = top;
  const hi = bottom - heights[n - 1]! - c[n - 1]!;
  const fits = hi >= lo;
  const z = isotonic(targets.map((a, i) => a - c[i]!), weights);
  const y = z.map((zi, i) => Math.min(Math.max(zi, lo), fits ? hi : lo) + c[i]!);
  return { y, fits };
}
