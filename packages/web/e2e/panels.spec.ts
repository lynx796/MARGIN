import { expect, test } from '@playwright/test';
import { annotations, openApp, openFixture, selectQuote } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'plain', true);
});

test('sidebar lists comments in reading order, filters, and jumps to a comment', async ({ page }) => {
  const rows = page.getByTestId('sidebar').locator('li button.row');
  await expect(rows).toHaveCount(8);
  await expect(rows.first().locator('.num')).toHaveText('1');
  await page.getByTestId('filter-category').selectOption('error');
  await expect(rows).toHaveCount(2);
  await page.getByTestId('filter-category').selectOption('');
  await page.getByTestId('filter-origin').selectOption('human');
  await expect(rows).toHaveCount(0); // the reference file's comments are all by an agent
  await page.getByTestId('filter-origin').selectOption('');
  // The last comment is on page 2: clicking scrolls there and focuses it.
  await rows.last().click();
  await expect(rows.last()).toHaveClass(/focused/);
  await expect.poll(async () => page.getByTestId('page-2').evaluate((el) => el.getBoundingClientRect().top < window.innerHeight)).toBe(true);
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('sidebar')).toBeHidden();
});

test('search finds PDF text and comment bodies, highlights and steps through matches', async ({ page }) => {
  await page.keyboard.press('Control+f');
  const input = page.getByTestId('search-input');
  await expect(input).toBeFocused();
  await input.fill('the map f');
  await expect(page.getByTestId('search-count')).toHaveText('1 / 3', { timeout: 15_000 });
  await expect(page.getByTestId('overlay-1').locator('..').locator('svg.under rect[fill="#fb923c"]')).toHaveCount(1);
  await input.press('Enter');
  await expect(page.getByTestId('search-count')).toHaveText('2 / 3');
  await input.fill('overlap');
  await expect(page.getByTestId('search-count')).toHaveText('1 / 1'); // only the comment "Overlapping anchor: drawn one level lower."
  await input.press('Escape');
  await expect(input).toBeHidden();
});

test('zoom buttons resize the pages', async ({ page }) => {
  const before = (await page.getByTestId('page-1').boundingBox())!.width;
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await page.getByTestId('page-1').boundingBox())!.width).toBeGreaterThan(before * 1.1);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect.poll(async () => (await page.getByTestId('page-1').boundingBox())!.width).toBeLessThan(before);
  await page.getByTestId('zoom').click(); // fit width
  await expect.poll(async () => Math.abs((await page.getByTestId('page-1').boundingBox())!.width - before)).toBeLessThan(2);
});

test('dragging an anchor end adjusts the extent in one undo step', async ({ page }) => {
  await page.keyboard.press('3');
  await selectQuote(page, 1, 'general one is');
  await page.keyboard.type('Adjust me');
  await page.keyboard.press('Enter');
  const id = (await annotations(page)).find((a) => a.body === 'Adjust me')!.id;
  expect((await annotations(page)).find((a) => a.id === id)!.anchor.quote!.exact).toBe('general one is');
  const handle = page.locator('[data-handle="end"]');
  await expect(handle).toBeVisible();
  const b = (await handle.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 45, b.y + b.height / 2 - 3, { steps: 6 });
  await page.mouse.up();
  const longer = (await annotations(page)).find((a) => a.id === id)!.anchor.quote!.exact;
  expect(longer.startsWith('general one is')).toBe(true);
  expect(longer.length).toBeGreaterThan('general one is'.length);
  await page.keyboard.press('Control+z');
  expect((await annotations(page)).find((a) => a.id === id)!.anchor.quote!.exact).toBe('general one is');
});
