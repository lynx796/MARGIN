import { expect, test } from '@playwright/test';
import { annotations, openApp, openFixture, selectQuote, watchErrors } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'plain');
});

const editor = (page: import('@playwright/test').Page) => page.getByTestId('comment-editor');

test('select → type → Enter creates a comment anchored to the selected text', async ({ page }) => {
  const errors = watchErrors(page);
  await selectQuote(page, 1, 'differentiable on its');
  await expect(editor(page)).toBeVisible();
  await page.keyboard.type('Why differentiable?');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeHidden();

  const [a] = await annotations(page);
  expect(await annotations(page)).toHaveLength(1);
  expect(a).toMatchObject({ category: 'typo', body: 'Why differentiable?', side: 'auto' });
  expect(a!.anchor).toMatchObject({ type: 'text', page: 1, quote: { exact: 'differentiable on its' } });
  // The comment is drawn into the margin from the display list, and listed in the sidebar with number 1.
  await expect(page.getByTestId('overlay-1').locator('text', { hasText: 'Why differentiable?' })).toBeVisible();
  await expect(page.getByTestId(`row-${a!.id}`)).toContainText('Why differentiable?');
  expect(errors).toEqual([]);
});

test('Shift+Enter inserts a line break, Esc commits', async ({ page }) => {
  await selectQuote(page, 1, 'affine case');
  await page.keyboard.type('first');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second');
  await expect(editor(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor(page)).toBeHidden();
  expect((await annotations(page))[0]!.body).toBe('first\nsecond');
  await expect(page.getByTestId('overlay-1').locator('text', { hasText: 'second' })).toBeVisible();
});

test('committing an empty comment deletes it', async ({ page }) => {
  await selectQuote(page, 1, 'affine case');
  await expect(editor(page)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeHidden();
  expect(await annotations(page)).toHaveLength(0);
  await expect(page.getByTestId('undo').or(page.getByRole('button', { name: 'Undo' }))).toBeDisabled();
});

test('digit keys choose the category; Ctrl+digit changes it while editing', async ({ page }) => {
  await page.keyboard.press('2');
  await selectQuote(page, 1, 'affine case');
  await page.keyboard.type('wrong');
  await page.keyboard.press('Control+3');
  await page.keyboard.press('Enter');
  expect((await annotations(page))[0]).toMatchObject({ category: 'remark', body: 'wrong' });
  await expect(page.getByTestId('chip-remark')).toHaveClass(/active/);
});

test('highlight categories never open an editor', async ({ page }) => {
  await page.keyboard.press('5');
  await selectQuote(page, 1, 'fluffy notion');
  await expect(editor(page)).toBeHidden();
  const [a] = await annotations(page);
  expect(a).toMatchObject({ category: 'hl', body: '' });
});

test('Alt+drag draws a region anchor', async ({ page }) => {
  // A rectangle over the display formula's neighbourhood, positioned relative to visible text.
  const r = await page.evaluate(() => (window as unknown as { __margin: { quoteRect(p: number, q: string): Promise<{ x0: number; y0: number; x1: number; y1: number }> } }).__margin.quoteRect(1, 'considerably longer'));
  await page.getByTestId('page-1').scrollIntoViewIfNeeded();
  await page.keyboard.down('Alt');
  await page.mouse.move(r.x0, r.y1 + 6);
  await page.mouse.down();
  await page.mouse.move(r.x0 + 180, r.y1 + 40, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(editor(page)).toBeVisible();
  await page.keyboard.type('Check this formula');
  await page.keyboard.press('Enter');
  const [a] = await annotations(page);
  expect(a!.anchor.type).toBe('region');
  expect(a!.anchor.rect).toHaveLength(4);
  await expect(page.getByTestId('overlay-1').locator('rect[stroke]').first()).toBeAttached();
});

test('math is typeset in the box and shown as a rendered widget while editing', async ({ page }) => {
  await selectQuote(page, 1, 'affine case');
  await page.keyboard.type('Only on ');
  await page.keyboard.press('Control+m');
  await page.keyboard.type('(0,1]');
  // Cursor inside: source plus a floating preview; leaving the segment renders a widget.
  await expect(page.locator('.cm-math-preview svg')).toBeVisible();
  await page.keyboard.press('End');
  await expect(editor(page).locator('.cm-math svg')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('overlay-1').locator('g[transform] path').first()).toBeAttached();
  expect((await annotations(page))[0]!.body).toBe('Only on \\((0,1]\\)');
});

test('TeX errors are shown in red and counted in the warning badge', async ({ page }) => {
  await selectQuote(page, 1, 'affine case');
  await page.keyboard.type('bad \\(x^{\\)');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('badge-math')).toContainText('1 math error');
});

test('Ctrl+Z and Ctrl+Shift+Z undo and redo, including deletion with the Delete key', async ({ page }) => {
  await selectQuote(page, 1, 'affine case');
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  expect(await annotations(page)).toHaveLength(1);
  await page.keyboard.press('Control+z');
  expect(await annotations(page)).toHaveLength(0);
  await page.keyboard.press('Control+Shift+z');
  expect(await annotations(page)).toHaveLength(1);
  // Tab focuses the comment: Delete removes it, undo brings it back.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Delete');
  expect(await annotations(page)).toHaveLength(0);
  await page.keyboard.press('Control+z');
  expect(await annotations(page)).toHaveLength(1);
});

test('Tab cycles focus through comments in reading order; Enter edits; Alt+R pins', async ({ page }) => {
  for (const [quote, body] of [['differentiable on its', 'A'], ['general one is not', 'B']] as const) {
    await selectQuote(page, 1, quote);
    await page.keyboard.type(body);
    await page.keyboard.press('Enter');
  }
  const [first, second] = (await annotations(page)).sort((x, y) => x.body.localeCompare(y.body));
  await page.keyboard.press('Tab');
  await expect(page.getByTestId(`row-${first!.id}`)).toHaveClass(/focused/);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId(`row-${second!.id}`)).toHaveClass(/focused/);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId(`row-${first!.id}`)).toHaveClass(/focused/);
  await page.keyboard.press('Alt+r');
  expect((await annotations(page)).find((a) => a.id === first!.id)!.side).toBe('right');
  await page.keyboard.press('Alt+r');
  expect((await annotations(page)).find((a) => a.id === first!.id)!.side).toBe('auto');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible();
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  expect((await annotations(page)).find((a) => a.id === first!.id)!.body).toBe('A!');
});

test('the @ picker inserts a reference to another comment', async ({ page }) => {
  await selectQuote(page, 1, 'differentiable on its');
  await page.keyboard.type('Target');
  await page.keyboard.press('Enter');
  await selectQuote(page, 1, 'general one is not');
  await page.keyboard.type('See @');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Target');
  await page.waitForTimeout(150); // the picker ignores Enter for a moment after it opens
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const all = await annotations(page);
  const target = all.find((a) => a.body === 'Target')!;
  expect(all.find((a) => a.id !== target.id)!.body).toBe(`See \\ref{${target.id}}`);
  // Rendered as the target's display number, not "??".
  await expect(page.getByTestId('overlay-1').locator('text', { hasText: '??' })).toHaveCount(0);
});
