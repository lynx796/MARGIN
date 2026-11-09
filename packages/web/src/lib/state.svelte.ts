import {
  computeGeometry,
  describeMerge,
  mergeExternal,
  sameValue,
  sha256Hex,
  computeLayout,
  createAnnotFile,
  isoSeconds,
  MarginError,
  measureInk,
  newId,
  parseAnnotFile,
  normalizeQuote,
  PageIndex,
  PdfDoc,
  prepareFileMath,
  quadsForRange,
  resolveAll,
  serialize,
  DEFAULT_CATEGORIES,
  type Anchor,
  type Annotation,
  type AnnotFile,
  type Category,
  type Conflict,
  type DocGeometry,
  type FontSet,
  type LayoutResult,
  type PageItem,
  type PageText,
  type Rect,
  type Settings,
  type Side,
  type Problem,
  type PseudoMap,
  type TermGroup,
  type TermMatch,
  type TermSuggestion,
} from '@margin/core';
import { loadFontBytes, loadFonts } from './fonts.ts';
import { BridgeClient, BridgeError, connectionFromLocation, forgetConnection, type BridgeConnection, type BridgeEvent, type BridgeFile } from './bridge.ts';
import { storage, type DocRecord } from './storage.ts';
import { exportInWorker } from './exporter.ts';
import { chooseTarget, writeTarget } from './savefile.ts';
import { redactInWorker } from './pseudonymizer.ts';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error';
}

/** Selection in progress or just made; coordinates are original-page points. */
export type Pending =
  | { kind: 'text'; page: number; from: number; to: number }
  | { kind: 'region'; page: number; x0: number; y0: number; x1: number; y1: number };

/** The editable fields of a category (Category itself also carries unknown fields and the id). */
export interface CategoryInput {
  name: string;
  color: string;
  kind: 'comment' | 'highlight';
  weight: number;
}

export interface Draft {
  body: string;
  category: string;
}

/** Origin filter of the sidebar; `unreviewed` is agent comments a human has not accepted yet (spec §9.4). */
export type OriginFilter = '' | 'human' | 'agent' | 'unreviewed';

export type SearchHit = { kind: 'text'; page: number; quads: Rect[] } | { kind: 'comment'; id: string };

const MAX_HISTORY = 200;

async function pageCountOf(bytes: Uint8Array): Promise<number> {
  const doc = await PdfDoc.open(bytes.slice());
  const n = doc.pageCount;
  await doc.destroy();
  return n;
}
const encoder = new TextEncoder();

function now(): string {
  return isoSeconds(new Date());
}

/** Text annotations that still lack geometry (written by an agent or by hand). */
function needsResolving(file: AnnotFile): Annotation[] {
  return file.annotations.filter((a) => a.anchor.type === 'text' && (!a.anchor.quads || a.anchor.page === undefined));
}

class App {
  // ── Document ────────────────────────────────────────────────────────────────────────────────
  pdf = $state.raw<PdfDoc | null>(null);
  /** Committed annotation file; while a new comment is being typed it already contains it. */
  file = $state.raw<AnnotFile | null>(null);
  geometry = $state.raw<DocGeometry | null>(null);
  layout = $state.raw<LayoutResult | null>(null);
  loading = $state<string | null>(null);
  /** The PDF does not match the annotation file; anchors can be re-resolved by quote. */
  mismatch = $state(false);
  recent = $state.raw<DocRecord[]>([]);
  storageKind = $state<'opfs' | 'indexeddb' | null>(null);

  // ── Bridge (spec §9.3) ──────────────────────────────────────────────────────────────────────
  bridge = $state.raw<{ origin: string; dir: string; files: BridgeFile[]; online: boolean } | null>(null);
  /** Path of the open document within the bridge directory, if it was opened from there. */
  bridgePath = $state<string | null>(null);
  /** Changes of the local text lost against changes on disk (spec §9.3), kept so they can be restored. */
  conflicts = $state.raw<Conflict[]>([]);
  originFilter = $state<OriginFilter>('');

  // ── View ────────────────────────────────────────────────────────────────────────────────────
  /** CSS px per output pt. */
  zoom = $state(1);
  viewerWidth = $state(1000);
  /** Fit the pages to the viewer once its width is known (right after a document opens). */
  fitPending = $state(false);
  sidebarOpen = $state(true);
  settingsOpen = $state(false);
  searchOpen = $state(false);
  activeCategory = $state('');
  focusedId = $state<string | null>(null);
  /** Page the viewer is currently showing (for the status in the top bar). */
  currentPage = $state(1);
  /** Ask the viewer to scroll to an output position; `nonce` makes repeated requests distinct. */
  scrollTarget = $state.raw<{ page: number; y: number; nonce: number } | null>(null);
  pending = $state.raw<Pending | null>(null);
  toasts = $state.raw<Toast[]>([]);

  // ── Search ──────────────────────────────────────────────────────────────────────────────────
  searchQuery = $state('');
  searchHits = $state.raw<SearchHit[]>([]);
  searchIndex = $state(0);

  // ── Editing ─────────────────────────────────────────────────────────────────────────────────
  editingId = $state<string | null>(null);
  draft = $state.raw<Draft | null>(null);
  /** Anchor being dragged (end handles), shown live without touching history. */
  anchorOverride = $state.raw<{ id: string; anchor: Anchor } | null>(null);

  // ── History ─────────────────────────────────────────────────────────────────────────────────
  past = $state.raw<AnnotFile[]>([]);
  future = $state.raw<AnnotFile[]>([]);
  /** The file before a not-yet-committed new comment was added. */
  private pendingBase: AnnotFile | null = null;

  private fonts: FontSet | null = null;
  private fontsLoading: Promise<FontSet> | null = null;
  private inks: ([number, number] | null)[] = [];
  private texts = new Map<number, PageText>();
  private textLoads = new Map<number, Promise<PageText>>();
  private layoutToken = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private toastId = 0;
  private scrollNonce = 0;

  private client: BridgeClient | null = null;
  private stopFollowing: (() => void) | undefined;
  /** The annotation file as last exchanged with the disk, and its ETag (SHA-256 of the text). */
  private bridgeBase: AnnotFile | null = null;
  private bridgeEtag: string | null = null;
  private bridgeDirty = false;
  /** ETags of our own writes, whose change events must not be pulled back in. */
  private ownEtags: string[] = [];
  private bridgeChain: Promise<void> = Promise.resolve();
  private listTimer: ReturnType<typeof setTimeout> | undefined;
  /** Test hook: hold back writes to the bridge so that a conflict can be provoked. */
  bridgeWritesPaused = false;
  private labels = new WeakMap<AnnotFile, string>();

