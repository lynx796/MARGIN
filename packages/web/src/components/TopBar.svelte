<script lang="ts">
  import { app } from '../lib/state.svelte.ts';

  let adding = $state(false);
  let newName = $state('');
  let newColor = $state('#8b5cf6');
  let newKind = $state<'comment' | 'highlight'>('comment');

  function addCategory(e: SubmitEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const id = app.addCategory({ name: newName.trim(), color: newColor, kind: newKind, weight: newKind === 'highlight' ? 0 : 1 });
    app.setActiveCategory(id);
    newName = '';
    adding = false;
  }

  const badges = $derived([
    { key: 'unresolved', n: app.unplaced.length, text: (n: number) => `${n} unresolved anchor${n > 1 ? 's' : ''}`, tip: 'Annotations whose quote was not found or is ambiguous' },
    { key: 'overflow', n: app.overflowPages.length, text: (n: number) => `${n} page${n > 1 ? 's' : ''} overflow`, tip: 'Some comments were moved to notes pages (smaller type did not fit them)' },
    { key: 'review', n: app.unreviewed.length, text: (n: number) => `${n} AI comment${n > 1 ? 's' : ''} to review`, tip: 'Agent comments not yet accepted; click to list them' },
    { key: 'math', n: app.mathErrorCount, text: (n: number) => `${n} math error${n > 1 ? 's' : ''}`, tip: 'TeX errors in comments (shown in red)' },
  ].filter((b) => b.n > 0));
</script>

