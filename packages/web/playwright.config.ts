import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the production build (with the CSP of spec §11) in Chromium and Firefox.
// E2E_BASE_URL runs them against a deployed copy instead (phase 6 gate: `privacy.spec.ts` there).
const deployed = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  // Service workers are blocked except in the tests about offline use, so cached assets never mask a build.
  use: { baseURL: deployed ?? 'http://localhost:4173', trace: 'retain-on-failure', acceptDownloads: true, serviceWorkers: 'block' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 950 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1500, height: 950 } } },
  ],
  ...(deployed
    ? {}
    : {
        webServer: {
          command: 'pnpm build && pnpm preview',
          url: 'http://localhost:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      }),
});
