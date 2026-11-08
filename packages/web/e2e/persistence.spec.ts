import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { annotations, fixture, openApp, openFixture, selectQuote, upload, uploadText } from './helpers.ts';

test('annotations survive a reload and are listed on the start screen', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'plain');
  await selectQuote(page, 1, 'affine case');
  await page.keyboard.type('Persist me');
  await page.keyboard.press('Enter');
  await page.evaluate(() => (window as unknown as { __margin: { app: { flushSave(): Promise<void> } } }).__margin.app.flushSave());

  await openApp(page); // reload
  const recent = page.getByTestId('recent');
  await expect(recent).toContainText('plain.pdf');
  await expect(recent).toContainText('2 pages');
  await recent.getByRole('button', { name: /plain\.pdf/ }).first().click();
  await expect(page.getByTestId('page-1')).toBeVisible();
  const [a] = await annotations(page);
  expect(a).toMatchObject({ body: 'Persist me', category: 'typo' });
  await expect(page.getByTestId('overlay-1').locator('text', { hasText: 'Persist me' })).toBeVisible();
});

test('"Save annotations" downloads the annotation file; opening it again restores everything', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'plain');
  await page.keyboard.press('2');
  await selectQuote(page, 1, 'fluffy notion');
  await page.keyboard.type('Vague \\(x\\)');
  await page.keyboard.press('Enter');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-annotations').click()]);
  expect(download.suggestedFilename()).toBe('plain.annot.json');
  const text = readFileSync((await download.path())!, 'utf8');
  const file = JSON.parse(text);
  expect(file).toMatchObject({ format: 'margin-annot', version: 1, document: { fileName: 'plain.pdf', pageCount: 2 } });
  expect(file.annotations).toHaveLength(1);
  expect(file.annotations[0]).toMatchObject({ category: 'error', body: 'Vague \\(x\\)', origin: 'human', anchor: { type: 'text', page: 1 } });
  expect(text.endsWith('}\n')).toBe(true);

  // A fresh context-free reload with the downloaded file brings the annotation back.
  await openApp(page);
  await page.getByTestId('file-input').setInputFiles([upload('plain'), uploadText('plain.annot.json', text)]);
  await expect(page.getByTestId('page-1')).toBeVisible();
  expect((await annotations(page))[0]!.body).toBe('Vague \\(x\\)');
});

test('opening a PDF with its reference annotation file shows all comments', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'plain', true);
  const rows = page.getByTestId('sidebar').locator('li button.row');
  await expect(rows).toHaveCount(8); // 9 annotations, one is a highlight
  await expect(page.getByTestId('badge-unresolved')).toHaveCount(0);
});

test('annotations without geometry (written by an agent) are resolved on open', async ({ page }) => {
  await openApp(page);
  const annot = JSON.parse(readFileSync(fixture('plain', 'annot.json'), 'utf8'));
  annot.annotations = [{ category: 'error', body: 'Agent says hi', anchor: { page: 1, quote: { exact: 'fixed points' } } }];
  await page.getByTestId('file-input').setInputFiles([upload('plain'), uploadText('plain.annot.json', JSON.stringify(annot))]);
  await expect(page.getByTestId('page-1')).toBeVisible();
  await expect(page.getByTestId('overlay-1').locator('text', { hasText: 'Agent says hi' })).toBeVisible();
  const [a] = await annotations(page);
  expect(a!.id).toMatch(/^[0-9a-hjkmnp-tv-z]{6}$/);
});

test('a different revision of the PDF offers re-anchoring by quote', async ({ page }) => {
  await openApp(page);
  const annot = JSON.parse(readFileSync(fixture('plain', 'annot.json'), 'utf8'));
  annot.document.sha256 = '0'.repeat(64);
  await page.getByTestId('file-input').setInputFiles([upload('plain'), uploadText('plain.annot.json', JSON.stringify(annot))]);
  await expect(page.getByTestId('mismatch')).toBeVisible();
  await page.getByRole('button', { name: 'Re-anchor by quote' }).click();
  await expect(page.getByTestId('mismatch')).toBeHidden();
  const after = await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __margin: { app: { file: { document: { sha256: string }; annotations: { status?: string }[] } } } }).__margin.app.file)));
  expect(after.document.sha256).not.toBe('0'.repeat(64));
  expect(after.annotations.every((a: { status?: string }) => a.status === 'ok')).toBe(true);
});

test('documents can be forgotten', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'plain');
  await page.evaluate(() => (window as unknown as { __margin: { app: { flushSave(): Promise<void> } } }).__margin.app.flushSave());
  await page.getByRole('button', { name: 'Close document' }).click();
  await expect(page.getByTestId('recent')).toContainText('plain.pdf');
  await page.getByRole('button', { name: /Remove plain\.pdf/ }).click();
  await expect(page.getByTestId('recent')).toHaveCount(0);
  await openApp(page);
  await expect(page.getByText('Nothing yet.')).toBeVisible();
});