  // ── Derived ─────────────────────────────────────────────────────────────────────────────────
  get canUndo(): boolean {
    return this.past.length > 0 && this.editingId === null;
  }
  get canRedo(): boolean {
    return this.future.length > 0 && this.editingId === null;
  }
  /** What the next undo reverts, when that step has a label (e.g. an agent's changes). */
  get undoLabel(): string | null {
    return (this.file && this.labels.get(this.file)) ?? null;
  }
  /** Agent comments no human has accepted yet. */
  get unreviewed(): Annotation[] {
    return this.annotations.filter((a) => a.origin === 'agent' && !a.reviewed);
  }
  isUnreviewed(id: string): boolean {
    const a = this.annotation(id);
    return !!a && a.origin === 'agent' && !a.reviewed;
  }
  get categories(): Category[] {
    return this.file?.categories ?? [];
  }
  category(id: string): Category | undefined {
    return this.file?.categories.find((c) => c.id === id);
  }
  get annotations(): Annotation[] {
    return this.file?.annotations ?? [];
  }
  annotation(id: string | null): Annotation | undefined {
    return id ? this.file?.annotations.find((a) => a.id === id) : undefined;
  }
  /** Display number of a comment (highlights have none). */
  numberOf(id: string): number | undefined {
    return this.layout?.numbers[id];
  }
  /** Comment IDs in reading order. */
  get commentOrder(): string[] {
    const numbers = this.layout?.numbers ?? {};
    return Object.keys(numbers).sort((a, b) => numbers[a]! - numbers[b]!);
  }
  itemFor(id: string): { page: number; item: PageItem } | undefined {
    for (const p of this.layout?.pages ?? []) {
      const item = p.items.find((i) => i.id === id);
      if (item) return { page: p.page, item };
    }
    return undefined;
  }
  /** Annotations the layout could not place (unresolved or ambiguous anchors). */
  get unplaced(): string[] {
    return this.layout?.diagnostics.unplaced ?? [];
  }
  get overflowPages(): number[] {
    return (this.layout?.diagnostics.overflow ?? []).map((o) => o.page);
  }
  get mathErrorCount(): number {
    return this.layout?.diagnostics.mathErrors.length ?? 0;
  }
  get fileName(): string {
    return this.file?.document.fileName ?? '';
  }

  // ── Startup ─────────────────────────────────────────────────────────────────────────────────

  private ensureFonts(): Promise<FontSet> {
    this.fontsLoading ??= loadFonts().then((f) => (this.fonts = f));
    return this.fontsLoading;
  }

  async init(): Promise<void> {
    await this.ensureFonts();
    try {
      this.storageKind = await storage.kind();
      this.recent = await storage.list();
    } catch {
      this.storageKind = null;
    }
    const conn = connectionFromLocation();
    if (conn) await this.connectBridge(conn);
  }

  toast(text: string, kind: Toast['kind'] = 'info', ms = 5000): void {
    const id = ++this.toastId;
    this.toasts = [...this.toasts, { id, text, kind }];
    setTimeout(() => this.dismissToast(id), ms);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  // ── Opening and closing ─────────────────────────────────────────────────────────────────────

  /** Open dropped or picked files: a PDF, an annotation file, or both. */
  async openFiles(files: File[]): Promise<void> {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    const annot = files.find((f) => /\.json$/i.test(f.name));
    if (pdfs.length === 0 && !annot) {
      this.toast('Drop a PDF and, optionally, its .annot.json file.', 'warn');
      return;
    }
    try {
      // An exported PDF carries its annotation file (§8.2); with the original it is editable again.
      if (!annot && (await this.openExported(pdfs))) return;
      const pdf = pdfs[0];
      if (pdf) {
        await this.openPdf(new Uint8Array(await pdf.arrayBuffer()), pdf.name, annot ? await annot.text() : undefined);
      } else if (annot) {
        await this.openAnnotationOnly(await annot.text());
      }
    } catch (e) {
      this.toast(e instanceof MarginError ? e.message : `Could not open the file: ${(e as Error).message}`, 'error', 9000);
    }
  }

  /**
   * Re-import (§8.2): if one of the PDFs is a Margin export, open its original (attached, dropped
   * along with it, or still in browser storage) with the recovered annotations.
   */
  private async openExported(pdfs: File[]): Promise<boolean> {
    const { importExported } = await import('@margin/core/render-pdf');
    for (const f of pdfs) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const imported = await importExported(bytes).catch(() => undefined);
      if (!imported) continue;
      const { file } = imported;
      let original = imported.original;
      for (const other of pdfs) {
        if (original || other === f) continue;
        const candidate = new Uint8Array(await other.arrayBuffer());
        if ((await sha256Hex(candidate)) === file.document.sha256) original = candidate;
      }
      original ??= (await storage.loadPdf(file.document.sha256)) ?? undefined;
      if (!original) {
        this.toast(`This is an export of ${file.document.fileName}. Drop that original PDF together with it to edit the comments again.`, 'warn', 12000);
        return true;
      }
      await this.openPdf(original, file.document.fileName, serialize(file));
      this.toast('Opened from an exported PDF.');
      return true;
    }
    return false;
  }

  private async openAnnotationOnly(text: string): Promise<void> {
    const file = parseAnnotFile(text);
    if (this.pdf && this.pdf.sha256 === file.document.sha256) {
      this.replaceFile(file, 'import annotations');
      this.toast('Annotations imported.');
      return;
    }
    const stored = await storage.loadPdf(file.document.sha256);
    if (stored) {
      await this.openPdf(stored, file.document.fileName, text);
      return;
    }
    this.toast(`This annotation file belongs to ${file.document.fileName}. Drop that PDF together with it (or after it).`, 'warn', 9000);
  }

  async openStored(sha: string): Promise<void> {
    const bytes = await storage.loadPdf(sha);
    const rec = await storage.find(sha);
    if (!bytes || !rec) {
      this.toast('That document is no longer in browser storage.', 'error');
      this.recent = await storage.list();
      return;
    }
    await this.openPdf(bytes, rec.name);
  }

