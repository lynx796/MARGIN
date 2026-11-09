<script lang="ts">
  import { quadsForRange, toOutputRect, type FontKey, type GlyphRunPrim, type PageGeometry, type PageLayout, type Prim, type Rect } from '@margin/core';
  import { app } from '../lib/state.svelte.ts';

  // The page's display list as SVG (spec §7.1). Screen and export render the same primitives from the
  // same layout; glyph runs carry one x per character so positions match the PDF exactly.

  let { g, layout }: { g: PageGeometry; layout: PageLayout | undefined } = $props();

  const FONTS: Record<FontKey, { family: string; weight: number; style: string }> = {
    sans: { family: "'Fira Sans'", weight: 400, style: 'normal' },
    'sans-italic': { family: "'Fira Sans'", weight: 400, style: 'italic' },
    'sans-bold': { family: "'Fira Sans'", weight: 600, style: 'normal' },
    'sans-bolditalic': { family: "'Fira Sans'", weight: 600, style: 'italic' },
    mono: { family: "'Fira Mono'", weight: 400, style: 'normal' },
  };

  function xs(p: GlyphRunPrim): string {
    let x = p.x;
    const out: number[] = [];
    for (const a of p.advances) {
      out.push(Math.round(x * 1000) / 1000);
      x += a;
    }
    return out.join(' ');
  }

  function dash(d: number[] | undefined): string | undefined {
    return d ? d.join(' ') : undefined;
  }

  const under = $derived((layout?.prims ?? []).filter((p) => p.layer === 'under'));
  const over = $derived((layout?.prims ?? []).filter((p) => p.layer === 'over' && !(p.role === 'box' && p.id === app.editingId)));
  const items = $derived(layout?.items ?? []);
  const focused = $derived(app.focusedId ? items.find((i) => i.id === app.focusedId) : undefined);
  const focusedAnn = $derived(app.annotation(app.focusedId));

  /**
   * Agent comments a human has not accepted yet: dashed outline and an "AI" badge (spec §9.4). They are
   * drawn here only, on top of the display list, so they never reach the export.
   */
  const agentMarks = $derived(
    items
      .filter((i) => app.isUnreviewed(i.id))
      .map((i) => {
        const frame = i.box ?? (i.anchor[0] ? ([i.anchor[0][0], i.anchor[0][1], i.anchor[0][2] - i.anchor[0][0], i.anchor[0][3] - i.anchor[0][1]] as const) : null);
        return frame ? { id: i.id, boxed: !!i.box, frame, anchors: i.box ? [] : i.anchor, color: app.category(app.annotation(i.id)?.category ?? '')?.color ?? '#888' } : null;
      })
      .filter((m) => m !== null),
  );

  /** In-progress selection, drawn from the same character boxes that will be stored. */
  const pendingRects = $derived.by((): Rect[] => {
    const p = app.pending;
    if (!p || p.page !== g.page) return [];
    if (p.kind === 'region') return [toOutputRect(g, [Math.min(p.x0, p.x1), Math.min(p.y0, p.y1), Math.max(p.x0, p.x1), Math.max(p.y0, p.y1)])];
    const t = app.textOf(g.page);
    if (!t) return [];
    const lo = Math.min(p.from, p.to);
    const hi = Math.max(p.from, p.to);
    return hi > lo ? quadsForRange(t, lo, hi).map((q) => toOutputRect(g, q)) : [];
  });
  const pendingIsRegion = $derived(app.pending?.kind === 'region');

  const searchRects = $derived.by(() => {
    const out: { rect: Rect; current: boolean }[] = [];
    app.searchHits.forEach((h, i) => {
      if (h.kind === 'text' && h.page === g.page) for (const q of h.quads) out.push({ rect: toOutputRect(g, q), current: i === app.searchIndex });
    });
    return out;
  });

  const handles = $derived.by(() => {
    if (!focused || !focusedAnn || app.editingId || focusedAnn.anchor.type !== 'text') return [];
    const first = focused.anchor[0];
    const last = focused.anchor[focused.anchor.length - 1];
    if (!first || !last) return [];
    return [
      { which: 'start', x: first[0], y: first[3] },
      { which: 'end', x: last[2], y: last[3] },
    ];
  });

</script>

