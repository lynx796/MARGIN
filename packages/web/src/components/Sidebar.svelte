<script lang="ts">
  import { app } from '../lib/state.svelte.ts';

  // All comments in reading order with number, category, first line and page; filter by category and
  // origin; click to jump (spec §7.1).

  let category = $state('');

  const rows = $derived.by(() => {
    const numbers = app.layout?.numbers ?? {};
    return app.annotations
      .filter((a) => app.category(a.category)?.kind !== 'highlight')
      .filter((a) => (!category || a.category === category) && matchesOrigin(a))
      .map((a) => ({ a, n: numbers[a.id] }))
      .sort((x, y) => (x.n ?? Infinity) - (y.n ?? Infinity) || (x.a.anchor.page ?? 0) - (y.a.anchor.page ?? 0));
  });

  function matchesOrigin(a: (typeof app.annotations)[number]): boolean {
    const f = app.originFilter;
    return !f || (f === 'unreviewed' ? app.isUnreviewed(a.id) : a.origin === f);
  }

  const onPage = $derived(app.unreviewed.filter((a) => a.anchor.page === app.currentPage).length);

  function conflictLabel(c: { local: { body: string } | null; disk: { body: string } | null }): string {
    return c.local ? `Yours: ${c.local.body || '(empty)'}` : 'You had deleted it';
  }

  function firstLine(body: string): string {
    return body.split('\n').find((l) => l.trim()) ?? '(empty)';
  }
</script>

<aside class="side" data-testid="sidebar">
  <div class="filters">
    <select bind:value={category} aria-label="Filter by category" data-testid="filter-category">
      <option value="">All categories</option>
      {#each app.categories.filter((c) => c.kind === 'comment') as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
    </select>
    <select bind:value={app.originFilter} aria-label="Filter by origin" data-testid="filter-origin">
      <option value="">Human + agent</option>
      <option value="human">Human</option>
      <option value="agent">Agent</option>
      <option value="unreviewed">Agent, unreviewed ({app.unreviewed.length})</option>
    </select>
  </div>
  {#if app.unreviewed.length}
    <div class="review" data-testid="review-bar">
      <span>{app.unreviewed.length} AI comment{app.unreviewed.length > 1 ? 's' : ''} to review</span>
      <button onclick={() => app.acceptAllOnPage(app.currentPage)} disabled={!onPage} data-testid="accept-page" title="Mark the AI comments on the page in view as reviewed">Accept all on page {app.currentPage}</button>
      <button onclick={() => app.acceptAll()} data-testid="accept-all">Accept all</button>
    </div>
  {/if}
  {#if app.conflicts.length}
    <div class="conflicts" data-testid="conflicts">
      <strong>Conflicts</strong>
      <p>These comments changed here and on disk. The disk version was kept.</p>
      <ul>
        {#each app.conflicts as c (c.id)}
          <li data-testid="conflict-{c.id}">
            <span class="ctext">{conflictLabel(c)}</span>
            <button onclick={() => app.restoreConflict(c)}>{c.local ? 'Restore mine' : 'Delete again'}</button>
            <button onclick={() => app.dismissConflict(c.id)} aria-label="Dismiss">✕</button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  <ol class="list">
    {#each rows as { a, n } (a.id)}
      {@const cat = app.category(a.category)}
      <li>
        <button class="row" class:focused={app.focusedId === a.id} style="--c:{cat?.color ?? '#888'}" onclick={() => (app.focus(a.id), app.reveal(a.id))} data-testid="row-{a.id}">
          <span class="num">{n ?? '–'}</span>
          <span class="body">
            <span class="line">{firstLine(a.body)}</span>
            <span class="meta">{cat?.name ?? a.category} · {a.anchor.page ? `p. ${a.anchor.page}` : 'no page'}{#if n === undefined} · ⚠ no anchor{/if}{#if a.origin === 'agent'} · AI{app.isUnreviewed(a.id) ? ' (to review)' : ''}{/if}</span>
          </span>
        </button>
      </li>
    {:else}
      <li class="empty">No comments yet. Select text on a page, type, and press Enter.</li>
    {/each}
  </ol>
</aside>

<style>
  .side {
    width: 280px;
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-left: 1px solid var(--border);
    min-height: 0;
  }
  .filters {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid var(--border);
  }
  select {
    flex: 1;
    min-width: 0;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 4px;
  }
  .review,
  .conflicts {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    font-size: 12px;
  }
  .conflicts {
    background: #fef3c7;
    color: #78350f;
    flex-direction: column;
    align-items: stretch;
  }
  .conflicts p {
    margin: 0;
  }
  .conflicts ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .conflicts li {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .ctext {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .review button,
  .conflicts button {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 7px;
    color: inherit;
  }
  .review button:disabled {
    opacity: 0.45;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: auto;
    flex: 1;
  }
  .row {
    display: flex;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    border-left: 3px solid var(--c);
    background: transparent;
    padding: 7px 10px 7px 8px;
    border-bottom: 1px solid var(--border);
  }
  .row:hover,
  .row.focused {
    background: color-mix(in srgb, var(--c) 12%, transparent);
  }
  .num {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    min-width: 1.5em;
    text-align: right;
  }
  .body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--muted);
    font-size: 11px;
  }
  .empty {
    padding: 16px;
    color: var(--muted);
  }
</style>
