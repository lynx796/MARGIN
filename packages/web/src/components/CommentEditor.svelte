<script lang="ts">
  import { Compartment, EditorState } from '@codemirror/state';
  import { EditorView } from '@codemirror/view';
  import { onMount } from 'svelte';
  import { editorExtensions, type CommentOption } from '../lib/mathcm.ts';
  import { app } from '../lib/state.svelte.ts';

  // The comment box while it is being edited (spec §7.4): CodeMirror styled like the rendered box,
  // placed at the laid-out position. Other boxes shift live because the layout is recomputed from the
  // draft text on every change. Wrapping here is approximate; the committed layout uses the core engine.

  let { box, fontSize, number }: { box: [number, number, number, number]; fontSize: number; number: number | undefined } = $props();

  let host: HTMLDivElement;
  const color = $derived(app.category(app.draft?.category ?? '')?.color ?? '#2563eb');
  const z = $derived(app.zoom);

  function references(): CommentOption[] {
    return app.commentOrder
      .filter((id) => id !== app.editingId)
      .map((id) => {
        const a = app.annotation(id)!;
        return { id, number: app.numberOf(id)!, label: a.body.split('\n')[0]!.slice(0, 40), category: app.category(a.category)?.name ?? a.category };
      });
  }

  onMount(() => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: app.draft?.body ?? '',
        selection: { anchor: (app.draft?.body ?? '').length },
        extensions: editorExtensions(
          { commit: () => app.commitEdit(), onChange: (t) => app.setDraftBody(t), setCategory: (n) => app.setDraftCategoryByIndex(n), references },
          new Compartment(),
        ),
      }),
    });
    view.focus();
    // Clicking anywhere outside the editor and its popups commits (capture: before other handlers run).
    const outside = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && (host.contains(t) || t.closest('.cm-tooltip'))) return;
      app.commitEdit();
    };
    window.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      view.destroy();
    };
  });
</script>

<div
  class="editor"
  data-testid="comment-editor"
  style="left:{box[0] * z}px; top:{box[1] * z}px; width:{box[2] * z}px; min-height:{box[3] * z}px; --c:{color}; font-size:{fontSize * z}px; padding:{4 * z}px {4 * z}px {4 * z}px {4 * z}px; border-left-width:{2 * z}px; border-radius:{2 * z}px"
>
  <div bind:this={host}></div>
  {#if number !== undefined}<span class="num" style="font-size:{6.5 * z}px; top:{4 * z}px; right:{4 * z}px">{number}</span>{/if}
</div>

<style>
  .editor {
    position: absolute;
    z-index: 5;
    box-sizing: border-box;
    border-left: solid var(--c);
    background: color-mix(in srgb, var(--c) 8%, white);
    color: #1a1a1a;
    font-family: 'Fira Sans', sans-serif;
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--c) 55%, transparent);
  }
  .num {
    position: absolute;
    color: #6b7280;
    pointer-events: none;
  }
  .editor :global(.cm-math) {
    display: inline-block;
    color: #1a1a1a;
  }
  .editor :global(.cm-math-display) {
    display: block;
    text-align: center;
  }
  .editor :global(.cm-math-error) {
    color: #dc2626;
    font-family: 'Fira Mono', monospace;
  }
  :global(.cm-math-preview) {
    background: white;
    color: #1a1a1a;
    border: 1px solid #cbd0d8;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 15px;
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.18);
    max-width: 420px;
    overflow: auto;
  }
  :global(.cm-math-preview-error) {
    color: #dc2626;
    font: 12px 'Fira Mono', monospace;
  }
  :global(.cm-tooltip.cm-tooltip-autocomplete) {
    font: 12px system-ui, sans-serif;
  }
</style>
