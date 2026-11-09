<script lang="ts">
  import { rangeForQuads, toOriginal, type PageGeometry, type PageLayout, type Rect } from '@margin/core';
  import { onMount } from 'svelte';
  import { caretAt, mostlySymbols, normalizeRect, rangeBetween, rectContains, textAnchorFor } from '../lib/selection.ts';
  import { app } from '../lib/state.svelte.ts';
  import CommentEditor from './CommentEditor.svelte';
  import Overlay from './Overlay.svelte';

  let { g, layout }: { g: PageGeometry; layout: PageLayout | undefined } = $props();

  let el: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let visible = $state(false);

  const w = $derived(g.outWidth * app.zoom);
  const h = $derived(g.outHeight * app.zoom);
  const editingItem = $derived(app.editingId ? layout?.items.find((i) => i.id === app.editingId) : undefined);

  // ── Rendering ───────────────────────────────────────────────────────────────────────────────
  // The original page is drawn with transform T of spec §5.4: scale s, offset by the crop and centering.

  onMount(() => {
    const io = new IntersectionObserver(([entry]) => (visible = entry!.isIntersecting), { rootMargin: '150% 0px' });
    io.observe(el);
    return () => io.disconnect();
  });

  $effect(() => {
    const pdf = app.pdf;
    const geo = g;
    const zoom = app.zoom;
    if (!pdf) return;
    if (!visible) {
      canvas.width = 0;
      return;
    }
    void app.ensureText(geo.page);
    let cancelled = false;
    let task: { promise: Promise<unknown>; cancel(): void } | undefined;
    (async () => {
      const page = await pdf.page(geo.page);
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const k = zoom * dpr;
      const W = Math.round(geo.outWidth * k);
      const H = Math.round(geo.outHeight * k);
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const ctx = off.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      const viewport = page.getViewport({ scale: geo.s * k, offsetX: (geo.ox - geo.s * (geo.cropX0 - geo.padding)) * k, offsetY: geo.oy * k });
      task = page.render({ canvas: off, canvasContext: ctx, viewport } as never) as unknown as typeof task;
      await task!.promise;
      if (cancelled) return;
      // Nothing outside the crop is shown (the export clips to it as well).
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, geo.ox * k, H);
      ctx.fillRect((geo.ox + geo.s * geo.t) * k, 0, W, H);
      canvas.width = W;
      canvas.height = H;
      canvas.getContext('2d')!.drawImage(off, 0, 0);
      el.dataset.rendered = String(zoom);
    })().catch((e) => {
      if (e?.name !== 'RenderingCancelledException' && !cancelled) console.error(e);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  });

  // ── Pointer interaction ─────────────────────────────────────────────────────────────────────

  type Drag =
    | { mode: 'text'; from: number; moved: boolean; sx: number; sy: number }
    | { mode: 'region'; x0: number; y0: number; moved: boolean; sx: number; sy: number }
    | { mode: 'box'; id: string; moved: boolean; sx: number; sy: number }
    | { mode: 'handle'; id: string; which: 'start' | 'end'; fixed: number; moved: boolean; sx: number; sy: number };

  let drag: Drag | null = null;

  /** Pointer position in output-page points. */
  function outPoint(e: PointerEvent): [number, number] {
    const r = el.getBoundingClientRect();
    return [(e.clientX - r.left) / app.zoom, (e.clientY - r.top) / app.zoom];
  }

  async function onpointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const [ox, oy] = outPoint(e);
    const [x, y] = toOriginal(g, ox, oy);
    const base = { moved: false, sx: e.clientX, sy: e.clientY };
    const accept = target.closest<SVGElement>('[data-accept]');
    if (accept) {
      app.acceptComment(accept.dataset.accept!);
      app.focus(accept.dataset.accept!);
      e.preventDefault();
      return;
    }
    const handle = target.closest<SVGElement>('[data-handle]');
    const boxEl = target.closest<SVGElement>('[data-box]');
    if (handle && app.focusedId) {
      const which = handle.dataset.handle as 'start' | 'end';
      const t = app.textOf(g.page);
      const a = app.annotation(app.focusedId);
      const quads = a?.anchor.type === 'text' ? a.anchor.quads : undefined;
      const range = t && quads ? rangeForQuads(t, quads) : null;
      if (!range) return;
      drag = { mode: 'handle', id: app.focusedId, which, fixed: which === 'start' ? range[1] : range[0], ...base };
    } else if (boxEl) {
      drag = { mode: 'box', id: boxEl.dataset.box!, ...base };
    } else if (e.altKey) {
      drag = { mode: 'region', x0: x, y0: y, ...base };
    } else {
      const t = app.textOf(g.page) ?? (await app.ensureText(g.page));
      drag = { mode: 'text', from: caretAt(t, x, y), ...base };
    }
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onpointermove(e: PointerEvent) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
    drag.moved = true;
    const [ox, oy] = outPoint(e);
    const [x, y] = toOriginal(g, ox, oy);
    const t = app.textOf(g.page);
    if (drag.mode === 'text' && t) {
      app.pending = { kind: 'text', page: g.page, from: drag.from, to: caretAt(t, x, y) };
    } else if (drag.mode === 'region') {
      app.pending = { kind: 'region', page: g.page, x0: drag.x0, y0: drag.y0, x1: x, y1: y };
    } else if (drag.mode === 'handle' && t) {
      const a = app.annotation(drag.id);
      if (a?.anchor.type !== 'text') return;
      const range = rangeBetween(t, caretAt(t, x, y), drag.fixed);
      if (range) app.setAnchorOverride({ id: drag.id, anchor: { ...a.anchor, ...textAnchorFor(t, range[0], range[1]) } });
    }
  }

  function onpointerup(e: PointerEvent) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const [ox, oy] = outPoint(e);
    const [x, y] = toOriginal(g, ox, oy);
    const t = app.textOf(g.page);

    if (d.mode === 'box') {
      app.focus(d.id);
      if (!d.moved) app.startEdit(d.id);
      return;
    }
    if (d.mode === 'handle') {
      const over = app.anchorOverride;
      if (over) app.commitAnchor(over.id, over.anchor);
      return;
    }
    const pending = app.pending;
    app.pending = null;
    if (!d.moved) {
      // A click: focus the annotation under the pointer, else clear the focus.
      const hit = layout?.items.filter((i) => i.anchor.some((r) => rectContains(r as Rect, ox, oy, 1.5))).at(-1);
      app.focus(hit?.id ?? null);
      return;
    }
    if (d.mode === 'region' && pending?.kind === 'region') {
      const rect = normalizeRect(pending.x0, pending.y0, pending.x1, pending.y1);
      if (rect[2] - rect[0] < 3 || rect[3] - rect[1] < 3) return;
      app.createFromAnchor({ type: 'region', page: g.page, rect });
      return;
    }
    if (d.mode === 'text' && t) {
      const range = rangeBetween(t, d.from, caretAt(t, x, y));
      if (!range) return;
      const anchor = textAnchorFor(t, range[0], range[1]);
      if (mostlySymbols(anchor.quote?.exact ?? '')) hintRegion();
      app.createFromAnchor(anchor);
    }
  }

  function hintRegion() {
    try {
      if (localStorage.getItem('margin.hint.region')) return;
      localStorage.setItem('margin.hint.region', '1');
    } catch {
      /* storage may be unavailable; show the hint anyway */
    }
    app.toast('This looks like a formula. Hold Alt and drag to select a rectangle instead.', 'info', 7000);
  }
</script>

<div
  class="page"
  bind:this={el}
  data-page={g.page}
  data-testid="page-{g.page}"
  style="width:{w}px; height:{h}px"
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={() => {
    drag = null;
    app.pending = null;
    app.setAnchorOverride(null);
  }}
  role="presentation"
>
  <canvas bind:this={canvas} style="width:{w}px; height:{h}px"></canvas>
  <Overlay {g} {layout} />
  {#if editingItem?.box}
    <CommentEditor box={editingItem.box} fontSize={layout?.fontSize ?? 9} number={app.numberOf(app.editingId!)} />
  {/if}
  <span class="label">{g.page}</span>
</div>

<style>
  .page {
    position: relative;
    background: #fff;
    box-shadow: var(--shadow);
    margin: 0 auto 16px;
    cursor: text;
    user-select: none;
    touch-action: none;
  }
  canvas {
    position: absolute;
    left: 0;
    top: 0;
    display: block;
  }
  .label {
    position: absolute;
    right: -30px;
    top: 0;
    font-size: 11px;
    color: var(--muted);
  }
</style>
