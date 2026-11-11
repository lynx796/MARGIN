import { expect, test, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { CSP, CSP_HEADER } from '../../bridge/src/csp.ts';
import { annotations, fixture, openFixture, selectQuote, watchErrors } from './helpers.ts';

// Spec §11 / §12.2 "Privacy" and the phase 6 gate: during a full session no request leaves the
// app's origin, and after the first visit the app works offline. Run against a deployment with
// E2E_BASE_URL=https://… pnpm test:e2e --grep privacy (the header checks then apply too).

test.use({ serviceWorkers: 'allow' });

const deployed = !!process.env.E2E_BASE_URL;
const terms = readFileSync(fixture('names', 'txt').replace('names.txt', 'terms.txt'), 'utf8');

/** Every request the browser makes in this context (pages, workers, the service worker). */
function recordRequests(context: BrowserContext): string[] {
  const urls: string[] = [];
  context.on('request', (r) => urls.push(r.url()));
  return urls;
}

function foreign(urls: string[], origin: string): string[] {
  return urls.filter((u) => !u.startsWith('blob:') && !u.startsWith('data:') && new URL(u).origin !== origin);
}

test('a full session sends no request outside the origin, and the app then works offline', async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL!).origin;
  const urls = recordRequests(context);
  const errors = watchErrors(page);

  const res = await page.goto('/?e2e');
  await expect(page.getByTestId('open-button')).toBeVisible();
  const html = await res!.text();
  expect(html).toContain('http-equiv="Content-Security-Policy"');
  expect(html).toMatch(/<script type="module"[^>]* integrity="sha384-[A-Za-z0-9+/=]+"/);
  if (deployed) {
    expect(res!.headers()['content-security-policy']).toBe(CSP_HEADER);
    expect(res!.headers()['referrer-policy']).toBe('no-referrer');
  }
  expect(await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'))).toBe(CSP);

  // Annotate with math (lazy MathJax chunks), export (worker, fonts), pseudonymize (MuPDF WASM).
  await openFixture(page, 'names');
  await selectQuote(page, 1, 'Anna');
  await page.keyboard.type('Name \\(\\sum_i x_i\\)');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await annotations(page)).length).toBe(1);

  const [exported] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  expect(exported.suggestedFilename()).toBe('names.annotated.pdf');

  await page.getByTestId('open-pseudo').click();
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  await page.getByTestId('terms').fill(terms);
  await page.getByTestId('pseudo-run').click();
  await expect(page.getByTestId('pseudo-summary')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('pseudo-confirm').check();
  await Promise.all([page.waitForEvent('download'), page.getByTestId('pseudo-download').click()]);
  await page.keyboard.press('Escape');

  await page.evaluate(() => (window as unknown as { __margin: { app: { flushSave(): Promise<void> } } }).__margin.app.flushSave());
  expect(foreign(urls, origin)).toEqual([]);

  // Offline: the service worker serves the app; the paper comes from browser storage.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('open-button')).toBeVisible();
  await page.getByTestId('recent').getByText('names.pdf').click();
  await expect(page.getByTestId('page-1')).toHaveAttribute('data-rendered', /.+/, { timeout: 30_000 });
  expect((await annotations(page))[0]!.body).toBe('Name \\(\\sum_i x_i\\)');
  await context.setOffline(false);

  expect(foreign(urls, origin)).toEqual([]);
  expect(errors).toEqual([]);
});
