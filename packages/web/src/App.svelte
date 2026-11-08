<script lang="ts">
  import { onMount } from 'svelte';
  import SearchBar from './components/SearchBar.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import StartScreen from './components/StartScreen.svelte';
  import TopBar from './components/TopBar.svelte';
  import Viewer from './components/Viewer.svelte';
  import { app } from './lib/state.svelte.ts';

  let dragging = $state(false);

  onMount(() => {
    void app.init();
    const flush = () => {
      if (document.visibilityState === 'hidden') void app.flushSave();
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  });

  // ── Drag and drop of files onto the window ─────────────────────────────────────────────────
  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  }
  function ondragover(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragging = true;
  }
  function ondrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragging = false;
    void app.openFiles([...e.dataTransfer!.files]);
  }

  // ── Keyboard (spec §7.2–7.3) ───────────────────────────────────────────────────────────────
  function typing(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return !!el && (el.matches('input, textarea, select, [contenteditable="true"]') || !!el.closest('.cm-editor'));
  }

  function onkeydown(e: KeyboardEvent) {
    if (!app.pdf || app.settingsOpen) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      app.searchOpen = true;
      return;
    }
    if (typing(e.target)) return;
    if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault();
      app.downloadAnnotations();
    } else if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) app.redo();
      else app.undo();
    } else if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      app.redo();
    } else if (ctrl || app.editingId) {
      return;
    } else if (e.altKey && (e.code === 'KeyL' || e.code === 'KeyR') && app.focusedId) {
      e.preventDefault();
      app.togglePin(app.focusedId, e.code === 'KeyL' ? 'left' : 'right');
    } else if (e.altKey) {
      return;
    } else if (/^[1-9]$/.test(e.key)) {
      app.selectCategoryByIndex(Number(e.key));
    } else if (e.key === 'Tab' && (document.activeElement === document.body || document.activeElement?.closest('.viewer'))) {
      e.preventDefault();
      app.focusRelative(e.shiftKey ? -1 : 1);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && app.focusedId) {
      e.preventDefault();
      app.deleteAnnotation(app.focusedId);
    } else if (e.key === 'Enter' && app.focusedId && !(document.activeElement instanceof HTMLButtonElement)) {
      e.preventDefault();
      app.startEdit(app.focusedId);
    } else if (e.key === 'Escape') {
      if (app.searchOpen) app.clearSearch();
      else app.focus(null);
    }
  }
</script>

<svelte:window {ondragover} {ondrop} ondragleave={() => (dragging = false)} {onkeydown} />

{#if app.pdf && app.file}
  <div class="shell">
    <TopBar />
    {#if app.mismatch}
      <div class="banner" role="alert" data-testid="mismatch">
        This PDF is not the one these annotations were made on. Anchors may be off.
        <button onclick={() => app.reanchor()}>Re-anchor by quote</button>
      </div>
    {/if}
    <div class="main">
      <Viewer />
      {#if app.sidebarOpen}<Sidebar />{/if}
      <SearchBar />
    </div>
  </div>
  <SettingsDialog />
{:else}
  <StartScreen />
{/if}

{#if app.loading}
  <div class="loading" role="status">{app.loading}</div>
{/if}

{#if dragging}<div class="dropzone">Drop to open</div>{/if}

<div class="toasts" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <button class="toast {t.kind}" onclick={() => app.dismissToast(t.id)}>{t.text}</button>
  {/each}
</div>

<style>
  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .main {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .banner {
    background: #fef3c7;
    color: #78350f;
    border-bottom: 1px solid #fcd34d;
    padding: 6px 12px;
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .banner button {
    border: 1px solid #d97706;
    background: white;
    border-radius: 6px;
    padding: 2px 10px;
  }
  .loading {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.35);
    color: white;
    font-size: 16px;
    z-index: 100;
  }
  .dropzone {
    position: fixed;
    inset: 10px;
    border: 3px dashed var(--accent);
    border-radius: 14px;
    display: grid;
    place-items: center;
    font-size: 22px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    pointer-events: none;
    z-index: 90;
  }
  .toasts {
    position: fixed;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 110;
    max-width: min(640px, 92vw);
  }
  .toast {
    text-align: left;
    background: var(--panel);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 8px;
    padding: 8px 12px;
    box-shadow: var(--shadow);
  }
  .toast.warn {
    border-left-color: #d97706;
  }
  .toast.error {
    border-left-color: var(--danger);
  }
</style>
