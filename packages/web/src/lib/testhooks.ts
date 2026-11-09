import { normalizeQuote, PageIndex, quadsForRange, toOutputRect, type Rect } from '@margin/core';
import { app } from './state.svelte.ts';

// Test support, active only when the page is opened with `?e2e`: lets end-to-end tests find where text
// is on screen and read app state, without depending on rendering details.

export interface MarginTestApi {
  app: typeof app;
  /** Client-pixel rectangle of the first occurrence of `quote` on `page` (first line fragment). */
  /** Hold back (or release) writes to the bridge, to provoke merge conflicts. */
  pauseBridgeWrites(paused: boolean): void;
  quoteRect(page: number, quote: string): Promise<{ x0: number; y0: number; x1: number; y1: number } | null>;
}

export function installTestHooks(): void {
  if (!new URLSearchParams(location.search).has('e2e')) return;
  const api: MarginTestApi = {
    app,
    pauseBridgeWrites(paused) {
      app.bridgeWritesPaused = paused;
      if (!paused) void app.flushSave();
    },
    async quoteRect(page, quote) {
      const text = await app.ensureText(page);
      const [m] = new PageIndex(text).find(normalizeQuote(quote));
      const g = app.geometry?.pages[page - 1];
      const el = document.querySelector(`[data-page="${page}"]`);
      if (!m || !g || !el) return null;
      const quad = quadsForRange(text, m.start, m.end)[0] as Rect;
      const r = toOutputRect(g, quad);
      const box = el.getBoundingClientRect();
      return { x0: box.left + r[0] * app.zoom, y0: box.top + r[1] * app.zoom, x1: box.left + r[2] * app.zoom, y1: box.top + r[3] * app.zoom };
    },
  };
  (window as unknown as { __margin: MarginTestApi }).__margin = api;
}
