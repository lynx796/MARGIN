// Minimal SVG path utilities: parse path data, apply an affine transform, serialize with absolute
// M/L/Q/C/Z commands. Used to flatten MathJax SVG output into self-contained paths.

export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** m ∘ n: apply n first, then m. */
export function compose(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Parse an SVG `transform` attribute (translate, scale, matrix, rotate). */
export function parseTransform(attr: string | null | undefined): Affine {
  let m = IDENTITY;
  if (!attr) return m;
  for (const [, fn, argText] of attr.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = argText!.split(/[\s,]+/).filter(Boolean).map(Number);
    let t: Affine = IDENTITY;
    switch (fn) {
      case 'translate':
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case 'matrix':
        t = [a[0] ?? 1, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1, a[4] ?? 0, a[5] ?? 0];
        break;
      case 'rotate': {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
        t = compose(compose([1, 0, 0, 1, cx, cy], [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      default:
        break;
    }
    m = compose(m, t);
  }
  return m;
}

function fmt(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Transform path data; returns absolute M/L/Q/C/Z commands with coordinates rounded to 0.1. */
export function transformPath(d: string, m: Affine): string {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  const P = (x: number, y: number) => {
    const X = m[0] * x + m[2] * y + m[4];
    const Y = m[1] * x + m[3] * y + m[5];
    return fmt(X) + ' ' + fmt(Y);
  };
  let i = 0;
  let cmd = '';
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: [number, number] | null = null;
  let lastCmd = '';
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!;
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + num(); y = oy + num(); sx = x; sy = y;
        out.push('M' + P(x, y));
        cmd = rel ? 'l' : 'L';
        lastCtrl = null;
        break;
      case 'L':
        x = ox + num(); y = oy + num();
        out.push('L' + P(x, y));
        lastCtrl = null;
        break;
      case 'H':
        x = ox + num();
        out.push('L' + P(x, y));
        lastCtrl = null;
        break;
      case 'V':
        y = (rel ? y : 0) + num();
        out.push('L' + P(x, y));
        lastCtrl = null;
        break;
      case 'C': {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num();
        x = ox + num(); y = oy + num();
        out.push('C' + P(x1, y1) + ' ' + P(x2, y2) + ' ' + P(x, y));
        lastCtrl = [x2, y2];
        break;
      }
      case 'S': {
        const [x1, y1]: [number, number] = lastCtrl && /[CS]/i.test(lastCmd) ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        const x2 = ox + num(), y2 = oy + num();
        x = ox + num(); y = oy + num();
        out.push('C' + P(x1, y1) + ' ' + P(x2, y2) + ' ' + P(x, y));
        lastCtrl = [x2, y2];
        break;
      }
      case 'Q': {
        const x1 = ox + num(), y1 = oy + num();
        x = ox + num(); y = oy + num();
        out.push('Q' + P(x1, y1) + ' ' + P(x, y));
        lastCtrl = [x1, y1];
        break;
      }
      case 'T': {
        const [x1, y1]: [number, number] = lastCtrl && /[QT]/i.test(lastCmd) ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        x = ox + num(); y = oy + num();
        out.push('Q' + P(x1, y1) + ' ' + P(x, y));
        lastCtrl = [x1, y1];
        break;
      }
      case 'A': {
        // Elliptical arcs do not occur in MathJax glyph data; approximate by a straight segment.
        i += 5;
        x = ox + num(); y = oy + num();
        out.push('L' + P(x, y));
        lastCtrl = null;
        break;
      }
      case 'Z':
        out.push('Z');
        x = sx; y = sy;
        lastCtrl = null;
        break;
      default:
        i++;
    }
    lastCmd = cmd;
  }
  return out.join('');
}

export function rectPath(x: number, y: number, w: number, h: number, m: Affine): string {
  return transformPath(`M${x} ${y}H${x + w}V${y + h}H${x}Z`, m);
}
