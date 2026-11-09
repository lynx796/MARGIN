# AGENTS.md — developing Margin

Margin is a local-first PDF grading annotator. The full specification is `margin-spec.md`; read the
section relevant to your task before changing behavior. This file is for agents *developing* Margin.
(Agents *using* Margin read `margin agent-guide` instead.)

## Commands

```sh
pnpm install                 # once
pnpm test                    # all unit, property, golden and acceptance tests (Vitest, ~5 s)
pnpm test:e2e                # Playwright in Chromium and Firefox against the production build (~1 min)
pnpm dev                     # web app dev server (http://localhost:5173); open with ?e2e for test hooks
pnpm typecheck               # tsc -b for core and cli, svelte-check for web
pnpm margin <command> …      # run the CLI from source, e.g. pnpm margin read fixtures/plain/plain.pdf
pnpm --filter @margin/web build && pnpm margin serve --dir <dir>   # bridge + app on one origin, prints the token URL
pnpm fixtures:build          # recompile fixture PDFs from their .tex sources (needs latexmk)
pnpm fixtures:annotate       # rebuild fixtures/*/<name>.annot.json from fixtures/*/ops.json
pnpm golden:update           # regenerate golden outputs after an intended layout change; review the diff
pnpm validator:build         # regenerate core's standalone schema validator after editing schema/
```

First time: `pnpm exec playwright install chromium firefox`.

`MARGIN_NOW` (ISO timestamp) and `MARGIN_SEED` (integer) pin timestamps and new IDs in the CLI.
`MARGIN_DEBUG=1` prints stack traces for internal errors.

## Packages

| Package | Role |
| --- | --- |
| `packages/core` | All logic. Framework-free TypeScript, runs in browser and Node. |
| `packages/cli` | The `margin` command. Thin wrapper: file I/O, argument parsing, PNG encoding. `src/agent-guide.md` is what `margin agent-guide` prints. |
| `packages/bridge` | `margin serve`: HTTP server on 127.0.0.1 (Node only) for PDFs and annotation files of one directory, SSE change stream, static app with the CSP header. |
| `packages/web` | Svelte 5 + Vite single-page app: viewer, SVG overlay, CodeMirror editor, panels, storage. |

### Bridge (`packages/bridge`, spec §9.3)

- API under `/api/` (`files`, `pdf`, `annot` GET/PUT, `events` SSE). Every request needs
  `Authorization: Bearer <token>`; the Host must be loopback; browsers' `Origin` must be the bridge itself
  or an `--allow-origin`. Paths are confined to the directory (no dotfiles, no symlink escapes, only
  `.pdf` / `.annot.json`). `GET annot` answers 204, not 404, when there is no file yet.
- ETag = SHA-256 of the file text. `PUT` takes `If-Match`; a stale one gets 412 and the app merges and
  retries, so a write never overwrites an agent's change made in the meantime.
- The CSP lives in `bridge/src/csp.ts`; `vite.config.ts` injects the same string as a meta tag.
- Tests: `packages/bridge/test` (access control, traversal, preflight, SSE); the browser side is covered by
  `packages/web/e2e/bridge.spec.ts`, which starts a real `margin serve` and uses the CLI as the agent.

### Web app (`packages/web/src`)

| File | Role |
| --- | --- |
| `lib/state.svelte.ts` | The one store: document, undo history, creating/editing comments, categories, settings, search, autosave, export. Model changes are immutable snapshots; `mutate()` makes one undo step. |
| `lib/selection.ts` | Text selection on the core's character boxes (pure, unit-tested). The browser's own selection is not used. |
| `lib/mathcm.ts` | CodeMirror extensions: math widgets, floating preview, `@` picker, key handling. |
| `lib/bridge.ts` | Client of the bridge: token handling, list/read/write, reconnecting event stream. |
| `lib/storage.ts` | OPFS (IndexedDB fallback) for PDFs and annotations, IndexedDB index and settings. |
| `lib/export.worker.ts` | PDF export off the main thread. |
| `components/PageView.svelte` | One page: canvas drawn with transform T, overlay, editor, pointer interaction. |
| `components/Overlay.svelte` | The page's display list as SVG (glyph runs carry one x per character). |

Rules for the web app:

- Never lay out or measure text in the DOM. The overlay only *draws* the display list; positions come
  from `computeLayout`. The comment editor's wrapping is approximate on purpose; the committed layout
  is the core's.
- Highlights go in a separate `<svg class="under">` without a z-index, so `mix-blend-mode: multiply`
  blends with the canvas below, as the export does.
- The production build ships the CSP of spec §11 (`vite.config.ts`). Nothing may need `unsafe-eval`
  (hence the standalone validator), inline data: fonts, or a network request.
- Keys inside the editor are bound at `Prec.highest` so autocomplete cannot swallow Enter/Esc.
- Tests find text on screen through `window.__margin` (only with `?e2e` in the URL).
- Live sync (`state.svelte.ts`, "Bridge" section): external changes are merged with core's
  `mergeExternal(base, local, disk)` by annotation ID and enter the undo history as one labeled step.
  `base` is the file as last exchanged with the disk, and annotations lacking geometry are resolved
  *before* comparing, so resolution never shows up as a change. Bridge reads and writes run through one
  queue. Do not read response headers other than via the body: the ETag is hashed client-side because a
  cross-origin page cannot see it.