  async openPdf(bytes: Uint8Array, name: string, annotText?: string, bridge?: { path: string; etag: string | null }): Promise<void> {
    this.loading = 'Opening PDF…';
    try {
      const pdf = await PdfDoc.open(bytes);
      let file: AnnotFile | null = null;
      let mismatch = false;
      if (annotText !== undefined) {
        file = parseAnnotFile(annotText);
        mismatch = file.document.sha256 !== pdf.sha256;
      } else if (!bridge) {
        const stored = await storage.loadAnnotations(pdf.sha256);
        if (stored) {
          try {
            file = parseAnnotFile(stored);
          } catch (e) {
            this.toast(`Stored annotations are invalid and were ignored: ${(e as Error).message}`, 'error', 9000);
          }
        }
      }
      if (!file) {
        file = createAnnotFile(pdf.info(name));
        const defaults = await storage.getSetting<Category[]>('defaultCategories').catch(() => undefined);
        if (defaults?.length) file.categories = defaults.map((c) => ({ ...c }));
      }
      if (!mismatch && needsResolving(file).length) {
        this.loading = 'Resolving anchors…';
        await resolveAll(pdf, { ...file, annotations: needsResolving(file) });
      }
      this.loading = 'Measuring pages…';
      const inks = await measureInk(pdf);
      await this.pdf?.destroy().catch(() => undefined);
      this.texts.clear();
      this.textLoads.clear();
      this.inks = inks;
      this.pdf = pdf;
      this.file = file;
      this.mismatch = mismatch;
      this.past = [];
      this.future = [];
      this.pendingBase = null;
      this.editingId = null;
      this.draft = null;
      this.pending = null;
      this.focusedId = null;
      this.activeCategory = file.categories.find((c) => c.kind === 'comment')?.id ?? file.categories[0]?.id ?? '';
      this.currentPage = 1;
      this.bridgePath = bridge?.path ?? null;
      this.bridgeBase = bridge ? structuredClone(file) : null;
      this.bridgeEtag = bridge?.etag ?? null;
      this.bridgeDirty = false;
      this.conflicts = [];
      this.originFilter = '';
      this.rebuildGeometry();
      this.zoom = this.fitZoom();
      this.fitPending = true;
      await this.relayout();
      await storage.savePdf({ sha: pdf.sha256, name, pageCount: pdf.pageCount }, bytes).catch(() => undefined);
      await this.loadReport();
      this.pseudoMap = (await storage.getSetting<PseudoMap>(`pseudo:${pdf.sha256}`).catch(() => undefined)) ?? null;
      this.pseudo = null;
      this.scheduleSave(false);
      if (mismatch) this.toast('This PDF differs from the one the annotations were made on. Use "Re-anchor" to find the quotes again.', 'warn', 12000);
    } finally {
      this.loading = null;
    }
  }

  async closeDocument(): Promise<void> {
    await this.flushSave();
    await this.bridgeChain;
    await this.pdf?.destroy().catch(() => undefined);
    this.pdf = null;
    this.bridgePath = null;
    this.bridgeBase = null;
    this.conflicts = [];
    this.file = null;
    this.geometry = null;
    this.layout = null;
    this.editingId = null;
    this.draft = null;
    this.pending = null;
    this.recent = await storage.list().catch(() => []);
    if (this.client) void this.refreshBridgeFiles();
  }

  /** "Forget this document" (spec §11). */
  async forget(sha: string): Promise<void> {
    await storage.forget(sha);
    await storage.deleteSetting(`pseudo:${sha}`).catch(() => undefined);
    await storage.deleteSetting(`terms:${sha}`).catch(() => undefined);
    this.recent = await storage.list();
  }

  async clearAllData(): Promise<void> {
    await storage.clearAll();
    this.recent = [];
    this.toast('All data stored by Margin in this browser was deleted.');
  }

  /** Find the quotes of all annotations again in the opened PDF (different revision of the paper). */
  async reanchor(): Promise<void> {
    if (!this.pdf || !this.file) return;
    const file = structuredClone(this.file) as AnnotFile;
    const result = await resolveAll(this.pdf, file, { reanchor: true });
    file.document = this.pdf.info(file.document.fileName);
    const bad = [...result.values()].filter((r) => r.status !== 'ok').length;
    this.mismatch = false;
    this.replaceFile(file, 're-anchor');
    this.toast(bad ? `Re-anchored. ${bad} annotation${bad > 1 ? 's' : ''} could not be found again.` : 'All annotations re-anchored.', bad ? 'warn' : 'info');
  }

  // ── Text access ─────────────────────────────────────────────────────────────────────────────

  textOf(page: number): PageText | undefined {
    return this.texts.get(page);
  }

  ensureText(page: number): Promise<PageText> {
    const have = this.texts.get(page);
    if (have) return Promise.resolve(have);
    let load = this.textLoads.get(page);
    if (!load) {
      load = this.pdf!.text(page).then((t) => {
        this.texts.set(page, t);
        return t;
      });
      this.textLoads.set(page, load);
    }
    return load;
  }

  // ── Geometry and layout ─────────────────────────────────────────────────────────────────────

  private rebuildGeometry(): void {
    if (!this.pdf || !this.file) return;
    const inks = this.file.settings.crop ? this.pdf.pages.map(() => null) : this.inks;
    this.geometry = computeGeometry(this.pdf.pages, inks, this.file.settings);
  }

  /** The file with the in-progress edits (draft text, category, dragged anchor) applied. */
  private effectiveFile(): AnnotFile | null {
    const f = this.file;
    if (!f) return null;
    const draft = this.draft;
    const edit = this.editingId;
    const over = this.anchorOverride;
    if (!(edit && draft) && !over) return f;
    return {
      ...f,
      annotations: f.annotations.map((a) => {
        if (edit && draft && a.id === edit) return { ...a, body: draft.body, category: draft.category };
        if (over && a.id === over.id) return { ...a, anchor: over.anchor };
        return a;
      }),
    };
  }

  async relayout(): Promise<void> {
    const token = ++this.layoutToken;
    const file = this.effectiveFile();
    const geometry = this.geometry;
    if (!file || !geometry) return;
    const fonts = await this.ensureFonts();
    await prepareFileMath(file);
    if (token !== this.layoutToken) return;
    this.layout = computeLayout({ file, geometry, fonts });
  }

  fitZoom(): number {
    const g = this.geometry;
    if (!g) return 1;
    const widest = Math.max(...g.pages.map((p) => p.outWidth));
    return Math.min(2.5, Math.max(0.3, Math.floor(((this.viewerWidth - 48) / widest) * 100) / 100));
  }

  setZoom(z: number): void {
    this.zoom = Math.min(4, Math.max(0.25, z));
  }

  // ── Model changes with history ──────────────────────────────────────────────────────────────

  private afterChange(prev: AnnotFile | null, next: AnnotFile, dirty = true): void {
    if (!prev || prev.settings !== next.settings) this.rebuildGeometry();
    void this.relayout();
    this.scheduleSave(dirty);
  }