{#snippet prim(p: Prim)}
  {#if p.type === 'rect'}
    <rect
      x={p.x}
      y={p.y}
      width={p.w}
      height={p.h}
      rx={p.radius}
      fill={p.fill ?? 'none'}
      fill-opacity={p.fillOpacity}
      stroke={p.stroke}
      stroke-width={p.stroke ? (p.strokeWidth ?? 1) : undefined}
      stroke-dasharray={dash(p.dash)}
      style={p.blend === 'multiply' ? 'mix-blend-mode: multiply' : undefined}
    />
  {:else if p.type === 'path'}
    <path d={p.d} fill="none" stroke={p.stroke} stroke-width={p.strokeWidth} stroke-dasharray={dash(p.dash)} stroke-linecap={p.lineCap ?? 'butt'} />
  {:else if p.type === 'glyphRun'}
    <text
      x={xs(p)}
      y={p.y}
      fill={p.color}
      font-size={p.size}
      font-family={FONTS[p.font].family}
      font-weight={FONTS[p.font].weight}
      font-style={FONTS[p.font].style}
      xml:space="preserve"
      style="white-space: pre; font-kerning: none; font-variant-ligatures: none; text-rendering: geometricPrecision">{p.text}</text>
  {:else}
    <g transform="translate({p.x} {p.y}) scale({p.scale})" fill={p.color}>
      {#each p.paths as d}<path {d} />{/each}
    </g>
  {/if}
{/snippet}

<!-- Highlights are multiplied into the page below the text, like in the export. -->
<svg class="layer under" width={g.outWidth * app.zoom} height={g.outHeight * app.zoom} viewBox="0 0 {g.outWidth} {g.outHeight}" aria-hidden="true">
  {#each pendingRects as r}
    {#if !pendingIsRegion}
      <rect x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill="#3b82f6" fill-opacity="0.28" style="mix-blend-mode: multiply" />
    {/if}
  {/each}
  {#each searchRects as s}
    <rect x={s.rect[0]} y={s.rect[1]} width={s.rect[2] - s.rect[0]} height={s.rect[3] - s.rect[1]} fill={s.current ? '#fb923c' : '#fde047'} fill-opacity="0.6" style="mix-blend-mode: multiply" />
  {/each}
  {#each under as p, i (i)}{@render prim(p)}{/each}
</svg>

<svg class="layer over" width={g.outWidth * app.zoom} height={g.outHeight * app.zoom} viewBox="0 0 {g.outWidth} {g.outHeight}" data-testid="overlay-{g.page}">
  {#each over as p, i (i)}{@render prim(p)}{/each}

  {#if pendingIsRegion}
    {#each pendingRects as r}
      <rect x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill="#3b82f6" fill-opacity="0.12" stroke="#3b82f6" stroke-width="1" stroke-dasharray="4 3" />
    {/each}
  {/if}

  {#if focused && !app.editingId}
    {#if focused.box}
      <rect class="focus-ring" x={focused.box[0] - 1.5} y={focused.box[1] - 1.5} width={focused.box[2] + 3} height={focused.box[3] + 3} rx="3" fill="none" stroke="var(--accent)" stroke-width="1.5" />
    {/if}
    {#each focused.anchor as r}
      <rect class="focus-ring" x={r[0] - 1} y={r[1] - 1} width={r[2] - r[0] + 2} height={r[3] - r[1] + 2} rx="1.5" fill="none" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 2" />
    {/each}
  {/if}

  {#each items as item (item.id)}
    {#if item.box && item.id !== app.editingId}
      <rect class="hit" data-box={item.id} x={item.box[0]} y={item.box[1]} width={item.box[2]} height={item.box[3]} fill="transparent" />
    {/if}
  {/each}

  {#each agentMarks as m (m.id)}
    <g class="agent" data-testid="agent-{m.id}">
      {#if m.boxed}
        <rect x={m.frame[0]} y={m.frame[1]} width={m.frame[2]} height={m.frame[3]} rx="2" fill="none" stroke={m.color} stroke-width="1" stroke-dasharray="3 2" />
      {:else}
        {#each m.anchors as r}<rect x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill="none" stroke={m.color} stroke-width="0.8" stroke-dasharray="3 2" />{/each}
      {/if}
      <g class="accept" data-accept={m.id} transform="translate({m.frame[0] + 2} {m.frame[1] - 5.5})">
        <title>AI comment, not reviewed yet. Click, or press Enter, to accept.</title>
        <rect width="15" height="9" rx="2.5" fill={m.color} />
        <text x="7.5" y="6.6" text-anchor="middle" font-size="6.2" font-weight="700" fill="#fff" font-family="system-ui, sans-serif">AI</text>
      </g>
    </g>
  {/each}

  {#each handles as h}
    <circle class="handle" data-handle={h.which} cx={h.x} cy={h.y} r={4.5 / app.zoom} fill="var(--accent)" stroke="white" stroke-width={1.2 / app.zoom} />
  {/each}
</svg>

<style>
  .layer {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
    /* No z-index: a stacking context would stop highlights from multiplying into the canvas. */
  }
  .over .hit,
  .over .handle,
  .over .accept {
    pointer-events: all;
  }
  .over .accept {
    cursor: pointer;
  }
  .over .hit {
    cursor: text;
  }
  .over .handle {
    cursor: ew-resize;
  }
</style>