- Agent comments (`origin: agent`, not `reviewed`) get a dashed outline and an "AI" badge in `Overlay.svelte`
  only. Those marks are screen-only; they are not in the display list and never in the export.
  Accept with Enter, the badge, or "Accept all on page"; editing a comment also accepts it.

## Core modules (`packages/core/src`)

| Module | Responsibility |
| --- | --- |
| `model` | Types, schema validation, migrations, stable IDs, canonical serialization |
| `pdf` | Loading via pdf.js, page sizes, text extraction with character boxes, rasterization |
| `anchor` | Quote normalization, resolving anchors (quote ⇄ quads) |
| `geometry` | Crop box from ink, enlargement factor k, scale s, transform T, margin columns |
| `text` | Comment markup parser, font metrics, line breaking, comment boxes |
| `math` | MathJax 4 SVG rendering with cache, SVG → flat paths |
| `layout` | Anchor marks, column assignment, PAVA placement, leaders, numbering → display list |
| `render-pdf` | Display list → PDF via pdf-lib |
| `ops.ts` | add / edit / rm as one validated, atomic batch (shared by CLI and UI) |
| `merge` | Three-way merge of an externally changed annotation file by ID; conflicts keep the losing local version |
| `check.ts` | Problems reported by `margin check` |
| `pipeline.ts` | Glue: PDF → ink → geometry, resolve all anchors, prepare math, layout |

The **display list** (`layout/types.ts`) is the contract between layout and rendering.

Implementation notes that are not obvious from the spec:

- Character boxes come from replaying pdf.js operator lists (`pdf/extract.ts`), not from
  `getTextContent`, which only reports runs. Box heights use fixed ascent/descent fractions so a
  quad's baseline is recoverable (`baselineOf`).
- Quote resolution tries an exact match, then a fuzzy one (edit distance ≤ 10 % of the quote, extended to
  whole words) and accepts it only if unique; a fuzzy match rewrites `quote.exact` to the paper's own words.
- IDs use Crockford base32 (`0-9a-z` without `i l o u`), which matches the spec's examples.
- Fonts are handled by `@cantoo/fontkit` for both metrics and embedding (`@pdf-lib/fontkit`
  crashes when subsetting Fira with `@cantoo/pdf-lib`).
- Rotated pages are rejected by export for now (`rotated-page`).
- Math glyph ranges are loaded on demand by MathJax (no preloading); the web app maps their module
  names to bundled chunks with `setMathModuleLoader` (`web/src/lib/setup.ts`).
- The schema validator is generated (`core/src/model/validator.generated.js`); a test fails if it is
  stale. `load.ts` imports the schema with a JSON import attribute so plain Node ESM can load core.
- `svelte-check` needs TypeScript 6, so `packages/web` pins `typescript@~6` next to the root's 7.

## Invariants — do not break these

- `core` has **no DOM and no Node imports** (`node:*`, `fs`, `document`, `window`, …). Fonts and PDF
  bytes are passed in by the adapter. `core/src/invariants.test.ts` enforces this.
- Layout is **pure and deterministic**: same inputs → byte-identical `layout.json`. No `Date.now()`,
  no `Math.random()` (except ID generation, which takes an injectable RNG), no iteration over
  unordered data without sorting.
- **Never measure text via the DOM.** Widths come from fontkit metrics; math boxes from MathJax SVG.
- Math rendering is async (MathJax loads glyph ranges lazily); layout is sync. Call
  `prepareMath()` for all bodies first; layout reads only the cache.
- Errors are structured: throw `MarginError` with `code`, `message`, optional `path`. Never throw strings.
- The annotation file is the single source of truth. Unknown fields (and `x-*` keys) survive load → save.
- Annotation coordinates are always original-page points, top-left of CropBox, y down (spec §4, §5.4).
  Output coordinates never enter the annotation file.

## Tests

- Unit and property tests sit next to the code: `foo.ts` → `foo.test.ts`.
- Golden tests (`packages/cli/test/golden.test.ts`): for each fixture in `fixtures/`, the CLI pipeline
  produces `layout.json` and one PNG per annotated page; they are compared with
  `fixtures/<name>/expected/`. If a change is intended, run `pnpm golden:update` and review the diff
  like code (PNGs: open them).
- Acceptance tests (`packages/cli/test/acceptance.test.ts`) check the phase gates of spec §12.3. The phase 3
  gate is `packages/cli/test/agent-workflow.test.ts`: an "agent" that only follows `margin agent-guide` adds
  10 quote-anchored comments with zero unresolved anchors. If you change CLI behavior, update
  `src/agent-guide.md` and keep that test passing.
- E2E (`packages/web/e2e`, Playwright, both browsers): editing, persistence, panels, settings, export, bridge.
  `export.spec.ts` compares the screen overlay with the exported PDF at 150 dpi with a 1 px
  tolerance (and a shifted copy as negative control).
- Fixtures (`fixtures/<name>/`): `<name>.tex` → `<name>.pdf` (reproducible build), `ops.json` →
  `<name>.annot.json` (reference annotations), optional `golden.json` (`dpi`, `pages`), and
  `expected/`. Current set: `plain`, `twocolumn`, `tight` (k cap reached, s < 1), `mathheavy`
  (TikZ, region anchors), `mixed` (page sizes), `long` (20 pages, 60 comments).

## Git

Work on a feature branch (`feat/<topic>`), commit in focused steps, merge into `main` with `--no-ff`
once `pnpm test` and `pnpm typecheck` pass.
