import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotations, fixture, selectQuote, watchErrors } from './helpers.ts';

// Phase 3: `margin serve` hosts the app and the bridge; the CLI plays the agent. Every test starts
// its own bridge on a free port in a temporary directory.

const CLI = fileURLToPath(new URL('../../cli/bin/margin.js', import.meta.url));

interface Serve {
  dir: string;
  url: string;
  origin: string;
  token: string;
  stop(): void;
  /** Run the margin CLI like an agent would, in the served directory. */
  margin(...args: string[]): string;
  annot(): { annotations: { id: string; body: string; origin: string; reviewed?: boolean; category: string }[] };
}

async function serve(extra: string[] = [], init = true): Promise<Serve> {
  const dir = mkdtempSync(join(tmpdir(), 'margin-e2e-'));
  copyFileSync(fixture('plain'), join(dir, 'paper.pdf'));
  const child: ChildProcess = spawn('node', [CLI, 'serve', '--dir', dir, '--port', '0', '--json', ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  const info = await new Promise<{ url: string; origin: string; token: string }>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (d) => {
      out += d;
      try {
        resolve(JSON.parse(out));
      } catch {
        /* incomplete JSON */
      }
    });
    child.once('exit', (c) => reject(new Error(`margin serve exited with ${c}`)));
  });
  if (init) execFileSync('node', [CLI, 'init', 'paper.pdf'], { cwd: dir });
  return {
    dir,
    ...info,
    stop() {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
    margin: (...args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8' }),
    annot: () => JSON.parse(readFileSync(join(dir, 'paper.annot.json'), 'utf8')),
  };
}

let s: Serve;
test.beforeEach(async () => {
  s = await serve();
});
test.afterEach(() => s.stop());

async function openThroughBridge(page: Page, url = s.url): Promise<void> {
  await page.goto(url.replace('/#', '/?e2e#'));
  await page.getByTestId('bridge-file').first().click();
  await expect(page.getByTestId('page-1')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('page-1')).toHaveAttribute('data-rendered', /.+/, { timeout: 30_000 });
}

const bodies = (page: Page) => annotations(page).then((as) => as.map((a) => a.body));

test('serves the app, lists the directory and opens a PDF; the token leaves the address bar', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(s.url.replace('/#', '/?e2e#'));
  await expect(page.getByTestId('bridge-panel')).toContainText('paper.pdf');
  expect(page.url()).not.toContain('token');
  await page.getByTestId('bridge-file').first().click();
  await expect(page.getByTestId('page-1')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('bridge-status')).toContainText('bridge');
  expect(errors).toEqual([]);
});

test('agent comments appear live within a second, flagged as AI, and can be accepted', async ({ page }) => {
  await openThroughBridge(page);
  expect(await annotations(page)).toHaveLength(0);

  s.margin('add', 'paper.pdf', '--page', '1', '--quote', 'differentiable on its', '--category', 'error', '--body', 'Agent: not shown.');
  const t0 = Date.now();
  await expect.poll(async () => (await annotations(page)).length, { timeout: 4000 }).toBe(1);
  expect(Date.now() - t0).toBeLessThan(1500);

  const [a] = await annotations(page);
  await expect(page.getByTestId(`agent-${a!.id}`)).toBeVisible();
  await expect(page.getByTestId('overlay-1').locator('text', { hasText: 'Agent: not shown.' })).toBeVisible();
  await expect(page.getByTestId('badge-review')).toContainText('1 AI comment');
  await expect(page.getByTestId(`row-${a!.id}`)).toContainText('AI (to review)');

  // Click the badge to accept; the mark disappears and the file records the review.
  await page.getByTestId(`agent-${a!.id}`).locator('[data-accept]').click();
  await expect(page.getByTestId(`agent-${a!.id}`)).toHaveCount(0);
  await expect(page.getByTestId('badge-review')).toHaveCount(0);
  await expect.poll(() => s.annot().annotations[0]?.reviewed).toBe(true);
});