  /** Apply a change as one undo step. Returning the same object means "nothing changed". */
  mutate(fn: (f: AnnotFile) => AnnotFile, label?: string): void {
    const prev = this.file;
    if (!prev) return;
    const next = fn(prev);
    if (next === prev) return;
    this.past = [...this.past.slice(-(MAX_HISTORY - 1)), prev];
    this.future = [];
    this.file = next;
    if (label) this.labels.set(next, label);
    this.afterChange(prev, next);
  }

  /** Replace the whole file as one undo step (import, re-anchor). */
  replaceFile(file: AnnotFile, _label: string): void {
    this.mutate(() => file);
  }

  undo(): void {
    if (!this.canUndo) return;
    const prev = this.past[this.past.length - 1]!;
    const cur = this.file!;
    this.past = this.past.slice(0, -1);
    this.future = [...this.future, cur];
    this.file = prev;
    this.afterUndo(cur, prev);
  }

  redo(): void {
    if (!this.canRedo) return;
    const next = this.future[this.future.length - 1]!;
    const cur = this.file!;
    this.future = this.future.slice(0, -1);
    this.past = [...this.past, cur];
    this.file = next;
    this.afterUndo(cur, next);
  }

  private afterUndo(prev: AnnotFile, next: AnnotFile): void {
    if (this.focusedId && !next.annotations.some((a) => a.id === this.focusedId)) this.focusedId = null;
    if (!next.categories.some((c) => c.id === this.activeCategory)) this.activeCategory = next.categories[0]?.id ?? '';
    this.afterChange(prev, next);
  }

  // ── Creating and editing comments ───────────────────────────────────────────────────────────

  setActiveCategory(id: string): void {
    if (this.category(id)) this.activeCategory = id;
  }

  /** Select the n-th category (1-based), as the digit keys do. */
  selectCategoryByIndex(n: number): void {
    const c = this.categories[n - 1];
    if (c) this.setActiveCategory(c.id);
  }

  private newAnnotation(anchor: Anchor, category: string): Annotation {
    const ts = now();
    const taken = new Set(this.annotations.map((a) => a.id));
    return { id: newId(taken), category, anchor, body: '', side: 'auto', origin: 'human', created: ts, modified: ts };
  }

  /**
   * A selection was made: add the annotation in the active category. Highlights are committed at once;
   * comments open an editor and join the history only when committed non-empty (spec §7.2).
   */
  createFromAnchor(anchor: Anchor): void {
    if (!this.file || this.editingId) return;
    const cat = this.category(this.activeCategory) ?? this.categories[0];
    if (!cat) {
      this.toast('Add a category first.', 'warn');
      return;
    }
    const a = this.newAnnotation(anchor, cat.id);
    if (cat.kind === 'highlight') {
      this.mutate((f) => ({ ...f, annotations: [...f.annotations, a] }));
      this.focusedId = a.id;
      return;
    }
    const base = this.file;
    this.pendingBase = base;
    this.file = { ...base, annotations: [...base.annotations, a] };
    this.focusedId = a.id;
    this.editingId = a.id;
    this.draft = { body: '', category: cat.id };
    void this.relayout();
  }

  startEdit(id: string): void {
    const a = this.annotation(id);
    if (!a || this.editingId) return;
    if (this.category(a.category)?.kind === 'highlight') return;
    this.pendingBase = null;
    this.focusedId = id;
    this.editingId = id;
    this.draft = { body: a.body, category: a.category };
    void this.relayout();
  }

  setDraftBody(body: string): void {
    if (!this.draft) return;
    this.draft = { ...this.draft, body };
    void this.relayout();
  }

  /** Ctrl+1…9 while editing: change the category of the comment being edited. */
  setDraftCategoryByIndex(n: number): void {
    const c = this.categories[n - 1];
    if (!c || !this.draft || c.kind === 'highlight') return;
    this.draft = { ...this.draft, category: c.id };
    this.activeCategory = c.id;
    void this.relayout();
  }

  /** Enter or Esc: commit the editor. An empty comment is deleted (spec §7.2). */
  commitEdit(): void {
    const id = this.editingId;
    const draft = this.draft;
    if (!id || !draft) return;
    const base = this.pendingBase;
    const empty = draft.body.trim() === '';
    this.editingId = null;
    this.draft = null;
    this.pendingBase = null;
    if (base) {
      // New comment: discard it if empty, else it becomes one history step from the file before it.
      if (empty) {
        this.file = base;
        this.focusedId = null;
        this.afterChange(null, base);
        return;
      }
      const added = this.file!;
      const next: AnnotFile = {
        ...added,
        annotations: added.annotations.map((a) => (a.id === id ? { ...a, body: draft.body.trim(), category: draft.category, modified: now() } : a)),
      };
      this.past = [...this.past.slice(-(MAX_HISTORY - 1)), base];
      this.future = [];
      this.file = next;
      this.afterChange(added, next);
      return;
    }
    if (empty) {
      this.deleteAnnotation(id);
      return;
    }
    const cur = this.annotation(id);
    if (cur && cur.body === draft.body.trim() && cur.category === draft.category) {
      void this.relayout();
      return;
    }
    // Changing an agent's comment is a review of it.
    this.mutate((f) => ({
      ...f,
      annotations: f.annotations.map((a) => (a.id === id ? { ...a, body: draft.body.trim(), category: draft.category, modified: now(), ...(a.origin === 'agent' ? { reviewed: true } : {}) } : a)),
    }));
  }

  // ── Reviewing agent comments (spec §9.4) ────────────────────────────────────────────────────

  /** Enter on a focused agent comment: mark it reviewed. */
  acceptComment(id: string): void {
    if (!this.isUnreviewed(id)) return;
    this.mutate((f) => ({ ...f, annotations: f.annotations.map((a) => (a.id === id ? { ...a, reviewed: true, modified: now() } : a)) }), 'accept comment');
  }

  /** "Accept all on page". */
  acceptAllOnPage(page: number): void {
    const ids = new Set(this.unreviewed.filter((a) => a.anchor.page === page).map((a) => a.id));
    if (!ids.size) return;
    this.mutate((f) => ({ ...f, annotations: f.annotations.map((a) => (ids.has(a.id) ? { ...a, reviewed: true, modified: now() } : a)) }), `accept ${ids.size} on page ${page}`);
  }

  acceptAll(): void {
    const ids = new Set(this.unreviewed.map((a) => a.id));
    if (!ids.size) return;
    this.mutate((f) => ({ ...f, annotations: f.annotations.map((a) => (ids.has(a.id) ? { ...a, reviewed: true, modified: now() } : a)) }), `accept ${ids.size} comments`);
  }