<header class="bar">
  <button class="home" title="Back to start screen" onclick={() => app.closeDocument()} aria-label="Close document">←</button>
  <span class="name" title={app.fileName} data-testid="file-name">{app.fileName}</span>

  <div class="chips" role="group" aria-label="Categories">
    {#each app.categories as c, i (c.id)}
      <div class="chip" class:active={app.activeCategory === c.id} style="--c:{c.color}" data-testid="chip-{c.id}">
        <label class="swatch" title="Change color">
          <input type="color" value={c.color} onchange={(e) => app.updateCategory(c.id, { color: e.currentTarget.value })} aria-label="Color of {c.name}" />
        </label>
        <button class="label" onclick={() => app.setActiveCategory(c.id)} aria-pressed={app.activeCategory === c.id} title="{c.name} ({c.kind}) — key {i + 1}">
          <kbd>{i < 9 ? i + 1 : ''}</kbd>{c.name}
        </button>
      </div>
    {/each}
    <div class="add">
      <button class="chip-add" title="Add a category" aria-expanded={adding} onclick={() => (adding = !adding)} data-testid="chip-add">+</button>
      {#if adding}
        <form class="pop" onsubmit={addCategory}>
          <input placeholder="Name" bind:value={newName} aria-label="Category name" data-testid="new-category-name" />
          <input type="color" bind:value={newColor} aria-label="Color" />
          <select bind:value={newKind} aria-label="Kind">
            <option value="comment">comment</option>
            <option value="highlight">highlight</option>
          </select>
          <button type="submit" data-testid="new-category-add">Add</button>
        </form>
      {/if}
    </div>
  </div>

  <div class="spacer"></div>

  {#if app.bridge}
    <span class="bridge" class:offline={!app.bridge.online} title={app.bridge.online ? `Connected to margin serve (${app.bridge.dir}); changes are saved to disk and agent changes appear live` : 'Connection to margin serve lost; retrying'} data-testid="bridge-status">
      {app.bridge.online ? '● bridge' : '○ bridge offline'}
    </span>
  {/if}

  {#if app.linkedFile}
    <button class="bridge linked" title="Changes are written to {app.linkedFile}, and changes made to it by other programs appear here. Click to stop." onclick={() => app.unlinkFile()} data-testid="linked-file">● {app.linkedFile}</button>
  {:else if app.reconnectable}
    <button class="bridge offline linked" title="Allow access again to keep {app.reconnectable.name} in sync" onclick={() => app.reconnectFile()} data-testid="reconnect-file">○ Reconnect {app.reconnectable.name}</button>
  {/if}

  {#each badges as b (b.key)}
    {#if b.key === 'review'}
      <button class="badge review" title={b.tip} data-testid="badge-review" onclick={() => ((app.originFilter = 'unreviewed'), (app.sidebarOpen = true))}>{b.text(b.n)}</button>
    {:else}
      <span class="badge" title={b.tip} data-testid="badge-{b.key}">⚠ {b.text(b.n)}</span>
    {/if}
  {/each}

  <div class="group">
    <button onclick={() => app.undo()} disabled={!app.canUndo} title={app.undoLabel ? `Undo ${app.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} aria-label="Undo" data-testid="undo">↶</button>
    <button onclick={() => app.redo()} disabled={!app.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
  </div>
  <div class="group" role="group" aria-label="Zoom">
    <button onclick={() => app.setZoom(app.zoom / 1.15)} title="Zoom out" aria-label="Zoom out">−</button>
    <button class="zoomval" onclick={() => app.setZoom(app.fitZoom())} title="Fit width" data-testid="zoom">{Math.round(app.zoom * 100)}%</button>
    <button onclick={() => app.setZoom(app.zoom * 1.15)} title="Zoom in" aria-label="Zoom in">+</button>
  </div>
  <button onclick={() => (app.searchOpen = !app.searchOpen)} title="Search (Ctrl+F)" aria-label="Search">🔍</button>
  {#if app.pseudoMap}
    <button onclick={() => app.restoreToOriginal()} title="This is a pseudonymized copy: copy its comments to the original PDF and open that" data-testid="restore-original">Transfer to original</button>
  {:else}
    <button onclick={() => (app.pseudoOpen = true)} title="Make a copy with names replaced by tokens, e.g. for an AI agent" data-testid="open-pseudo">Pseudonymize…</button>
  {/if}
  <button onclick={() => app.downloadAnnotations()} title="Download the annotation file (Ctrl+S)" data-testid="save-annotations">Save annotations</button>
  <button class="primary" onclick={() => app.exportPdf()} disabled={app.exporting} data-testid="export">{app.exporting ? 'Exporting…' : 'Export PDF'}</button>
  <button onclick={() => (app.settingsOpen = true)} title="Settings" aria-label="Settings" data-testid="open-settings">⚙</button>
  <button onclick={() => (app.sidebarOpen = !app.sidebarOpen)} title="Toggle comment list" aria-label="Toggle sidebar" aria-pressed={app.sidebarOpen} data-testid="toggle-sidebar">☰</button>
</header>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .name {
    font-weight: 600;
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  button {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 9px;
  }
  button:hover:not(:disabled) {
    border-color: var(--accent);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .group {
    display: flex;
    gap: 2px;
  }
  .zoomval {
    min-width: 54px;
  }
  .chips {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .chip {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--panel-2);
    overflow: hidden;
  }
  .chip.active {
    border-color: var(--c);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 35%, transparent);
  }
  .chip .label {
    border: 0;
    background: transparent;
    padding: 3px 10px 3px 4px;
    border-radius: 0;
  }
  .swatch {
    width: 22px;
    height: 22px;
    margin-left: 3px;
    border-radius: 50%;
    background: var(--c);
    position: relative;
    cursor: pointer;
    flex: none;
  }
  .swatch input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
  }
  kbd {
    font: 600 10px var(--ui);
    color: var(--muted);
    margin-right: 5px;
  }
  .add {
    position: relative;
  }
  .chip-add {
    border-radius: 999px;
    width: 28px;
    padding: 3px 0;
  }
  .pop {
    position: absolute;
    top: 34px;
    left: 0;
    z-index: 20;
    display: flex;
    gap: 6px;
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    box-shadow: var(--shadow);
  }
  .pop input:not([type='color']) {
    width: 130px;
  }
  .pop input,
  .pop select {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 6px;
  }
  .badge {
    color: #92400e;
    background: #fef3c7;
    border: 1px solid #fcd34d;
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 12px;
  }
  .badge.review {
    color: #1e3a8a;
    background: #dbeafe;
    border-color: #93c5fd;
  }
  .bridge {
    font-size: 12px;
    color: #15803d;
  }
  .bridge.offline {
    color: #b45309;
  }
  button.linked {
    background: none;
    border: none;
    padding: 2px 4px;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .home {
    padding: 4px 8px;
  }
</style>
