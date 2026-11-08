import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { parseAnnotFile, serialize } from '@margin/core';
import { run } from '../src/main.ts';

// Golden tests (spec §12.2): for each fixture, `margin render` produces layout.json and page PNGs,
// compared with fixtures/<name>/expected/. After an intended change, regenerate with
// `pnpm golden:update` (GOLDEN_UPDATE=1) and review the diff like code.

const FIXTURES = new URL('../../../fixtures/', import.meta.url).pathname;
const UPDATE = process.env.GOLDEN_UPDATE === '1';
/** Share of pixels that may differ (anti-aliasing noise across platforms). */
const PIXEL_TOLERANCE = 0.001;

const fixtures = readdirSync(FIXTURES).filter((n) => existsSync(join(FIXTURES, n, `${n}.annot.json`)));

async function quiet(argv: string[]): Promise<number> {
  const o = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const e = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return await run(argv);
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

describe.each(fixtures)('fixture %s', (name) => {
  const dir = join(FIXTURES, name);
  const config: { dpi?: number; pages?: string } = existsSync(join(dir, 'golden.json')) ? JSON.parse(readFileSync(join(dir, 'golden.json'), 'utf8')) : {};
  const expected = join(dir, 'expected');

  it('annotation file round-trips byte-identically', () => {
    const text = readFileSync(join(dir, `${name}.annot.json`), 'utf8');
    expect(serialize(parseAnnotFile(text))).toBe(text);
  });

  it('renders the expected layout and pages', async () => {
    const out = mkdtempSync(join(tmpdir(), `margin-golden-${name}-`));
    const argv = ['render', join(dir, `${name}.pdf`), '-o', out, '--dpi', String(config.dpi ?? 72), ...(config.pages ? ['--pages', config.pages] : [])];
    expect(await quiet(argv)).toBe(0);
    if (UPDATE) {
      rmSync(expected, { recursive: true, force: true });
      mkdirSync(expected, { recursive: true });
      cpSync(out, expected, { recursive: true });
      return;
    }
    expect(existsSync(expected), `no golden output for ${name}; run pnpm golden:update`).toBe(true);
    expect(readdirSync(out).sort()).toEqual(readdirSync(expected).sort());
    expect(readFileSync(join(out, 'layout.json'), 'utf8')).toBe(readFileSync(join(expected, 'layout.json'), 'utf8'));
    for (const f of readdirSync(expected).filter((x) => x.endsWith('.png'))) {
      const a = PNG.sync.read(readFileSync(join(out, f)));
      const b = PNG.sync.read(readFileSync(join(expected, f)));
      expect([a.width, a.height], f).toEqual([b.width, b.height]);
      const diff = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
      expect(diff / (a.width * a.height), `${f}: ${diff} pixels differ`).toBeLessThanOrEqual(PIXEL_TOLERANCE);
    }
    rmSync(out, { recursive: true, force: true });
  });
});
