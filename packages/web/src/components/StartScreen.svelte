<script lang="ts">
  import { parseConnection } from '../lib/bridge.ts';
  import { app } from '../lib/state.svelte.ts';

  let input: HTMLInputElement;
  let pasted = $state('');
  let pasteError = $state('');

  async function connect(e: SubmitEvent) {
    e.preventDefault();
    const conn = parseConnection(pasted);
    if (!conn) {
      pasteError = 'Paste the URL printed by margin serve (it ends in #token=…).';
      return;
    }
    pasteError = '';
    if (await app.connectBridge(conn)) pasted = '';
  }

  function pick() {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) void app.openFiles(files);
  }

  // AGPL-3.0 §13: users of a hosted copy must be offered the source. Set at build time (VITE_SOURCE_URL).
  const sourceUrl = import.meta.env.VITE_SOURCE_URL as string | undefined;

  function fmt(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
</script>

<main class="start">
  <div class="card">
    <h1>Margin</h1>
    <p class="tag">Grade compiled LaTeX papers with typeset comments in the margins.</p>

    <button class="drop" onclick={() => (app.canPickHandles ? app.pickAndOpen() : input.click())} data-testid="open-button">
      <strong>Open a PDF</strong>
      <span>or drop it here, optionally together with its <code>.annot.json</code> file</span>
    </button>
    <input bind:this={input} type="file" accept=".pdf,application/pdf,.json,application/json" multiple hidden onchange={pick} data-testid="file-input" />

    <h2>Local bridge</h2>
    {#if app.bridge}
      <div class="bridge" data-testid="bridge-panel">
        <p class="m">
          {app.bridge.online ? 'Connected' : 'Offline, retrying'} to <code>{app.bridge.dir}</code> via {app.bridge.origin}.
          <button class="link" onclick={() => app.disconnectBridge()}>Disconnect</button>
        </p>
        <ul class="recent" data-testid="bridge-files">
          {#each app.bridge.files as f (f.path)}
            <li>
              <button class="open" onclick={() => app.openFromBridge(f.path)} data-testid="bridge-file">
                <span class="n">{f.path}</span>
                <span class="m">{f.annotations ? 'annotated' : 'no annotations yet'} · {fmt(f.modified)}</span>
              </button>
            </li>
          {:else}
            <li class="empty">No PDFs in this directory yet.</li>
          {/each}
        </ul>
      </div>
    {:else}
      <form class="connect" onsubmit={connect}>
        <input bind:value={pasted} placeholder="Paste the URL printed by margin serve" aria-label="Bridge URL" data-testid="bridge-url" />
        <button type="submit" data-testid="bridge-connect">Connect</button>
      </form>
      {#if pasteError}<p class="err">{pasteError}</p>{/if}
      <p class="m">Run <code>margin serve --dir ~/grading</code> to let agents and the CLI work on the same files live.</p>
    {/if}

    <h2>Recent documents</h2>
    {#if app.recent.length}
      <ul class="recent" data-testid="recent">
        {#each app.recent as r (r.sha)}
          <li>
            <button class="open" onclick={() => app.openStored(r.sha)}>
              <span class="n">{r.name}</span>
              <span class="m">{r.pageCount} pages · {fmt(r.modified)}</span>
            </button>
            <button class="forget" onclick={() => app.forget(r.sha)} aria-label="Remove {r.name} from browser storage" title="Remove from browser storage">✕</button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">Nothing yet. Documents you open are kept in this browser only.</p>
    {/if}

    <p class="privacy">Everything stays on this device. Documents and annotations are stored in your browser ({app.storageKind ?? 'storage unavailable'}), never uploaded.</p>
    <p class="license">Margin is free software under the <abbr title="GNU Affero General Public License, version 3 or later">AGPL-3.0</abbr>.{#if sourceUrl}{' '}<a href={sourceUrl} rel="noreferrer">Source code</a>{/if}</p>
  </div>
</main>

<style>
  .start {
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
    overflow: auto;
  }
  .card {
    width: min(560px, 100%);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px;
    box-shadow: var(--shadow);
  }
  .connect {
    display: flex;
    gap: 6px;
  }
  .connect input {
    flex: 1;
    min-width: 0;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 8px;
  }
  .connect button,
  .link {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
  }
  .link {
    padding: 0 6px;
    margin-left: 4px;
  }
  .err {
    color: var(--danger);
    margin: 4px 0 0;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    letter-spacing: -0.02em;
  }
  h2 {
    font-size: 13px;
    margin: 22px 0 6px;
    color: var(--muted);
    font-weight: 600;
  }
  .tag {
    color: var(--muted);
    margin: 4px 0 18px;
  }
  .drop {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
    padding: 28px 16px;
    background: transparent;
    border: 2px dashed var(--border);
    border-radius: 10px;
  }
  .drop:hover {
    border-color: var(--accent);
  }
  .drop span {
    color: var(--muted);
  }
  .recent {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li {
    display: flex;
    gap: 4px;
  }
  .open {
    flex: 1;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    text-align: left;
    padding: 8px 10px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .open:hover {
    border-color: var(--accent);
  }
  .m {
    color: var(--muted);
    white-space: nowrap;
  }
  .forget {
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted);
    border-radius: 6px;
  }
  .forget:hover {
    color: var(--danger);
    border-color: var(--border);
  }
  .empty,
  .privacy,
  .license {
    color: var(--muted);
    font-size: 12px;
  }
  .privacy {
    margin-top: 22px;
  }
  .license a {
    color: inherit;
  }
  code {
    font-size: 12px;
  }
</style>
