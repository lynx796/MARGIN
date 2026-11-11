import { expect, test, type Page } from '@playwright/test';
import { annotations, openApp, openFixture, selectQuote, watchErrors } from './helpers.ts';

// Chromium file handles (spec §2): the annotation file stays linked, is written on every change, and
// changes made to it by other programs are merged in. Playwright cannot drive the native picker, so the
// tests link a file handle from the origin private file system, which behaves like a picked file.

type Win = Window & { __linked: FileSystemFileHandle; __margin: { app: { linkFile(h: FileSystemFileHandle): Promise<void>; flushSave(): Promise<void> } } };

async function linkNewFile(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    w.__linked = await (await navigator.storage.getDirectory()).getFileHandle('linked.annot.json', { create: true });
    await w.__margin.app.linkFile(w.__linked);
  });
}

const readDisk = (page: Page) => page.evaluate(async () => JSON.parse(await (await (window as unknown as Win).__linked.getFile()).text()) as { annotations: { body: string }[] });

test('a linked annotation file is written on every change, and changes made to it appear', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await openFixture(page, 'plain');
  await linkNewFile(page);
  await expect(page.getByTestId('linked-file')).toContainText('linked.annot.json');
  expect((await readDisk(page)).annotations).toEqual([]);

  await selectQuote(page, 1, 'affine case');
  await page.keyboard.type('Mine');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await readDisk(page)).annotations.map((a) => a.body)).toEqual(['Mine']);

  // Another program (an agent, an editor) adds a comment to the file.
  await page.evaluate(async () => {
    const h = (window as unknown as Win).__linked;
    const f = JSON.parse(await (await h.getFile()).text());
    f.annotations.push({ category: 'error', body: 'From outside', origin: 'agent', anchor: { type: 'text', page: 1, quote: { exact: 'differentiable on its' } } });
    const w = await h.createWritable();
    await w.write(JSON.stringify(f));
    await w.close();
  });
  await expect.poll(async () => (await annotations(page)).map((a) => a.body).sort(), { timeout: 5000 }).toEqual(['From outside', 'Mine']);
  await expect(page.getByTestId('badge-review')).toBeVisible();

  // The handle is remembered: opening the document again reconnects to the file.
  await page.evaluate(() => (window as unknown as Win).__margin.app.flushSave());
  await page.reload();
  await page.getByTestId('recent').getByText('plain.pdf').click();
  await expect(page.getByTestId('linked-file')).toContainText('linked.annot.json');
  await expect.poll(async () => (await annotations(page)).length).toBe(2);

  // Unlinking stops the writes; the file keeps its content.
  await page.getByTestId('linked-file').click();
  await expect(page.getByTestId('linked-file')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('linking a file that already has annotations takes them over as one undo step', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'plain');
  await selectQuote(page, 1, 'affine case');
  await page.keyboard.type('Local');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await annotations(page)).length).toBe(1);

  await page.evaluate(async () => {
    const w = window as unknown as Win & { __margin: { app: { file: unknown } } };
    const f = structuredClone(w.__margin.app.file) as { annotations: { body: string }[] };
    f.annotations[0]!.body = 'On disk';
    w.__linked = await (await navigator.storage.getDirectory()).getFileHandle('existing.annot.json', { create: true });
    const out = await w.__linked.createWritable();
    await out.write(JSON.stringify(f));
    await out.close();
    await w.__margin.app.linkFile(w.__linked);
  });
  await expect.poll(async () => (await annotations(page)).map((a) => a.body)).toEqual(['On disk']);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await annotations(page)).map((a) => a.body)).toEqual(['Local']);
  // The undo is a change like any other and is written back.
  await expect.poll(async () => (await readDisk(page)).annotations.map((a) => a.body)).toEqual(['Local']);
});
