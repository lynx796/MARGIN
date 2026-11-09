<script lang="ts">
  import { PdfDoc, type TermSuggestion } from '@margin/core';
  import { app } from '../lib/state.svelte.ts';

  // Pseudonymization (spec §10): terms, redaction with verification, and the mandatory review by
  // eye (§10.4) before anything can be saved: page 1 at full size, every redaction outlined.

  let dialog: HTMLDialogElement;
  let terms = $state('');
  let termsError = $state('');
  let suggestions = $state<TermSuggestion[]>([]);
  let confirmed = $state(false);
  let pages = $state<{ page: number; url: string; width: number; height: number }[]>([]);

  $effect(() => {
    if (!dialog) return;
    if (app.pseudoOpen && !dialog.open) {
      dialog.showModal();
      void init();
    }
    if (!app.pseudoOpen && dialog.open) dialog.close();
  });

  async function init() {
    confirmed = false;
    pages = [];
    app.pseudo = null;
    terms = await app.loadTerms();
    suggestions = await app.termSuggestions();
    await check();
  }

  async function check() {
    const { parseTerms } = await import('@margin/core/pseudo');
    try {
      parseTerms(terms);
      termsError = '';
    } catch (e) {
      termsError = (e as Error).message;
    }
  }

  /** Add a suggestion as a new group (names) or as a variant of EMAIL / STUDENT_ID. */
  function adopt(s: TermSuggestion) {
    const lines = terms.split('\n').filter((l) => l.trim() !== '');
    const shared = s.kind === 'email' ? 'EMAIL' : s.kind === 'student-id' ? 'STUDENT_ID' : null;
    const i = shared ? lines.findIndex((l) => l.startsWith(`${shared}:`)) : -1;
    if (shared && i >= 0) lines[i] = `${lines[i]} | ${s.text}`;
    else if (shared) lines.push(`${shared}: ${s.text}`);
    else {
      let n = 1;
      while (lines.some((l) => l.startsWith(`PERSON_${n}:`))) n++;
      // A name also matches by its surname alone.
      const parts = s.text.split(' ');
      lines.push(`PERSON_${n}: ${s.text}${parts.length > 1 ? ` | ${parts.at(-1)}` : ''}`);
    }
    terms = lines.join('\n') + '\n';
    void check();
  }

  async function run() {
    pages = [];
    confirmed = false;
    await app.runPseudonymize(terms);
    const p = app.pseudo;
    if (p?.phase !== 'review') return;
    const doc = await PdfDoc.open(p.bytes.slice());
    try {
      for (let n = 1; n <= doc.pageCount; n++) {
        const bm = await doc.rasterize(n, n === 1 ? 110 : 60);
        const canvas = document.createElement('canvas');
        canvas.width = bm.width;
        canvas.height = bm.height;
        canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bm.data), bm.width, bm.height), 0, 0);
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
        pages = [...pages, { page: n, url: URL.createObjectURL(blob), width: doc.pages[n - 1]!.width, height: doc.pages[n - 1]!.height }];
      }
    } finally {
      await doc.destroy();
    }
  }

  function close() {
    for (const p of pages) URL.revokeObjectURL(p.url);
    pages = [];
    app.pseudoOpen = false;
  }

  const review = $derived(app.pseudo?.phase === 'review' ? app.pseudo : null);
  const counts = $derived(review ? review.map.groups.map((g) => ({ token: g.token, n: review.matches.filter((m) => m.token === g.token).length })) : []);
</script>

