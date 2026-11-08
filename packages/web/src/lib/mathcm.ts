import { acceptCompletion, autocompletion, closeCompletion, completionStatus, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { history, historyKeymap, defaultKeymap, insertNewline } from '@codemirror/commands';
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, showTooltip, tooltips, ViewPlugin, WidgetType, type DecorationSet, type Tooltip, type ViewUpdate } from '@codemirror/view';
import { getMath, hasMath, prepareMath } from '@margin/core';

// CodeMirror 6 extensions for the comment editor (spec §7.4): math segments away from the cursor are
// replaced by rendered MathJax widgets; the segment under the cursor shows its source with a rendered
// preview below it (150 ms debounce). The editor is styled to look like the rendered box.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Inline SVG of a prepared math box, sized in em so it follows the editor's font size. */
export function mathSvg(tex: string, display: boolean): SVGSVGElement | null {
  if (!hasMath(tex, display)) return null;
  const box = getMath(tex, display);
  const svg = document.createElementNS(SVG_NS, 'svg');
  if (box.error) return null;
  const h = box.height + box.depth;
  svg.setAttribute('viewBox', `0 ${-box.height * 1000} ${box.width * 1000} ${h * 1000}`);
  svg.style.width = `${box.width}em`;
  svg.style.height = `${h}em`;
  svg.style.verticalAlign = `${-box.depth}em`;
  svg.style.overflow = 'visible';
  for (const d of box.paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}

export interface MathRange {
  from: number;
  to: number;
  tex: string;
  display: boolean;
}

/** `\( … \)` and `\[ … \]` segments of a comment body (same delimiters as core/text/markup). */
export function findMath(text: string): MathRange[] {
  const out: MathRange[] = [];
  const re = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Skip a backslash that is itself escaped (`\\(`).
    let slashes = 0;
    for (let i = m.index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
    if (slashes % 2 === 1) continue;
    out.push({ from: m.index, to: m.index + m[0].length, tex: m[1] ?? m[2] ?? '', display: m[2] !== undefined });
  }
  return out;
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  override eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.display ? 'cm-math cm-math-display' : 'cm-math';
    const svg = mathSvg(this.tex, this.display);
    if (svg) el.append(svg);
    else {
      el.classList.add('cm-math-error');
      el.textContent = this.display ? `\\[${this.tex}\\]` : `\\(${this.tex}\\)`;
    }
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const refresh = StateEffect.define<null>();

/** Replace math away from the cursor by widgets; prepare unknown math asynchronously. */
const mathWidgets = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(readonly view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.focusChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refresh)))) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const ranges: Range<Decoration>[] = [];
      const missing: { tex: string; display: boolean }[] = [];
      for (const m of findMath(view.state.doc.toString())) {
        if (!hasMath(m.tex, m.display)) missing.push({ tex: m.tex, display: m.display });
        const inside = touches(view.state, m);
        if (inside || !hasMath(m.tex, m.display)) continue;
        ranges.push(Decoration.replace({ widget: new MathWidget(m.tex, m.display) }).range(m.from, m.to));
      }
      if (missing.length) {
        void prepareMath(missing).then(() => {
          if (this.view.dom.isConnected) this.view.dispatch({ effects: refresh.of(null) });
        });
      }
      return Decoration.set(ranges, true);
    }
  },
  { decorations: (v) => v.decorations, provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none) },
);

/**
 * Whether the cursor (or selection) is in a math segment, so its source is shown. A cursor just after
 * the closing delimiter is outside: finishing a formula and typing on shows it typeset.
 */
function touches(state: EditorState, m: MathRange): boolean {
  const { from, to, head } = state.selection.main;
  return from === to ? head >= m.from && head < m.to : from < m.to && to > m.from;
}

/** Floating preview of the math segment under the cursor. */
function previewTooltip(state: EditorState): Tooltip | null {
  const hit = findMath(state.doc.toString()).find((m) => touches(state, m));
  if (!hit) return null;
  return { pos: hit.from, above: false, strictSide: false, arrow: false, create: createPreview };
}

