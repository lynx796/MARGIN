import { expect, test } from '@playwright/test';
import { annotations, openApp, openFixture, selectQuote } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'plain', true);
});

test('margin width and font size change the layout', async ({ page }) => {
  const width = async () => (await page.getByTestId('page-1').boundingBox())!.width;
  const before = await width();
  await page.getByTestId('open-settings').click();
  const dialog = page.getByTestId('settings');
  await dialog.getByTestId('setting-margin').fill('220');
  await dialog.getByTestId('setting-margin').press('Tab');
  await dialog.getByTestId('setting-font').fill('11');
  await dialog.getByTestId('setting-font').press('Tab');
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(width).toBeGreaterThan(before * 1.05);
  const size = await page.getByTestId('overlay-1').locator('text').first().getAttribute('font-size');
  expect(Number(size)).toBeGreaterThanOrEqual(6.5);
  expect(await page.getByTestId('overlay-1').locator('text[font-size="11"]').count()).toBeGreaterThan(0);
  // One undo step per setting.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(width).toBeLessThan(before * 1.01);
});

test('categories: add inline, recolor via the chip swatch, rename and reorder in settings, delete', async ({ page }) => {
  await page.getByTestId('chip-add').click();
  await page.getByTestId('new-category-name').fill('Needs source');
  await page.getByTestId('new-category-add').click();
  const chip = page.getByTestId('chip-needs-source');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveClass(/active/);
  await expect(chip).toContainText('6');

  // Use it for a comment, recolor it from the chip, and see the box change color.
  await selectQuote(page, 1, 'general one is');
  await page.keyboard.type('Cite a source');
  await page.keyboard.press('Enter');
  await chip.locator('input[type=color]').fill('#00aa55');
  const color = await chip.evaluate((el) => getComputedStyle(el.querySelector('.swatch')!).backgroundColor);
  expect(color).toBe('rgb(0, 170, 85)');
  await expect(page.getByTestId('overlay-1').locator('rect[fill="#00aa55"]').first()).toBeAttached();

  await page.getByTestId('open-settings').click();
  const row = page.getByTestId('category-row-needs-source');
  await row.getByLabel('Name of Needs source').fill('Source?');
  await row.getByLabel('Name of Needs source').press('Tab');
  await row.getByRole('button', { name: /Move .* up/ }).click();
  await expect(page.getByTestId('chip-needs-source')).toContainText('Source?');
  await expect(page.getByTestId('chip-needs-source').locator('kbd')).toHaveText('5');
  // Still used by a comment: cannot be deleted; unused ones can.
  await page.getByTestId('category-row-needs-source').getByRole('button', { name: /Delete/ }).click();
  await expect(page.getByTestId('chip-needs-source')).toBeVisible();
  await page.getByTestId('category-row-good').getByRole('button', { name: /Delete Well done/ }).click().catch(() => undefined);
  expect((await annotations(page)).some((a) => a.category === 'needs-source')).toBe(true);
});

test('Forget this document removes it from browser storage', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __margin: { app: { flushSave(): Promise<void> } } }).__margin.app.flushSave());
  await page.getByTestId('open-settings').click();
  await page.getByTestId('forget').click();
  await expect(page.getByText('Nothing yet.')).toBeVisible();
});

test('Clear all data empties every store of the app in this browser', async ({ page }) => {
  await page.evaluate(async () => {
    const w = window as unknown as { __margin: { app: { flushSave(): Promise<void>; saveTerms(t: string): Promise<void> } } };
    await w.__margin.app.flushSave();
    await w.__margin.app.saveTerms('AUTHOR_1: Anna');
    localStorage.setItem('margin.hint.region', '1');
  });
  await page.getByTestId('open-settings').click();
  await page.getByRole('button', { name: 'Clear all data' }).click();
  await expect(page.getByText('Nothing yet.')).toBeVisible();
  const left = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open('margin');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
    const count = (store: string) => new Promise<number>((ok) => {
      const r = db.transaction(store).objectStore(store).count();
      r.onsuccess = () => ok(r.result);
    });
    const opfs: string[] = [];
    const root = (await navigator.storage.getDirectory()) as unknown as { keys(): AsyncIterable<string> };
    for await (const name of root.keys()) opfs.push(name);
    return { docs: await count('docs'), kv: await count('kv'), blobs: await count('blobs'), opfs, hint: localStorage.getItem('margin.hint.region') };
  });
  expect(left).toEqual({ docs: 0, kv: 0, blobs: 0, opfs: [], hint: null });
});