  // ── Conflicts (spec §9.3) ───────────────────────────────────────────────────────────────────

  /** Put the local version that lost against the disk back (or, if it had been deleted, delete again). */
  restoreConflict(c: Conflict): void {
    if (c.local) {
      const local = c.local;
      this.mutate((f) => ({ ...f, annotations: f.annotations.some((a) => a.id === c.id) ? f.annotations.map((a) => (a.id === c.id ? local : a)) : [...f.annotations, local] }), 'restore my version');
    } else {
      this.mutate((f) => ({ ...f, annotations: f.annotations.filter((a) => a.id !== c.id) }), 'restore my deletion');
    }
    this.dismissConflict(c.id);
  }

  dismissConflict(id: string): void {
    this.conflicts = this.conflicts.filter((c) => c.id !== id);
  }

  deleteAnnotation(id: string): void {
    if (this.editingId) return;
    this.mutate((f) => ({ ...f, annotations: f.annotations.filter((a) => a.id !== id) }));
    if (this.focusedId === id) this.focusedId = null;
  }

  /** Alt+L / Alt+R: pin to a margin; again to unpin. */
  togglePin(id: string, side: Exclude<Side, 'auto'>): void {
    const a = this.annotation(id);
    if (!a) return;
    const next: Side = a.side === side ? 'auto' : side;
    this.mutate((f) => ({ ...f, annotations: f.annotations.map((x) => (x.id === id ? { ...x, side: next, modified: now() } : x)) }));
  }

  setAnnotationCategory(id: string, category: string): void {
    this.mutate((f) => ({ ...f, annotations: f.annotations.map((x) => (x.id === id ? { ...x, category, modified: now() } : x)) }));
  }

  /** Commit a dragged anchor end (one undo step). */
  commitAnchor(id: string, anchor: Anchor): void {
    this.anchorOverride = null;
    this.mutate((f) => ({ ...f, annotations: f.annotations.map((x) => (x.id === id ? { ...x, anchor, modified: now() } : x)) }));
  }

  setAnchorOverride(o: { id: string; anchor: Anchor } | null): void {
    this.anchorOverride = o;
    void this.relayout();
  }

  // ── Focus and navigation ────────────────────────────────────────────────────────────────────

  focus(id: string | null): void {
    this.focusedId = id;
  }

  /** Tab / Shift+Tab: next or previous comment in reading order. */
  focusRelative(dir: 1 | -1): void {
    const order = this.commentOrder;
    if (order.length === 0) return;
    const i = this.focusedId ? order.indexOf(this.focusedId) : -1;
    const next = i < 0 ? (dir === 1 ? 0 : order.length - 1) : (i + dir + order.length) % order.length;
    this.focusedId = order[next]!;
    this.reveal(order[next]!);
  }

  /** Scroll so the annotation is visible. */
  reveal(id: string): void {
    const hit = this.itemFor(id);
    if (hit) {
      const y = hit.item.box ? hit.item.box[1] : (hit.item.anchor[0]?.[1] ?? 0);
      this.scrollTarget = { page: hit.page, y, nonce: ++this.scrollNonce };
      return;
    }
    const a = this.annotation(id);
    if (a?.anchor.page) this.scrollTarget = { page: a.anchor.page, y: 0, nonce: ++this.scrollNonce };
  }

  goToPage(page: number): void {
    this.scrollTarget = { page, y: 0, nonce: ++this.scrollNonce };
  }

  // ── Search (Ctrl+F): PDF text and comment bodies ────────────────────────────────────────────

  async runSearch(query: string): Promise<void> {
    this.searchQuery = query;
    const q = query.trim();
    if (!q || !this.pdf) {
      this.searchHits = [];
      this.searchIndex = 0;
      return;
    }
    const needle = normalizeQuote(q).toLowerCase();
    const hits: SearchHit[] = [];
    for (let p = 1; p <= this.pdf.pageCount; p++) {
      const text = await this.ensureText(p);
      if (query !== this.searchQuery) return; // a newer query superseded this one
      for (const m of new PageIndex(text).find(needle, { ignoreCase: true })) hits.push({ kind: 'text', page: p, quads: quadsForRange(text, m.start, m.end) });
    }
    const lower = q.toLowerCase();
    for (const id of this.commentOrder) {
      if (this.annotation(id)?.body.toLowerCase().includes(lower)) hits.push({ kind: 'comment', id });
    }
    this.searchHits = hits;
    this.searchIndex = 0;
    if (hits.length) this.revealHit(0);
  }

  stepSearch(dir: 1 | -1): void {
    const n = this.searchHits.length;
    if (!n) return;
    this.searchIndex = (this.searchIndex + dir + n) % n;
    this.revealHit(this.searchIndex);
  }

  private revealHit(i: number): void {
    const h = this.searchHits[i];
    if (!h) return;
    if (h.kind === 'comment') {
      this.focusedId = h.id;
      this.reveal(h.id);
      return;
    }
    const g = this.geometry?.pages[h.page - 1];
    const q = h.quads[0];
    this.scrollTarget = { page: h.page, y: g && q ? g.oy + g.s * q[1] : 0, nonce: ++this.scrollNonce };
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.searchHits = [];
    this.searchIndex = 0;
    this.searchOpen = false;
  }

  // ── Categories and settings ─────────────────────────────────────────────────────────────────

  updateSettings(patch: Partial<Settings>): void {
    this.mutate((f) => ({ ...f, settings: { ...f.settings, ...patch } }));
  }

  clearCrop(): void {
    this.mutate((f) => {
      const { crop: _crop, ...rest } = f.settings;
      return { ...f, settings: rest as Settings };
    });
  }

  private setCategories(fn: (c: Category[]) => Category[]): void {
    this.mutate((f) => ({ ...f, categories: fn(f.categories) }));
    if (this.file) void storage.setSetting('defaultCategories', $state.snapshot(this.file.categories)).catch(() => undefined);
  }

  addCategory(c: CategoryInput): string {
    const base = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';
    const taken = new Set(this.categories.map((x) => x.id));
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    this.setCategories((cs) => [...cs, { ...c, id }]);
    return id;
  }

