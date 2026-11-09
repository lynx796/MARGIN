import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PdfDoc } from '@margin/core';
import { annotations, fixture, openApp, openFixture, selectQuote, upload } from './helpers.ts';

// Phase 4: grading report, embedded annotation file, re-import of exported PDFs.

async function comment(page: import('@playwright/test').Page, quote: string, body: string) {
  await selectQuote(page, 1, quote);
  await page.keyboard.type(body);
  await page.keyboard.press('Enter');
}

async function exportBytes(page: import('@playwright/test').Page): Promise<Uint8Array> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  return new Uint8Array(readFileSync((await download.path())!));
}

test('a grading report is placed before the annotated pages, and after on request', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'plain');
  await comment(page, 'affine case', 'Reported');

  // Without a report: exactly the annotated pages.
  const plain = await PdfDoc.open(await exportBytes(page));
  expect(plain.pageCount).toBe(2);
  await plain.destroy();

  await page.getByTestId('open-settings').click();
  await page.getByTestId('report-input').setInputFiles(fixture('mixed'));
  await expect(page.getByTestId('report-name')).toContainText('mixed.pdf');
  const reportPages = (await (async () => { const d = await PdfDoc.open(new Uint8Array(readFileSync(fixture('mixed')))); const n = d.pageCount; await d.destroy(); return n; })());
  await page.keyboard.press('Escape');

  const before = await PdfDoc.open(await exportBytes(page));
  expect(before.pageCount).toBe(2 + reportPages);
  expect((await before.text(reportPages + 1)).text).toContain('Reported');
  await before.destroy();

  await page.getByTestId('open-settings').click();
  await page.getByTestId('report-position').selectOption('after');
  await page.keyboard.press('Escape');
  const after = await PdfDoc.open(await exportBytes(page));
  expect(after.pageCount).toBe(2 + reportPages);
  expect((await after.text(1)).text).toContain('Reported');
  await after.destroy();
});

test('an exported PDF reopens as the editable document', async ({ page, browser }) => {
  await openApp(page);
  await openFixture(page, 'plain');
  await comment(page, 'affine case', 'Round trip');
  await page.getByTestId('open-settings').click();
  await page.getByTestId('embed-original').check();
  await page.keyboard.press('Escape');
  const withOriginal = await exportBytes(page);

  // A fresh browser has no copy of the paper: the attached original is enough.
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await openApp(p2);
  await p2.getByTestId('file-input').setInputFiles({ name: 'plain.annotated.pdf', mimeType: 'application/pdf', buffer: Buffer.from(withOriginal) });
  await expect(p2.getByTestId('page-1')).toBeVisible({ timeout: 30_000 });
  expect((await annotations(p2))[0]).toMatchObject({ body: 'Round trip' });
  await fresh.close();

  // Without the attached original it asks for it, and accepts it dropped along with the export.
  await page.getByTestId('open-settings').click();
  await page.getByTestId('embed-original').uncheck();
  await page.keyboard.press('Escape');
  const exported = await exportBytes(page);
  expect(exported.length).toBeLessThan(withOriginal.length);
  const ctx = await browser.newContext();
  const p3 = await ctx.newPage();
  await openApp(p3);
  await p3.getByTestId('file-input').setInputFiles({ name: 'plain.annotated.pdf', mimeType: 'application/pdf', buffer: Buffer.from(exported) });
  await expect(p3.getByText('Drop that original PDF together with it')).toBeVisible();
  await p3.getByTestId('file-input').setInputFiles([{ name: 'plain.annotated.pdf', mimeType: 'application/pdf', buffer: Buffer.from(exported) }, upload('plain')]);
  await expect(p3.getByTestId('page-1')).toBeVisible({ timeout: 30_000 });
  expect((await annotations(p3))[0]).toMatchObject({ body: 'Round trip' });
  await ctx.close();
});
