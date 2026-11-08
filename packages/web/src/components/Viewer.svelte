<script lang="ts">
  import { app } from '../lib/state.svelte.ts';
  import PageView from './PageView.svelte';

  // Continuous vertical page view (spec §7.1): every page shows the enlarged output page, so what you
  // see is what the export contains.

  let scroller: HTMLDivElement;
  let raf = 0;

  $effect(() => {
    const t = app.scrollTarget;
    if (!t || !scroller) return;
    const page = scroller.querySelector<HTMLElement>(`[data-page="${t.page}"]`);
    if (!page) return;
    const top = page.offsetTop + t.y * app.zoom - scroller.clientHeight * 0.3;
    scroller.scrollTo({ top: Math.max(0, top) });
  });

  function onscroll() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const mid = scroller.scrollTop + scroller.clientHeight / 2;
      let current = 1;
      for (const el of scroller.querySelectorAll<HTMLElement>('[data-page]')) {
        if (el.offsetTop <= mid) current = Number(el.dataset.page);
      }
      app.currentPage = current;
    });
  }

  // The first measured width after opening a document decides the "fit width" zoom.
  $effect(() => {
    const width = app.viewerWidth;
    if (app.fitPending && scroller && width > 0 && app.geometry) {
      app.fitPending = false;
      app.setZoom(app.fitZoom());
    }
  });

  // Keep the page centered when zooming: preserve the scroll position relative to the document.
  let lastZoom = app.zoom;
  $effect(() => {
    const z = app.zoom;
    if (!scroller || z === lastZoom) return;
    const ratio = z / lastZoom;
    scroller.scrollTop = (scroller.scrollTop + scroller.clientHeight / 2) * ratio - scroller.clientHeight / 2;
    lastZoom = z;
  });
</script>

<div class="viewer" bind:this={scroller} bind:clientWidth={app.viewerWidth} {onscroll} data-testid="viewer">
  {#if app.geometry}
    <div class="pages">
      {#each app.geometry.pages as g (g.page)}
        <PageView {g} layout={app.layout?.pages.find((p) => p.page === g.page)} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .viewer {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 20px 36px 60px 12px;
    background: var(--bg);
  }
  .pages {
    width: max-content;
    min-width: 100%;
  }
</style>