test('agent changes are one labeled undo step, and undoing them reaches the disk', async ({ page }) => {
  await openThroughBridge(page);
  s.margin('add', 'paper.pdf', '--page', '1', '--quote', 'affine case', '--category', 'remark', '--body', 'One.');
  await expect.poll(async () => (await annotations(page)).length).toBe(1);
  s.margin('add', 'paper.pdf', '--page', '1', '--quote', 'fluffy', '--category', 'typo', '--body', 'Two.');
  await expect.poll(async () => (await annotations(page)).length).toBe(2);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /Undo agent: \+1 comment/);

  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await annotations(page)).length).toBe(1);
  await expect.poll(() => s.annot().annotations.map((a) => a.body)).toEqual(['One.']);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => s.annot().annotations.map((a) => a.body).sort()).toEqual(['One.', 'Two.']);
});

test('accept all on page, Enter on a focused agent comment, and the unreviewed filter', async ({ page }) => {
  await openThroughBridge(page);
  const ops = [
    { op: 'add', page: 1, quote: 'differentiable on its', category: 'error', body: 'A' },
    { op: 'add', page: 1, quote: 'affine case', category: 'remark', body: 'B' },
    { op: 'add', page: 2, quote: 'The map f', category: 'good', body: 'C' },
  ];
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(s.dir, 'ops.json'), JSON.stringify(ops));
  s.margin('apply', 'ops.json', 'paper.pdf');
  await expect.poll(async () => (await annotations(page)).length).toBe(3);
  await expect(page.getByTestId('badge-review')).toContainText('3 AI');

  await page.getByTestId('filter-origin').selectOption('unreviewed');
  await expect(page.getByTestId('sidebar').locator('li button.row')).toHaveCount(3);

  // Enter on a focused agent comment accepts it; a second Enter would edit it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('badge-review')).toContainText('2 AI');
  await expect(page.getByTestId('comment-editor')).toHaveCount(0);

  // Page 1 is in view: accept all there leaves only the page 2 comment.
  await page.getByTestId('accept-page').click();
  await expect(page.getByTestId('badge-review')).toContainText('1 AI');
  await expect.poll(() => s.annot().annotations.filter((a) => !a.reviewed).map((a) => a.body)).toEqual(['C']);
});

test('human changes are written to the annotation file on disk, creating it if there is none', async ({ page }) => {
  s.stop();
  s = await serve([], false);
  await openThroughBridge(page);
  expect(existsSync(join(s.dir, 'paper.annot.json'))).toBe(false);
  await selectQuote(page, 1, 'differentiable on its');
  await page.keyboard.type('Why differentiable?');
  await page.keyboard.press('Enter');
  await expect.poll(() => (existsSync(join(s.dir, 'paper.annot.json')) ? s.annot().annotations.map((a) => [a.body, a.origin]) : [])).toEqual([['Why differentiable?', 'human']]);
  expect(s.margin('list', 'paper.pdf')).toContain('Why differentiable?');
});

test('a change on disk and an unsaved local change to one comment: disk wins, mine is restorable', async ({ page }) => {
  await openThroughBridge(page);
  s.margin('add', 'paper.pdf', '--page', '1', '--quote', 'affine case', '--category', 'remark', '--body', 'Original.');
  await expect.poll(async () => (await annotations(page)).length).toBe(1);
  const [a] = await annotations(page);
  await page.evaluate(() => (window as any).__margin.pauseBridgeWrites(true));

  // Unsaved local edit …
  await page.evaluate((id) => {
    const app = (window as any).__margin.app;
    app.startEdit(id);
    app.setDraftBody('My text.');
    app.commitEdit();
  }, a!.id);
  expect(await bodies(page)).toEqual(['My text.']);
  // … while the agent edits the same comment on disk.
  s.margin('edit', a!.id, 'paper.pdf', '--body', 'Agent text.');

  await expect(page.getByTestId(`conflict-${a!.id}`)).toBeVisible();
  expect(await bodies(page)).toEqual(['Agent text.']);
  await page.getByTestId(`conflict-${a!.id}`).getByRole('button', { name: 'Restore mine' }).click();
  expect(await bodies(page)).toEqual(['My text.']);
  await expect(page.getByTestId(`conflict-${a!.id}`)).toHaveCount(0);

  await page.evaluate(() => (window as any).__margin.pauseBridgeWrites(false));
  await expect.poll(() => s.annot().annotations.map((x) => x.body)).toEqual(['My text.']);
});