// A stable `create` lets CodeMirror update the existing tooltip instead of recreating it per keystroke.
function createPreview(view: EditorView) {
  const dom = document.createElement('div');
  dom.className = 'cm-math-preview';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const render = () => {
    const hit = findMath(view.state.doc.toString()).find((m) => touches(view.state, m));
    if (!hit) return;
    void prepareMath([{ tex: hit.tex, display: hit.display }]).then(() => {
      dom.replaceChildren();
      const svg = mathSvg(hit.tex, hit.display);
      if (svg) dom.append(svg);
      else {
        const err = getMath(hit.tex, hit.display).error;
        dom.textContent = err ?? '';
        dom.classList.add('cm-math-preview-error');
      }
    });
  };
  render();
  return {
    dom,
    update(u: ViewUpdate) {
      if (!u.docChanged && !u.selectionSet) return;
      dom.classList.remove('cm-math-preview-error');
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    },
    destroy() {
      clearTimeout(timer);
    },
  };
}

const previewField = StateField.define<Tooltip | null>({
  create: previewTooltip,
  update: (value, tr) => (tr.docChanged || tr.selection ? previewTooltip(tr.state) : value),
  provide: (f) => showTooltip.from(f),
});

export interface CommentOption {
  id: string;
  number: number;
  label: string;
  category: string;
}

export interface EditorHooks {
  commit(): void;
  onChange(text: string): void;
  setCategory(n: number): void;
  /** Comments that `@` can reference. */
  references(): CommentOption[];
}

/** `@` opens a picker of comments by number or text; Enter inserts `\ref{id}` (spec §7.3). */
function referenceSource(hooks: EditorHooks) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/@[^\s@]*/);
    if (!m) return null;
    return {
      from: m.from,
      filter: false,
      options: hooks
        .references()
        .filter((o) => {
          const typed = m.text.slice(1).toLowerCase();
          return !typed || String(o.number).startsWith(typed) || o.label.toLowerCase().includes(typed);
        })
        .map((o) => ({ label: `@${o.number} ${o.label}`, detail: o.category, apply: `\\ref{${o.id}}`, type: 'text' })),
    };
  };
}

const theme = EditorView.theme({
  '&': { background: 'transparent', color: 'inherit', fontFamily: "'Fira Sans', sans-serif", fontSize: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.25', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'currentColor', fontFamily: 'inherit' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'currentColor' },
});

export function editorExtensions(hooks: EditorHooks, compartment: Compartment): Extension[] {
  const ctrlDigits = Array.from({ length: 9 }, (_, i) => ({
    key: `Ctrl-${i + 1}`,
    run: () => {
      hooks.setCategory(i + 1);
      return true;
    },
  }));
  return [
    // Commit keys come before the autocompletion keymap (which would otherwise swallow a quick Esc
    // while its query is still pending) and defer to it only while its popup is actually open.
    Prec.highest(
      keymap.of([
        // Enter never inserts a line break (Shift+Enter does); with the picker open it accepts, but not within
        // the picker's short anti-accident delay, where it is simply ignored.
        { key: 'Enter', run: (view) => (completionStatus(view.state) === 'active' ? (acceptCompletion(view), true) : (hooks.commit(), true)) },
        { key: 'Escape', run: (view) => (completionStatus(view.state) === 'active' ? closeCompletion(view) : (hooks.commit(), true)) },
        { key: 'Shift-Enter', run: insertNewline },
        {
          key: 'Ctrl-m',
          run: (view) => {
            const { from, to } = view.state.selection.main;
            const inner = view.state.sliceDoc(from, to);
            view.dispatch({ changes: { from, to, insert: `\\(${inner}\\)` }, selection: { anchor: from + 2 + inner.length } });
            return true;
          },
        },
        ...ctrlDigits,
      ]),
    ),
    history(),
    EditorView.lineWrapping,
    theme,
    mathWidgets,
    previewField,
    tooltips({ position: 'fixed' }),
    autocompletion({ override: [referenceSource(hooks)], icons: false, activateOnTyping: true, defaultKeymap: true }),
    compartment.of([]),
    keymap.of([...historyKeymap, ...defaultKeymap]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) hooks.onChange(u.state.doc.toString());
    }),
  ];
}