  updateCategory(id: string, patch: Partial<CategoryInput>): void {
    this.setCategories((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  removeCategory(id: string): boolean {
    if (this.annotations.some((a) => a.category === id)) {
      this.toast('That category is still used by annotations; change or delete them first.', 'warn');
      return false;
    }
    this.setCategories((cs) => cs.filter((c) => c.id !== id));
    if (this.activeCategory === id) this.activeCategory = this.categories[0]?.id ?? '';
    return true;
  }

  moveCategory(id: string, dir: -1 | 1): void {
    this.setCategories((cs) => {
      const i = cs.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cs.length) return cs;
      const out = [...cs];
      [out[i], out[j]] = [out[j]!, out[i]!];
      return out;
    });
  }

  resetDefaultCategories(): void {
    this.setCategories(() => DEFAULT_CATEGORIES.map((c) => ({ ...c })));
  }

  // ── Bridge: connection, live sync and merge (spec §9.3) ─────────────────────────────────────

  async connectBridge(conn: BridgeConnection): Promise<boolean> {
    this.disconnectBridge();
    const client = new BridgeClient(conn);
    try {
      const { dir, files } = await client.files();
      this.client = client;
      this.bridge = { origin: conn.origin, dir, files, online: true };
    } catch (e) {
      forgetConnection();
      this.toast(e instanceof BridgeError && e.status === 401 ? 'The bridge refused the token. Use the URL printed by margin serve.' : `Cannot connect to the bridge: ${(e as Error).message}`, 'error', 9000);
      return false;
    }
    this.stopFollowing = client.follow(
      (ev) => this.onBridgeEvent(ev),
      (online) => this.onBridgeStatus(online),
    );
    return true;
  }

  disconnectBridge(): void {
    this.stopFollowing?.();
    this.stopFollowing = undefined;
    this.client = null;
    this.bridge = null;
    this.bridgePath = null;
    forgetConnection();
  }

  private async refreshBridgeFiles(): Promise<void> {
    if (!this.client || !this.bridge) return;
    try {
      const { files } = await this.client.files();
      if (this.bridge) this.bridge = { ...this.bridge, files };
    } catch {
      /* offline: the status shows it */
    }
  }

  /** Open a PDF from the bridge directory, with its annotation file if it has one. */
  async openFromBridge(path: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.loading = 'Opening from the bridge…';
    try {
      const [bytes, annot] = await Promise.all([client.pdf(path), client.annot(path)]);
      await this.openPdf(bytes, path.split('/').pop()!, annot?.text, { path, etag: annot?.etag ?? null });
    } catch (e) {
      this.toast(e instanceof MarginError || e instanceof BridgeError ? e.message : `Could not open ${path}: ${(e as Error).message}`, 'error', 9000);
    } finally {
      this.loading = null;
    }
  }

  private onBridgeStatus(online: boolean): void {
    if (!this.bridge) return;
    const was = this.bridge.online;
    this.bridge = { ...this.bridge, online };
    if (online) {
      void this.refreshBridgeFiles();
      // Catch up on whatever changed while the stream was down.
      if (this.bridgePath) void this.enqueue(() => this.pullBridge());
    } else if (was) {
      this.toast('Lost the connection to the bridge; retrying…', 'warn');
    }
  }

  private onBridgeEvent(ev: BridgeEvent): void {
    if (ev.kind === 'annot' && ev.path === this.bridgePath) {
      const own = ev.etag ? this.ownEtags.indexOf(ev.etag) : -1;
      if (own >= 0) {
        this.ownEtags.splice(own, 1);
        return;
      }
      if (ev.etag === this.bridgeEtag) return;
      void this.enqueue(() => this.pullBridge());
      return;
    }
    if (ev.kind === 'pdf' && ev.path === this.bridgePath && ev.etag !== this.pdf?.sha256) {
      this.toast('The PDF changed on disk. Reopen it from the start screen to use the new version.', 'warn', 9000);
    }
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => void this.refreshBridgeFiles(), 250);
  }

  /** Bridge operations run one at a time so that a pull never interleaves with a write. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.bridgeChain = this.bridgeChain.then(fn).catch((e) => this.toast(`Bridge: ${(e as Error).message}`, 'error', 9000));
    return this.bridgeChain;
  }

  /** Write the annotation file through the bridge; if the disk moved on meanwhile, merge and retry. */
  private async writeBridge(): Promise<void> {
    const client = this.client;
    const path = this.bridgePath;
    if (!client || !path || !this.bridgeDirty) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const file = this.persistable();
      if (!file) return;
      const text = serialize(file);
      const tag = await sha256Hex(encoder.encode(text));
      this.ownEtags = [...this.ownEtags.slice(-19), tag];
      const r = await client.putAnnot(path, text, this.bridgeEtag);
      if (r.ok) {
        this.bridgeEtag = r.etag;
        this.bridgeBase = file;
        this.bridgeDirty = this.persistable() !== file;
        return;
      }
      this.ownEtags = this.ownEtags.filter((t) => t !== tag);
      await this.pullBridge();
    }
    this.toast('The annotation file keeps changing on disk; your latest change is not written yet.', 'warn', 9000);
  }

  /** Read the annotation file from the bridge and merge what changed there into the open document. */
  private async pullBridge(): Promise<void> {
    const client = this.client;
    const path = this.bridgePath;
    const pdf = this.pdf;
    const local = this.file;
    const base = this.bridgeBase;
    if (!client || !path || !pdf || !local || !base) return;
    const got = await client.annot(path);
    if (!got) {
      this.bridgeEtag = null;
      this.bridgeDirty = true;
      this.toast('The annotation file was removed from disk; it is written again with the next change.', 'warn');
      return;
    }
    if (got.etag === this.bridgeEtag) return;
    let disk: AnnotFile;
    try {
      disk = parseAnnotFile(got.text);
    } catch (e) {
      this.bridgeEtag = got.etag;
      this.toast(`The annotation file on disk is invalid and was ignored: ${(e as Error).message}`, 'error', 9000);
      return;
    }
    // Annotations written without geometry (by an agent) are resolved before they are compared or shown.
    const todo = needsResolving(disk);
    if (todo.length && !this.mismatch) await resolveAll(pdf, { ...disk, annotations: todo });
    if (this.file !== local) {
      // The user changed something while we were reading; merge against the newest state instead.
      return this.pullBridge();
    }
    const merged = mergeExternal(base, local, disk);
    this.bridgeBase = disk;
    this.bridgeEtag = got.etag;
    this.bridgeDirty = !sameValue(merged.file, disk);
    let conflicts = merged.conflicts;
    if (this.pendingBase) this.pendingBase = mergeExternal(base, this.pendingBase, disk).file;
    // A comment being edited that the disk deleted: keep the typed text as a conflict.
    const editing = this.editingId;
    if (editing && this.draft && !this.pendingBase && !merged.file.annotations.some((a) => a.id === editing)) {
      const gone = local.annotations.find((a) => a.id === editing);
      if (gone) conflicts = [...conflicts, { id: editing, local: { ...gone, body: this.draft.body, category: this.draft.category }, disk: null }];
      this.editingId = null;
      this.draft = null;
    }
    if (conflicts.length) {
      this.conflicts = [...this.conflicts.filter((c) => !conflicts.some((n) => n.id === c.id)), ...conflicts];
      this.toast(`${conflicts.length} comment${conflicts.length > 1 ? 's were' : ' was'} changed both here and on disk. The disk version was kept; yours is listed under Conflicts.`, 'warn', 9000);
    }
    if (!merged.changed) {
      if (this.bridgeDirty) this.scheduleSave();
      return;
    }
    const byAgent = [...merged.summary.added, ...merged.summary.edited].some((id) => merged.file.annotations.find((a) => a.id === id)?.origin === 'agent');
    const label = `${byAgent ? 'agent' : 'disk'}: ${describeMerge(merged.summary)}`;
    this.past = [...this.past.slice(-(MAX_HISTORY - 1)), local];
    this.future = [];
    this.file = merged.file;
    this.labels.set(merged.file, label);
    if (this.focusedId && !merged.file.annotations.some((a) => a.id === this.focusedId)) this.focusedId = null;
    if (!merged.file.categories.some((c) => c.id === this.activeCategory)) this.activeCategory = merged.file.categories[0]?.id ?? '';
    this.afterChange(local, merged.file, this.bridgeDirty);
    this.toast(`${label} (Ctrl+Z undoes it)`);
  }

