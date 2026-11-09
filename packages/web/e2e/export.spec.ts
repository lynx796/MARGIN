import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { PdfDoc } from '@margin/core';
import { annotations, openApp, openFixture, selectQuote, watchErrors } from './helpers.ts';

test('export downloads a PDF with the comments flattened in; no request leaves the origin', async ({ page }) => {
  const errors = watchErrors(page);
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) external.push(r.url());
  });
  await openApp(page);
  await openFixture(page, 'plain');
  await selectQuote(page, 1, 'affine case');
  await page.keyboard.type('Exported \\(\\alpha\\)');
  await page.keyboard.press('Enter');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  expect(download.suggestedFilename()).toBe('plain.annotated.pdf');
  const bytes = new Uint8Array(readFileSync((await download.path())!));
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

  const pdf = await PdfDoc.open(bytes);
  expect(pdf.pageCount).toBe(2);
  const text = (await pdf.text(1)).text;
  expect(text).toContain('Exported');
  expect(text).toContain('The map f is continuous'); // original text still selectable
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

/**
 * Screen and export render the same display list, so they must agree (spec §12.3: within 1 px at
 * 150 dpi). Anti-aliasing differs between the browser's SVG text and the PDF renderer, so a pixel
 * counts as different only if no pixel within one pixel of it in the other image has a similar color.
 */
function toleranceDiff(a: Uint8ClampedArray | Buffer, b: Uint8ClampedArray | Buffer, w: number, h: number, threshold = 70): number {
  const lum = (d: ArrayLike<number>, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
  const near = (x: number, y: number, target: number, other: ArrayLike<number>) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      if (Math.abs(lum(other, (yy * w + xx) * 4) - target) <= threshold) return true;
    }
    return false;
  };
  let bad = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (!near(x, y, lum(a, i), b) || !near(x, y, lum(b, i), a)) bad++;
  }
  return bad / (w * h);
}

test('overlay and exported page agree within 1 px at 150 dpi', async ({ page }, info) => {
  test.slow();
  await page.setViewportSize({ width: 2000, height: 2500 });
  await openApp(page);
  await openFixture(page, 'plain', true);
  await page.getByTestId('toggle-sidebar').click();
  // The reference annotations come from the CLI (origin: agent). Unreviewed agent comments carry screen-only
  // marks (spec §9.4) that the export never has, so review them first, as a grader would.
  await page.evaluate(() => (window as unknown as { __margin: { app: { acceptAll(): void } } }).__margin.app.acceptAll());
  // 150 dpi: 150/72 CSS px per point, no device scaling.
  await page.evaluate(() => (window as unknown as { __margin: { app: { setZoom(z: number): void } } }).__margin.app.setZoom(150 / 72));
  await expect(page.getByTestId('page-1')).toHaveAttribute('data-rendered', String(150 / 72), { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const el = page.getByTestId('page-1');
  await el.scrollIntoViewIfNeeded();
  const shot = PNG.sync.read(await el.screenshot());

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  const exported = await PdfDoc.open(new Uint8Array(readFileSync((await download.path())!)));
  const ref = await exported.rasterize(1, 150);

  // Sizes agree to a pixel.
  expect(Math.abs(shot.width - ref.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(shot.height - ref.height)).toBeLessThanOrEqual(1);
  const w = Math.min(shot.width, ref.width);
  const h = Math.min(shot.height, ref.height);
  const crop = (src: ArrayLike<number>, sw: number) => {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w * 4; x++) out[y * w * 4 + x] = src[y * sw * 4 + x]!;
    return out;
  };
  const a = crop(shot.data, shot.width);
  const b = crop(ref.data, ref.width);
  const fraction = toleranceDiff(a, b, w, h);
  const plain = pixelmatch(a, b, undefined, w, h, { threshold: 0.1 }) / (w * h);
  const out = new PNG({ width: w, height: h });
  out.data = Buffer.from(a);
  await info.attach('screen.png', { body: PNG.sync.write(out), contentType: 'image/png' });
  console.log(`plain pixel diff ${(plain * 100).toFixed(3)} %, 1px-tolerant diff ${(fraction * 100).toFixed(4)} %`);
  expect(fraction).toBeLessThan(0.0005);
  // Negative control: the same screenshot moved by 3 px must be detected as different.
  const moved = new Uint8ClampedArray(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 4 - 12; x++) moved[y * w * 4 + x + 12] = a[y * w * 4 + x]!;
  expect(toleranceDiff(moved, b, w, h)).toBeGreaterThan(0.0015);
  expect((await annotations(page)).length).toBeGreaterThan(5);
});
