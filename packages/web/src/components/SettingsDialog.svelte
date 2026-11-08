<script lang="ts">
  import type { Settings } from '@margin/core';
  import { app } from '../lib/state.svelte.ts';

  let dialog: HTMLDialogElement;

  $effect(() => {
    if (!dialog) return;
    if (app.settingsOpen && !dialog.open) dialog.showModal();
    if (!app.settingsOpen && dialog.open) dialog.close();
  });

  const s = $derived(app.file?.settings);
  const autoCrop = $derived(app.geometry?.crop);
  const crop = $derived(s?.crop);

  function num(e: Event & { currentTarget: HTMLInputElement }, key: 'marginWidth' | 'maxEnlargement' | 'fontSize') {
    const v = Number(e.currentTarget.value);
    if (Number.isFinite(v)) app.updateSettings({ [key]: v } as Partial<Settings>);
  }

  function setCrop(which: 0 | 1, e: Event & { currentTarget: HTMLInputElement }) {
    const v = Number(e.currentTarget.value);
    const base = crop ?? autoCrop ?? [0, 0];
    if (!Number.isFinite(v) || e.currentTarget.value === '') return;
    const next: [number, number] = [base[0], base[1]];
    next[which] = v;
    if (next[1] > next[0]) app.updateSettings({ crop: next });
  }

  async function forget() {
    const sha = app.pdf?.sha256;
    if (!sha) return;
    app.settingsOpen = false;
    await app.closeDocument();
    await app.forget(sha);
  }

  async function clearAll() {
    app.settingsOpen = false;
    await app.closeDocument();
    await app.clearAllData();
  }
</script>

<dialog bind:this={dialog} onclose={() => (app.settingsOpen = false)} data-testid="settings">
  {#if s}
    <form method="dialog" class="head">
      <h2>Settings</h2>
      <button aria-label="Close settings">✕</button>
    </form>

    <section>
      <h3>Categories</h3>
      <table>
        <thead><tr><th></th><th>Name</th><th>Kind</th><th title="Placement weight: heavier comments stay closer to their anchor">Weight</th><th></th></tr></thead>
        <tbody>
          {#each app.categories as c, i (c.id)}
            <tr data-testid="category-row-{c.id}">
              <td><input type="color" value={c.color} onchange={(e) => app.updateCategory(c.id, { color: e.currentTarget.value })} aria-label="Color of {c.name}" /></td>
              <td><input value={c.name} onchange={(e) => app.updateCategory(c.id, { name: e.currentTarget.value })} aria-label="Name of {c.name}" /></td>
              <td>
                <select value={c.kind} onchange={(e) => app.updateCategory(c.id, { kind: e.currentTarget.value as 'comment' | 'highlight' })} aria-label="Kind of {c.name}">
                  <option value="comment">comment</option>
                  <option value="highlight">highlight</option>
                </select>
              </td>
              <td><input type="number" min="0" step="0.5" value={c.weight} onchange={(e) => app.updateCategory(c.id, { weight: Number(e.currentTarget.value) })} aria-label="Weight of {c.name}" class="narrow" /></td>
              <td class="acts">
                <button onclick={() => app.moveCategory(c.id, -1)} disabled={i === 0} aria-label="Move {c.name} up">↑</button>
                <button onclick={() => app.moveCategory(c.id, 1)} disabled={i === app.categories.length - 1} aria-label="Move {c.name} down">↓</button>
                <button onclick={() => app.removeCategory(c.id)} aria-label="Delete {c.name}">🗑</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="hint">The category set is also kept in this browser as the default for new documents.</p>
    </section>

    <section class="grid">
      <h3>Page layout</h3>
      <label>Margin width per side (pt)<input type="number" min="40" max="400" step="5" value={s.marginWidth} onchange={(e) => num(e, 'marginWidth')} data-testid="setting-margin" /></label>
      <label>Maximum enlargement<input type="number" min="1" max="3" step="0.05" value={s.maxEnlargement} onchange={(e) => num(e, 'maxEnlargement')} /></label>
      <label>Comment font size (pt)<input type="number" min="5" max="16" step="0.5" value={s.fontSize} onchange={(e) => num(e, 'fontSize')} data-testid="setting-font" /></label>
      <label>Leader style
        <select value={s.leaderStyle} onchange={(e) => app.updateSettings({ leaderStyle: e.currentTarget.value as 'full' | 'gutter' })}>
          <option value="full">full (dotted through the line)</option>
          <option value="gutter">gutter only</option>
        </select>
      </label>
      <div class="crop">
        <span>Horizontal crop (pt)</span>
        <input type="number" step="1" placeholder={autoCrop ? String(Math.round(autoCrop[0])) : ''} value={crop ? crop[0] : ''} onchange={(e) => setCrop(0, e)} aria-label="Crop left" />
        <input type="number" step="1" placeholder={autoCrop ? String(Math.round(autoCrop[1])) : ''} value={crop ? crop[1] : ''} onchange={(e) => setCrop(1, e)} aria-label="Crop right" />
        <button onclick={() => app.clearCrop()} disabled={!crop}>Auto</button>
      </div>
    </section>

    <section>
      <h3>Data in this browser</h3>
      <p class="hint">Storage: {app.storageKind ?? 'unavailable'}. Nothing is ever uploaded.</p>
      <div class="row">
        <button onclick={forget} data-testid="forget">Forget this document</button>
        <button class="danger" onclick={clearAll}>Clear all data</button>
      </div>
    </section>
  {/if}
</dialog>

<style>
  dialog {
    width: min(720px, 94vw);
    max-height: 90vh;
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0 20px 16px;
    box-shadow: var(--shadow);
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.4);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    background: var(--panel);
    padding: 12px 0 4px;
  }
  h2,
  h3 {
    margin: 0;
  }
  h3 {
    font-size: 13px;
    margin: 14px 0 6px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    text-align: left;
    font-weight: 500;
    color: var(--muted);
    font-size: 11px;
  }
  td {
    padding: 2px 4px 2px 0;
  }
  input,
  select,
  button {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 6px;
  }
  input[type='color'] {
    padding: 0;
    width: 30px;
    height: 24px;
  }
  .narrow {
    width: 64px;
  }
  .acts {
    white-space: nowrap;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 16px;
  }
  .grid h3 {
    grid-column: 1 / -1;
  }
  label,
  .crop {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .crop {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    grid-column: 1 / -1;
  }
  .crop span {
    flex: 1;
  }
  .crop input {
    width: 80px;
  }
  .hint {
    color: var(--muted);
    margin: 4px 0;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .danger {
    color: var(--danger);
  }
</style>