<dialog bind:this={dialog} onclose={close} data-testid="pseudo-dialog">
  <form method="dialog" class="head">
    <h2>Pseudonymize</h2>
    <button aria-label="Close">✕</button>
  </form>

  {#if !review}
    <p class="hint">
      One group per line: <code>TOKEN: variant | variant | /regex/</code>. Every match is replaced by <code>[TOKEN]</code> on a gray box;
      metadata, bookmarks, links, attachments and form fields are cleaned. Nothing leaves this browser.
    </p>
    <textarea bind:value={terms} oninput={check} rows="7" spellcheck="false" placeholder={'AUTHOR_1: Anna Müller | Müller | Anna\nEMAIL: /[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/'} data-testid="terms"></textarea>
    {#if termsError}<p class="error" data-testid="terms-error">{termsError}</p>{/if}
    {#if suggestions.length}
      <div class="suggestions">
        <span class="hint">Suggestions (click to add):</span>
        {#each suggestions as s (s.kind + s.text)}
          <button class="chip" title={s.kind} onclick={() => adopt(s)} data-testid="suggestion">{s.text}</button>
        {/each}
      </div>
    {/if}
    {#if app.pseudo?.phase === 'running'}
      <p data-testid="pseudo-status">{app.pseudo.step}</p>
    {:else if app.pseudo?.phase === 'failed'}
      <div class="error" data-testid="pseudo-failed">
        <p>{app.pseudo.message}</p>
        {#if app.pseudo.problems.length}
          <ul>{#each app.pseudo.problems as p, i (i)}<li>{p.message} <small>({p.path})</small></li>{/each}</ul>
        {/if}
      </div>
    {/if}
    <div class="row">
      <button class="primary" onclick={run} disabled={!!termsError || !terms.trim() || app.pseudo?.phase === 'running'} data-testid="pseudo-run">Redact and verify</button>
    </div>
  {:else}
    <p class="ok" data-testid="pseudo-summary">
      Verified: no term left in the text, metadata, bookmarks or raw data.
      Replaced {counts.map((c) => `${c.token} ×${c.n}`).join(', ')}. Also removed: {review.scrubbed.join(', ') || 'nothing'}.
    </p>
    {#each counts.filter((c) => c.n === 0) as c (c.token)}<p class="warn">{c.token} matched nothing; check its spelling.</p>{/each}
    <p class="warn"><strong>Check every page by eye.</strong> Names inside images (scans, logos, signatures) cannot be detected. Redactions are outlined in red.</p>
    <div class="pages">
      {#each pages as p (p.page)}
        <figure class:first={p.page === 1}>
          <div class="sheet" style="aspect-ratio: {p.width} / {p.height}">
            <img src={p.url} alt="Page {p.page} of the pseudonymized PDF" />
            <svg viewBox="0 0 {p.width} {p.height}" preserveAspectRatio="none">
              {#each review.matches.filter((m) => m.page === p.page) as m, i (i)}
                {#each m.quads as q, j (j)}<rect x={q[0] - 1.5} y={q[1] - 1.5} width={q[2] - q[0] + 3} height={q[3] - q[1] + 3} data-testid="redaction" />{/each}
              {/each}
            </svg>
          </div>
          <figcaption>Page {p.page}</figcaption>
        </figure>
      {/each}
    </div>
    <label class="confirm"><input type="checkbox" bind:checked={confirmed} data-testid="pseudo-confirm" /> I have checked every page, including images, for personal data.</label>
    <div class="row">
      <button class="primary" disabled={!confirmed} onclick={() => app.savePseudoPdf()} data-testid="pseudo-download">Save {review.fileName}</button>
      <button disabled={!confirmed} onclick={() => app.savePseudoMap()} title="Needed to transfer comments back; keep it private" data-testid="pseudo-map">Save mapping file</button>
      {#if review.annotations}<button disabled={!confirmed} onclick={() => app.savePseudoAnnotations()} data-testid="pseudo-annotations">Save annotations ({review.annotations.annotations.length})</button>{/if}
      <button disabled={!confirmed} onclick={() => app.openPseudonymized()} data-testid="pseudo-open">Open the copy here</button>
      <button onclick={() => (app.pseudo = null)}>Change terms</button>
    </div>
  {/if}
</dialog>

<style>
  dialog {
    width: min(900px, 96vw);
    max-height: 92vh;
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
  }
  .head button {
    border: none;
    background: none;
    font-size: 18px;
    cursor: pointer;
    color: var(--muted);
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 13px;
  }
  .hint {
    color: var(--muted);
    margin: 6px 0;
  }
  .error {
    color: var(--danger);
  }
  .warn {
    color: var(--warn, #b45309);
  }
  .ok {
    color: var(--ok, #15803d);
  }
  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin: 8px 0;
  }
  .chip {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2px 10px;
    background: none;
    color: var(--text);
    cursor: pointer;
  }
  .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .pages {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin: 10px 0;
  }
  figure {
    margin: 0;
    width: 180px;
  }
  figure.first {
    width: 100%;
  }
  .sheet {
    position: relative;
    width: 100%;
    border: 1px solid var(--border);
  }
  .sheet img,
  .sheet svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .sheet rect {
    fill: none;
    stroke: #dc2626;
    stroke-width: 1.2;
  }
  figcaption {
    color: var(--muted);
    font-size: 12px;
  }
  .confirm {
    display: block;
    margin-top: 8px;
  }
</style>
