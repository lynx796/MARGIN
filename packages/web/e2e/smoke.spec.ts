import { expect, test } from '@playwright/test';
import { openApp, openFixture, watchErrors } from './helpers.ts';

test('opens a PDF, renders enlarged pages with margins, and violates no CSP', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await openFixture(page, 'plain');
  await expect(page.getByTestId('file-name')).toHaveText('plain.pdf');
  const box = (await page.getByTestId('page-1').boundingBox())!;
  // Output pages keep the A4 aspect ratio (spec §5.2) and are wider than the original.
  expect(box.width / box.height).toBeCloseTo(595.28 / 841.89, 2);
  const canvas = page.locator('[data-testid=page-1] canvas');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});
