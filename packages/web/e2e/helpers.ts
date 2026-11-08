import { expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export const fixture = (name: string, ext = 'pdf') => fileURLToPath(new URL(`../../../fixtures/${name}/${name}.${ext}`, import.meta.url));

/** Collects console errors and CSP violations; tests assert none occurred. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

export async function openApp(page: Page): Promise<void> {
  await page.goto('/?e2e');
  await expect(page.getByTestId('open-button')).toBeVisible();
}

/** Open fixture PDFs (and optionally an annotation file) through the file input and wait for pages. */
export async function openFixture(page: Page, name: string, withAnnotations = false): Promise<void> {
  const files = [fixture(name), ...(withAnnotations ? [fixture(name, 'annot.json')] : [])];
  await page.getByTestId('file-input').setInputFiles(files);
  await expect(page.getByTestId('page-1')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('page-1')).toHaveAttribute('data-rendered', /.+/, { timeout: 30_000 });
}

type Api = { quoteRect(page: number, quote: string): Promise<{ x0: number; y0: number; x1: number; y1: number } | null> };

/** Drag-select the text `quote` on `page` with the mouse. */
export async function selectQuote(page: Page, pageNo: number, quote: string): Promise<void> {
  await page.getByTestId(`page-${pageNo}`).scrollIntoViewIfNeeded();
  const r = await page.evaluate(([p, q]) => (window as unknown as { __margin: Api }).__margin.quoteRect(p as number, q as string), [pageNo, quote] as const);
  if (!r) throw new Error(`quote not found: ${quote}`);
  const y = (r.y0 + r.y1) / 2;
  await page.mouse.move(r.x0 + 0.5, y);
  await page.mouse.down();
  await page.mouse.move((r.x0 + r.x1) / 2, y, { steps: 4 });
  await page.mouse.move(r.x1 - 0.5, y, { steps: 4 });
  await page.mouse.up();
}

/** Annotations of the open document, read from app state. */
export async function annotations(page: Page): Promise<{ id: string; category: string; body: string; side: string; anchor: { type: string; page: number; quote?: { exact: string }; rect?: number[] } }[]> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __margin: { app: { file: { annotations: unknown[] } } } }).__margin.app.file.annotations)));
}
