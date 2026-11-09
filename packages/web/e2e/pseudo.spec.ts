import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PdfDoc } from '@margin/core';
import { annotations, fixture, openApp, openFixture, selectQuote, watchErrors } from './helpers.ts';

// Phase 5: pseudonymization in the browser (spec §10), redaction in a worker under the CSP.

const terms = readFileSync(fixture('names', 'txt').replace('names.txt', 'terms.txt'), 'utf8');

test('a paper is pseudonymized, reviewed, annotated as the copy and transferred back', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await openApp(page);
  await openFixture(page, 'names');

  await page.getByTestId('open-pseudo').click();
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  await page.getByTestId('terms').fill('AUTHOR_1: /broken');
  await expect(page.getByTestId('terms-error')).toContainText('Line 1');
  await page.getByTestId('terms').fill(terms);
  await expect(page.getByTestId('terms-error')).toHaveCount(0);
  await page.getByTestId('pseudo-run').click();

  await expect(page.getByTestId('pseudo-summary')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('pseudo-summary')).toContainText('AUTHOR_1 ×');
  await expect(page.getByTestId('redaction').first()).toBeAttached();
  // Nothing can be saved before the review is confirmed.
  await expect(page.getByTestId('pseudo-download')).toBeDisabled();
  await page.getByTestId('pseudo-confirm').check();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('pseudo-download').click()]);
  expect(download.suggestedFilename()).toMatch(/\.pseudo\.pdf$/);
  const doc = await PdfDoc.open(new Uint8Array(readFileSync((await download.path())!)));
  const text = (await doc.allText()).map((t) => t.text).join('\n');
  await doc.destroy();
  expect(text).toContain('[AUTHOR_1]');
  for (const name of ['Müller', 'Keller', 'Ruffieux']) expect(text).not.toContain(name);

  await page.getByTestId('pseudo-open').click();
  await expect(page.getByTestId('restore-original')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('page-1')).toHaveAttribute('data-rendered', /.+/, { timeout: 30_000 });

  await selectQuote(page, 1, '[AUTHOR_1]');
  await page.keyboard.type('Comment on [AUTHOR_1]');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await annotations(page)).length).toBe(1);

  await page.getByTestId('restore-original').click();
  await expect(page.getByTestId('open-pseudo')).toBeVisible({ timeout: 30_000 });
  const restored = await annotations(page);
  expect(restored).toHaveLength(1);
  expect(restored[0]!.body).toBe('Comment on Anna Müller');
  // The quote is the original's own text again (OT1 extracts the umlaut as a separate glyph).
  expect(restored[0]!.anchor.quote?.exact).toBe('Anna M¨uller');
  expect(errors).toEqual([]);
});