  // ── Persistence, download and export ────────────────────────────────────────────────────────

  private persistable(): AnnotFile | null {
    return this.pendingBase ?? this.file;
  }

  /** Autosave soon. A change (not merely opening) also marks the file for writing through the bridge. */
  scheduleSave(change = true): void {
    if (change) this.bridgeDirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushSave(), 300);
  }

  async flushSave(): Promise<void> {
    clearTimeout(this.saveTimer);
    const f = this.persistable();
    if (!f || !this.pdf) return;
    try {
      await storage.saveAnnotations(this.pdf.sha256, serialize(f));
    } catch (e) {
      this.toast(`Could not save to browser storage: ${(e as Error).message}`, 'error');
    }
    if (this.client && this.bridgePath && this.bridgeDirty && !this.bridgeWritesPaused) await this.enqueue(() => this.writeBridge());
  }

  /** "Save annotations": download the .annot.json (spec §7.6). */
  async downloadAnnotations(): Promise<void> {
    const f = this.persistable();
    if (!f) return;
    const target = await chooseTarget(f.document.fileName.replace(/\.pdf$/i, '') + '.annot.json', 'application/json');
    if (target) await writeTarget(target, new Blob([serialize(f)], { type: 'application/json' }));
  }

  // ── Grading report (§8.4) ───────────────────────────────────────────────────────────────────

  /** The compiled report PDF, kept in browser storage next to the paper. */
  report = $state<{ bytes: Uint8Array; pages: number } | null>(null);

  private async loadReport(): Promise<void> {
    this.report = null;
    const ref = this.file?.report;
    if (!ref || !this.pdf) return;
    const bytes = await storage.loadReport(this.pdf.sha256).catch(() => null);
    if (!bytes) {
      this.toast(`The grading report ${ref.fileName} is not in this browser; attach it again in Settings.`, 'warn', 9000);
    } else if ((await sha256Hex(bytes)) !== ref.sha256) {
      this.toast(`The stored grading report differs from ${ref.fileName} named in the annotations; attach it again in Settings.`, 'warn', 9000);
    } else {
      this.report = { bytes, pages: await pageCountOf(bytes) };
    }
  }

  async attachReport(file: File): Promise<void> {
    if (!this.pdf) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pages = await pageCountOf(bytes);
      await storage.saveReport(this.pdf.sha256, bytes);
      const sha256 = await sha256Hex(bytes);
      const position = this.file?.report?.position ?? 'before';
      this.mutate((f) => ({ ...f, report: { fileName: file.name, sha256, position } }), 'attach grading report');
      this.report = { bytes, pages };
    } catch (e) {
      this.toast(`Could not use that file as a report: ${(e as Error).message}`, 'error', 9000);
    }
  }

  setReportPosition(position: 'before' | 'after'): void {
    this.mutate((f) => (f.report ? { ...f, report: { ...f.report, position } } : f), 'move grading report');
  }

  /** Detach the report from the document. The stored copy stays, so undo can bring it back. */
  removeReport(): void {
    this.mutate((f) => {
      const { report: _r, ...rest } = f;
      return rest as AnnotFile;
    }, 'remove grading report');
  }

  exporting = $state(false);

  /** Export the flattened PDF in a Web Worker and download it (spec §8.3). */
  async exportPdf(): Promise<void> {
    const file = this.persistable();
    if (!file || !this.pdf || !this.geometry || this.exporting) return;
    if (this.editingId) this.commitEdit();
    // Ask where to save first: the picker needs the click that started the export (§8.3).
    const name = file.document.fileName.replace(/\.pdf$/i, '') + '.annotated.pdf';
    const target = await chooseTarget(name, 'application/pdf');
    if (!target) return;
    this.exporting = true;
    try {
      await this.relayout();
      const layout = this.layout!;
      const open = this.unreviewed.length;
      if (open) this.toast(`${open} agent comment${open > 1 ? 's are' : ' is'} not reviewed yet. ${open > 1 ? 'They are' : 'It is'} in the export.`, 'warn', 9000);
      if (this.unplaced.length) this.toast(`${this.unplaced.length} annotation${this.unplaced.length > 1 ? 's have' : ' has'} no anchor and ${this.unplaced.length > 1 ? 'are' : 'is'} not in the export.`, 'warn');
      const bytes = await exportInWorker({
        pdfBytes: this.pdf.bytes,
        file: $state.snapshot(this.file!) as AnnotFile,
        layout: { pages: $state.snapshot(layout.pages), numbers: $state.snapshot(layout.numbers) } as LayoutResult,
        geometry: $state.snapshot(this.geometry) as DocGeometry,
        fonts: await loadFontBytes(),
        producer: 'Margin 0.1.0',
        ...(this.report && file.report ? { report: { bytes: this.report.bytes, position: file.report.position } } : {}),
      });
      const spilled = layout.pages.filter((p) => p.overflow.length).length;
      if (spilled) this.toast(`${spilled} page${spilled > 1 ? 's have' : ' has'} comments on notes pages after ${spilled > 1 ? 'them' : 'it'}.`, 'warn');
      await writeTarget(target, new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    } catch (e) {
      this.toast(`Export failed: ${(e as Error).message}`, 'error', 9000);
    } finally {
      this.exporting = false;
    }
  }

  // ── Pseudonymization (spec §10) ─────────────────────────────────────────────────────────────

  pseudoOpen = $state(false);
  /** The run in progress or finished: review data, or verification problems. */
  pseudo = $state<
    | null
    | { phase: 'running'; step: string }
    | { phase: 'failed'; message: string; problems: Problem[] }
    | { phase: 'review'; bytes: Uint8Array; fileName: string; map: PseudoMap; annotations: AnnotFile | null; matches: TermMatch[]; scrubbed: string[] }
  >(null);
  /** Mapping of the open document, if it is a pseudonymized copy made in this browser. */
  pseudoMap = $state<PseudoMap | null>(null);

  async loadTerms(): Promise<string> {
    if (!this.pdf) return '';
    return (await storage.getSetting<string>(`terms:${this.pdf.sha256}`).catch(() => undefined)) ?? '';
  }

  async saveTerms(text: string): Promise<void> {
    if (this.pdf) await storage.setSetting(`terms:${this.pdf.sha256}`, text).catch(() => undefined);
  }

  async termSuggestions(): Promise<TermSuggestion[]> {
    if (!this.pdf) return [];
    const { suggestTerms } = await import('@margin/core/pseudo');
    return suggestTerms(await this.pdf.allText());
  }

  /** Redact in a worker, verify here, and keep the result for the review screen (§10.4). */
  async runPseudonymize(termsText: string): Promise<void> {
    const pdf = this.pdf;
    const file = this.persistable();
    if (!pdf || !file) return;
    const core = await import('@margin/core/pseudo');
    let groups: TermGroup[];
    try {
      groups = core.parseTerms(termsText);
      if (groups.length === 0) throw new MarginError('terms-invalid', 'Add at least one term group.');
    } catch (e) {
      this.pseudo = { phase: 'failed', message: (e as Error).message, problems: [] };
      return;
    }
    await this.saveTerms(termsText);
    try {
      this.pseudo = { phase: 'running', step: 'Reading the text…' };
      const texts = await pdf.allText();
      this.pseudo = { phase: 'running', step: 'Removing the terms…' };
      const r = await redactInWorker({ pdfBytes: pdf.bytes, texts: $state.snapshot(texts) as PageText[], groups, fonts: await loadFontBytes() });
      this.pseudo = { phase: 'running', step: 'Verifying…' };
      const problems = await core.verifyRedaction(r.bytes, groups);
      if (problems.length) {
        this.pseudo = { phase: 'failed', message: 'Verification failed: the redacted file still contains personal data. Nothing was saved.', problems };
        return;
      }
      const fileName = core.pseudoFileName(file.document.fileName, groups);
      const redacted = await PdfDoc.open(r.bytes.slice());
      const info = redacted.info(fileName);
      await redacted.destroy();
      const map = core.createPseudoMap(pdf.sha256, info.sha256, groups);
      const annotations = file.annotations.length ? core.pseudonymizeAnnotations($state.snapshot(file) as AnnotFile, groups, info) : null;
      this.pseudo = { phase: 'review', bytes: r.bytes, fileName, map, annotations, matches: r.matches, scrubbed: r.scrubbed };
    } catch (e) {
      this.pseudo = { phase: 'failed', message: (e as Error).message, problems: [] };
    }
  }

  async savePseudoPdf(): Promise<void> {
    const p = this.pseudo;
    if (p?.phase !== 'review') return;
    await storage.setSetting(`pseudo:${p.map.redactedSha256}`, $state.snapshot(p.map));
    const target = await chooseTarget(p.fileName, 'application/pdf');
    if (target) await writeTarget(target, new Blob([p.bytes as BlobPart], { type: 'application/pdf' }));
  }

  async savePseudoMap(): Promise<void> {
    const p = this.pseudo;
    if (p?.phase !== 'review') return;
    const { serializePseudoMap } = await import('@margin/core/pseudo');
    const target = await chooseTarget(p.fileName.replace(/\.pdf$/i, '') + '.json', 'application/json');
    if (target) await writeTarget(target, new Blob([serializePseudoMap($state.snapshot(p.map) as PseudoMap)], { type: 'application/json' }));
  }

  async savePseudoAnnotations(): Promise<void> {
    const p = this.pseudo;
    if (p?.phase !== 'review' || !p.annotations) return;
    const target = await chooseTarget(p.fileName.replace(/\.pdf$/i, '') + '.annot.json', 'application/json');
    if (target) await writeTarget(target, new Blob([serialize($state.snapshot(p.annotations) as AnnotFile)], { type: 'application/json' }));
  }

  /** Continue on the pseudonymized copy in this browser; its mapping is kept for the way back. */
  async openPseudonymized(): Promise<void> {
    const p = this.pseudo;
    if (p?.phase !== 'review') return;
    await storage.setSetting(`pseudo:${p.map.redactedSha256}`, $state.snapshot(p.map));
    const annotations = p.annotations ? serialize($state.snapshot(p.annotations) as AnnotFile) : undefined;
    this.pseudoOpen = false;
    await this.flushSave();
    await this.openPdf(p.bytes.slice(), p.fileName, annotations);
  }

  /** Copy the comments of this pseudonymized copy back to its original (§10.5) and open that. */
  async restoreToOriginal(): Promise<void> {
    const map = this.pseudoMap;
    const file = this.persistable();
    if (!map || !file || !this.pdf) return;
    const original = await storage.loadPdf(map.originalSha256);
    if (!original) {
      this.toast('The original PDF is no longer in this browser. Open it once, then try again.', 'error', 9000);
      return;
    }
    try {
      const { restoreAnnotations } = await import('@margin/core/pseudo');
      const rec = await storage.find(map.originalSha256);
      const doc = await PdfDoc.open(original.slice());
      const texts = await doc.allText();
      const info = doc.info(rec?.name ?? 'original.pdf');
      await doc.destroy();
      const stored = await storage.loadAnnotations(map.originalSha256);
      const existing = stored ? parseAnnotFile(stored) : undefined;
      const restored = restoreAnnotations($state.snapshot(file) as AnnotFile, $state.snapshot(map) as PseudoMap, { original: { info, texts }, ...(existing ? { existing } : {}) });
      await this.flushSave();
      await this.openPdf(original, info.fileName, serialize(restored));
      this.toast(`${file.annotations.length} comment${file.annotations.length === 1 ? '' : 's'} transferred to the original.`);
    } catch (e) {
      this.toast(e instanceof MarginError ? e.message : `Could not transfer the comments: ${(e as Error).message}`, 'error', 9000);
    }
  }
}

export const app = new App();