test('disjoint local and disk changes merge without conflict', async ({ page }) => {
  await openThroughBridge(page);
  await page.evaluate(() => (window as any).__margin.pauseBridgeWrites(true));
  await selectQuote(page, 1, 'differentiable on its');
  await page.keyboard.type('Mine.');
  await page.keyboard.press('Enter');
  s.margin('add', 'paper.pdf', '--page', '1', '--quote', 'affine case', '--category', 'remark', '--body', 'Theirs.');
  await expect.poll(async () => (await bodies(page)).sort()).toEqual(['Mine.', 'Theirs.']);
  await expect(page.getByTestId('conflicts')).toHaveCount(0);
  await page.evaluate(() => (window as any).__margin.pauseBridgeWrites(false));
  await expect.poll(() => s.annot().annotations.map((x) => x.body).sort()).toEqual(['Mine.', 'Theirs.']);
});

test('an app opened from another origin works with --allow-origin (CORS and preflight in a real browser)', async ({ page, baseURL }) => {
  s.stop();
  s = await serve(['--allow-origin', baseURL!]);
  const errors = watchErrors(page);
  await page.goto(`/?e2e&bridge=${encodeURIComponent(s.origin)}#token=${s.token}`);
  await page.getByTestId('bridge-file').first().click();
  await expect(page.getByTestId('page-1')).toBeVisible({ timeout: 30_000 });
  s.margin('add', 'paper.pdf', '--page', '1', '--quote', 'affine case', '--category', 'remark', '--body', 'Cross-origin.');
  await expect.poll(async () => (await bodies(page))).toEqual(['Cross-origin.']);
  await selectQuote(page, 1, 'fluffy');
  await page.keyboard.type('Back to disk.');
  await page.keyboard.press('Enter');
  await expect.poll(() => s.annot().annotations.map((a) => a.body).sort()).toEqual(['Back to disk.', 'Cross-origin.']);
  expect(errors).toEqual([]);
});

test('a wrong token is refused with a message', async ({ page }) => {
  await page.goto(`/?e2e#token=${'0'.repeat(48)}`);
  await page.goto(s.url.replace('/#', '/?e2e#').replace(/token=.*/, `token=${'0'.repeat(48)}`));
  await expect(page.locator('.toast.error')).toContainText('refused the token');
  await expect(page.getByTestId('bridge-panel')).toHaveCount(0);
});

test('pasting the URL connects; another origin needs --allow-origin and the error says so', async ({ page, baseURL }) => {
  await page.goto('/?e2e');
  await page.getByTestId('bridge-url').fill('not a url');
  await page.getByTestId('bridge-connect').click();
  await expect(page.getByText('Paste the URL printed by margin serve')).toBeVisible();
  await page.getByTestId('bridge-url').fill(s.url);
  await page.getByTestId('bridge-connect').click();
  await expect(page.locator('.toast.error')).toContainText('--allow-origin');
  await expect(page.getByTestId('bridge-panel')).toHaveCount(0);

  s.stop();
  s = await serve(['--allow-origin', baseURL!]);
  await page.getByTestId('bridge-url').fill(s.url);
  await page.getByTestId('bridge-connect').click();
  await expect(page.getByTestId('bridge-panel')).toContainText('paper.pdf');
});

test('export warns about unreviewed agent comments and leaves the AI marks out of the PDF', async ({ page }) => {
  await openThroughBridge(page);
  s.margin('add', 'paper.pdf', '--page', '1', '--quote', 'affine case', '--category', 'remark', '--body', 'Unreviewed.');
  await expect.poll(async () => (await annotations(page)).length).toBe(1);
  const download = page.waitForEvent('download');
  await page.getByTestId('export').click();
  await expect(page.locator('.toast.warn')).toContainText('1 agent comment is not reviewed yet');
  const path = await (await download).path();
  const pdf = readFileSync(path).toString('latin1');
  expect(pdf.startsWith('%PDF-')).toBe(true);
  // The annotation file travels along; the badge text exists only in the screen overlay.
  expect(pdf).not.toContain('not reviewed yet');
});
