<script lang="ts">
  import { app } from '../lib/state.svelte.ts';

  let input = $state<HTMLInputElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (app.searchOpen) input?.focus();
  });

  function oninput() {
    clearTimeout(timer);
    timer = setTimeout(() => void app.runSearch(input!.value), 150);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      app.clearSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (app.searchQuery !== input!.value) void app.runSearch(input!.value);
      else app.stepSearch(e.shiftKey ? -1 : 1);
    }
  }
</script>

{#if app.searchOpen}
  <div class="search" role="search">
    <input bind:this={input} value={app.searchQuery} {oninput} {onkeydown} placeholder="Search PDF text and comments" aria-label="Search" data-testid="search-input" />
    <span class="count" data-testid="search-count">{app.searchHits.length ? `${app.searchIndex + 1} / ${app.searchHits.length}` : app.searchQuery ? 'no matches' : ''}</span>
    <button onclick={() => app.stepSearch(-1)} aria-label="Previous match">↑</button>
    <button onclick={() => app.stepSearch(1)} aria-label="Next match">↓</button>
    <button onclick={() => app.clearSearch()} aria-label="Close search">✕</button>
  </div>
{/if}

<style>
  .search {
    position: absolute;
    right: 300px;
    top: 52px;
    z-index: 30;
    display: flex;
    gap: 6px;
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 8px;
    box-shadow: var(--shadow);
  }
  input {
    width: 240px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
  }
  button {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 8px;
  }
  .count {
    color: var(--muted);
    min-width: 62px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
</style>
