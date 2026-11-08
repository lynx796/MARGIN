# Margin — PDF Grading Annotator: Specification

Nov 8, 2026 · Lyn

## 1. Overview

Margin is a local-first web app for grading compiled LaTeX papers: it adds typed, colored, LaTeX-capable comments in widened page margins, lays them out automatically, and exports a flattened PDF.

### Goals

1. Fast keyboard-driven annotation: select text, type, press Enter.
2. Comments that read well on the page: typeset text and math, connected to their anchors by colored leaders, placed without overlap.
3. Agent-first: every operation a human can do in the UI, a coding agent (e.g. Claude Code) can do through files and a CLI, without a browser.
4. Strictly local: PDFs and annotations never leave the device except through an explicit user action.
5. Reversible pseudonymization, so redacted copies can go to an LLM and results can be mapped back to the original.

### Non-goals

- Editing the PDF's own content.
- Collaboration, accounts, sync or any server-side logic.
- Handwriting or freehand drawing.
- Native PDF annotation objects in the output (comments are flattened only).
- Mobile/touch UI (desktop browsers only).

### Guiding principles

- **One core, many front-ends.** All logic lives in a framework-free TypeScript core that runs in the browser and in Node. The web UI and the CLI are thin shells.
- **Files are the API.** The annotation file is the single source of truth. It is plain JSON, documented by a JSON Schema, and stable under round trips.
- **WYSIWYG by construction.** Screen and export render the same display list, computed by one layout engine from font metrics, never from DOM measurement.
- **Deterministic.** Same inputs give byte-identical layout and, apart from timestamps that can be pinned, identical PDFs. This makes agent work and tests verifiable.

## 2. Platform and tech stack

The app is a static single-page application in TypeScript with no backend; the same core also ships as a Node CLI.

| Concern | Choice | License | Notes |
| --- | --- | --- | --- |
| Language | TypeScript (strict) | — | Shared by web, CLI, bridge |
| Monorepo / build | pnpm workspaces + Vite | MIT | Static build output only |
| UI framework | Svelte 5 | MIT | Only for panels and dialogs; page overlay is plain SVG |
| PDF rendering + text layer | pdf.js (`pdfjs-dist`) | Apache-2.0 | Web only; CLI uses it for text extraction too |
| PDF composition (export) | `@cantoo/pdf-lib` + `@pdf-lib/fontkit` | MIT | Maintained fork of pdf-lib |
| Redaction | MuPDF.js | AGPL-3.0 | Lazy-loaded; only in pseudonymization |
| Math rendering | MathJax 4, SVG output, `mathjax-fira` font | Apache-2.0 | Same code path in browser and Node |
| Comment text font | Fira Sans (Regular, Italic, SemiBold) | OFL-1.1 | Embedded in exported PDFs |
| Comment editor | CodeMirror 6 | MIT | Single-line-feel editor with math widgets |
| Schema validation | Ajv (JSON Schema 2020-12) | MIT | Schema shipped in repo |
| Unit tests | Vitest | MIT | Core and CLI |
| E2E tests | Playwright (Chromium + Firefox) | Apache-2.0 | Both browsers in CI |

Because MuPDF.js is AGPL, the whole project is released under AGPL-3.0 (or kept private). All other dependencies are compatible.

### Browser support

Firefox and Chromium (current stable) are both first-class. The baseline workflow uses only APIs both support; Chromium-only APIs are progressive enhancements behind feature detection.

| Capability | Firefox | Chromium |
| --- | --- | --- |
| Open PDF / annotation file | File input, drag and drop | Same, plus file picker with persistent handle |
| Persistence between sessions | OPFS + IndexedDB | Same |
| Save | Download | Write back to the opened file |
| Pick up external edits to `.annot.json` | Via local bridge (§9), else re-import by drop | File handle polling, or bridge |
| Offline use | Service worker (PWA) | Same |

## 3. Architecture and repository

Four packages share one core: `core` holds all logic and has no DOM or Node dependencies; `web`, `cli` and `bridge` are thin adapters.

```
margin/
  AGENTS.md                 # instructions for coding agents (also symlinked as CLAUDE.md)
  schema/annot.schema.json  # JSON Schema of the annotation file, versioned
  packages/
    core/        # model, anchoring, geometry, layout, math, export, redaction, mapping
    web/         # Svelte app, pdf.js viewer, overlay renderer, editor, service worker
    cli/         # `margin` command (Node), wraps core
    bridge/      # optional localhost server for live sync (part of cli: `margin serve`)
  fixtures/      # sample PDFs (LaTeX-compiled, incl. math-heavy) + annotation files + expected outputs
  fonts/         # Fira Sans files, vendored
```

### Core modules

| Module | Responsibility |
| --- | --- |
| `model` | Types, schema validation, migrations between format versions, stable IDs |
| `pdf` | Loading, page sizes, text extraction with character quads (via pdf.js) |
| `anchor` | Resolve and re-resolve anchors (geometry ⇄ quote), fuzzy matching |
| `geometry` | Crop box, enlargement factor, coordinate transforms (§5) |
| `text` | Comment markup parser, font metrics, line breaking |
| `math` | MathJax SVG rendering with cache, box metrics |
| `layout` | Column assignment, PAVA placement, leaders, overflow, numbering → display list (§6) |
| `render-pdf` | Display list → PDF via pdf-lib (§8) |
| `redact` | Term matching, MuPDF redaction, metadata scrub, verification (§10) |
| `mapping` | Pseudonym mapping file, token substitution in comments |

The display list is the contract between layout and rendering. It is a flat array of primitives in output-page coordinates: `rect`, `path`, `glyphRun` (font, size, color, positioned glyph string), `svg` (math, pre-converted to paths), each tagged with the annotation ID that produced it. The web overlay renders it as SVG; `render-pdf` writes it as PDF operators.

### Conventions for agent-friendly development

- `AGENTS.md` at the root: build/test commands, the module map above, invariants (core has no DOM/Node imports; layout is pure; never measure via DOM), and how to run the fixture checks.
- Every core function that matters is pure and deterministic, with a unit test against fixtures.
- Golden tests: for each fixture, the CLI produces `layout.json` (display list) and a PNG per page; diffs are reviewed like code.
- Errors are structured (`code`, `message`, `path`), never bare strings, so agents can act on them.
- No hidden state: everything the app knows about a document is in the annotation file or derivable from the PDF.

## 4. Data model and annotation file

All annotations of one PDF live in a sidecar file `<name>.annot.json`, plain JSON validated by `schema/annot.schema.json`. It is the single source of truth for the UI, the CLI and agents.

```json
{
  "format": "margin-annot",
  "version": 1,
  "document": {
    "fileName": "paper.pdf",
    "sha256": "9f2c…",
    "pageCount": 14,
    "pages": [{ "width": 595.28, "height": 841.89 }]
  },
  "categories": [
    { "id": "typo",    "name": "Typo",           "color": "#d97706", "kind": "comment",   "weight": 1 },
    { "id": "error",   "name": "Error",          "color": "#dc2626", "kind": "comment",   "weight": 3 },
    { "id": "remark",  "name": "General remark", "color": "#2563eb", "kind": "comment",   "weight": 2 },
    { "id": "good",    "name": "Well done",      "color": "#16a34a", "kind": "comment",   "weight": 1 },
    { "id": "hl",      "name": "Highlight",      "color": "#facc15", "kind": "highlight", "weight": 0 }
  ],
  "settings": { "marginWidth": 150, "maxEnlargement": 1.3, "fontSize": 9 },
  "annotations": [
    {
      "id": "k3f9qd",
      "category": "error",
      "anchor": {
        "type": "text",
        "page": 3,
        "quads": [[72.1, 410.2, 301.7, 421.0]],
        "quote": { "exact": "is continuous on", "prefix": "the map f ", "suffix": " the closed interval" }
      },
      "body": "Only on \\((0,1]\\): \\(f(0)\\) is not defined. See also \\ref{p8x2mz}.",
      "side": "auto",
      "origin": "human",
      "created": "2026-11-12T14:03:11Z",
      "modified": "2026-11-12T14:04:02Z"
    }
  ]
}
```

### Fields and rules

- **IDs**: 6-character lowercase base32, random, unique per file. Short enough to type in prompts and cross-references.
- **Pages**: 1-based. **Coordinates**: PDF points in the *original* page, origin at the top-left of the CropBox, y pointing down. Quads are axis-aligned rectangles `[x0, y0, x1, y1]`, one per line fragment.
- **Anchor types**:
  - `text`: `quads` + `quote` (W3C TextQuoteSelector semantics). Either may be omitted on input; the resolver (§9) fills the missing one.
  - `region`: `rect` only, for formulas, figures or whole proofs (rectangle selection).
- **Body**: comment source in the comment markup (§6.1). Empty for categories with `kind: "highlight"`.
- **Display numbers are not stored.** They are derived from reading order on every layout (§6.8). Cross-references use IDs: `\ref{<id>}`.
- **side**: `auto` | `left` | `right`. `auto` lets the layout choose; the others pin a comment to a margin.
- **origin**: `human` | `agent`. Agent-created comments are visually flagged in the UI until a human accepts them, which sets `reviewed: true` (§9.4).
- **status** (optional, written by the resolver): `ok` | `unresolved` (quote not found) | `ambiguous` (quote found more than once without disambiguating prefix/suffix or page).
- **Categories**: user-defined, any number. `weight` feeds the layout objective (§6.5). A global default category set is stored in browser storage and copied into each new file, so a file is always self-contained.
- **sha256** binds the file to one exact PDF. Opening a mismatching PDF shows a warning and offers re-anchoring by quote.
- **Versioning**: `version` increases on breaking changes; `core/model` contains forward migrations. Unknown fields are preserved on load and save, so agents may add their own metadata under `x-*` keys.
- **Serialization**: stable key order, two-space indentation, annotations sorted by (page, y, x). Diffs stay small and readable.

## 5. Page geometry

Each output page is the original page enlarged uniformly by one document-wide factor k ≤ k_max, with the content cropped horizontally to the text block and centered; content is scaled down only if the cap is reached.

### 5.1 Crop

The horizontal content extent [x₀, x₁] is the union over all pages of the per-page ink bounding box. The ink box is found by rasterizing each page at 36 dpi and taking the extent of non-background pixels, which covers text, vector graphics and images alike. A padding p (default 8 pt) is added on both sides. The user can override the crop in settings. Vertically, nothing is cropped: headers, footers and page numbers stay. Let t = x₁ − x₀ + 2p.

### 5.2 Enlargement and scale

With target margin width m per side (setting `marginWidth`, default 150 pt) and cap k_max (setting `maxEnlargement`, default 1.3):

```latex
k = \min\Bigl(k_{\max},\ \max\bigl(1,\ \tfrac{t + 2m}{W}\bigr)\Bigr), \qquad s = \min\Bigl(1,\ \frac{kW - 2m}{t}\Bigr)
```

The output page is kW × kH, so the page aspect ratio W : H is preserved exactly. Content is drawn with scale s, horizontally and vertically centered. k and s are computed once per document from the largest page width, so all output pages have consistent size. With mixed page sizes, k is applied per page and s is shared.

### 5.3 Margin columns

The left and right columns each have width

```latex
w_{\text{col}} = \min\Bigl(w_{\max},\ \frac{kW - s\,t}{2} - g_{\text{out}}\Bigr)
```

where g_out is the outer page margin (default 18 pt) and w_max = 1.3 m caps the line length for readability when there is surplus space. The vertical extent of each column is [g_out, kH − g_out]: comments may use the full page height, including the area beside the original top and bottom margins.

### 5.4 Coordinate systems

| System | Used for | Origin, units |
| --- | --- | --- |
| Original page | Anchors in the annotation file | Top-left of CropBox, PDF pt, y down |
| Output page | Display list, export | Top-left of output page, PDF pt, y down |
| Screen | Overlay, hit testing | CSS px, derived by the viewer's zoom |

The map from original to output coordinates is affine:

```latex
T(x, y) = \bigl(o_x + s\,(x - x_0 + p),\ o_y + s\,y\bigr), \qquad o_x = \tfrac{kW - s\,t}{2},\quad o_y = \tfrac{kH - sH}{2}
```

The annotation file never stores output coordinates, so changing margin settings never invalidates anchors.

## 6. Comment layout engine

Layout is a pure function from (PDF geometry, annotation file, settings) to a display list; each page is laid out independently and placement within a column is solved exactly by weighted isotonic regression.

### 6.1 Comment markup

A deliberately small grammar, parsed by `core/text`:

| Syntax | Meaning |
| --- | --- |
| `\( … \)` | Inline math |
| `\[ … \]` | Display math, on its own centered line |
| `**…**`, `*…*` | Bold (Fira Sans SemiBold), italic |
| `` `…` `` | Monospace (Fira Mono) |
| `\ref{id}` | Cross-reference, rendered as the target's current display number |
| newline | Line break; a blank line starts a new paragraph with 3 pt extra space |
| `\\`, `\*`, `` \` `` | Escapes |

Anything else is literal text. Unknown macros inside math are MathJax's concern; outside math they are text.

### 6.2 Box layout

- Font: Fira Sans at `fontSize` (default 9 pt), line height 1.25 × fontSize, kerning on, no ligatures. Widths come from fontkit metrics, never from the DOM.
- Math: MathJax 4 renders TeX to SVG with the `mathjax-fira` font at the comment font size. Width, height and depth are read from the SVG; glyphs are already paths. Results are cached by (TeX source, size). A TeX error renders the source in red monospace and sets a `mathError` flag shown in the UI; export still succeeds.
- Line breaking: greedy first-fit over boxes (words, inline math, spaces as glue). Inline math is unbreakable; if wider than the line, it is scaled down to at most 70 %, then allowed to overflow into the padding. A later version may switch to Knuth–Plass; the interface does not change.
- Box style: width = column width w_col; padding 4 pt; a 2 pt left stripe in the category color; background in the category color at 8 % opacity; corner radius 2 pt. The display number sits top-right in 6.5 pt gray.
- The result per comment is its height hᵢ and a list of positioned primitives relative to the box origin.

### 6.3 Anchor marks

- `highlight` categories: filled quads in the category color at 30 % opacity, multiply blend. No box, no leader.
- `comment` categories: a 1 pt underline in the category color, 1.5 pt below the baseline of each quad.
- Overlapping anchors on the same line are assigned levels by greedy interval coloring along x; level ℓ draws its underline 1.5 ℓ pt lower. At most 3 levels are drawn distinctly; further ones share level 2.
- Region anchors: a 1 pt rounded rectangle outline in the category color.

### 6.4 Column assignment

1. Pinned comments (`side: left|right`) go to their side.
2. `auto` comments go to the side nearer the horizontal center of their anchor's first quad.
3. If a column's total demand exceeds its height, i.e. Σᵢ hᵢ + (n − 1) g > B − T with gap g = 4 pt, `auto` comments are moved to the other column in order of increasing distance of their anchor from the text-block center, until both fit or the other column is full.

Two-column papers need no special case: anchors in the left text column are nearer the left margin and go there, anchors in the right column go right. The gap between the two text columns (typically 10–25 pt) is too narrow for comments and is never used as a comment column.

### 6.5 Placement within a column

Order the comments of one column by their leader start height λᵢ (anchor line in output coordinates plus level offset; ties broken by x, then ID, for determinism). The target top of box i is aᵢ = λᵢ − δ, where δ aligns the box's first text line with the anchor line. Solve

```latex
\min_{y \in \mathbb{R}^n} \sum_{i=1}^n w_i\,(y_i - a_i)^2 \quad \text{s.t.}\quad y_{i+1} \ge y_i + h_i + g,\quad y_1 \ge T,\quad y_n + h_n \le B
```

with weights wᵢ from the category. Substituting cᵢ = Σ_{j<i}(hⱼ + g) and zᵢ = yᵢ − cᵢ turns the spacing constraints into z₁ ≤ … ≤ zₙ and the objective into Σ wᵢ (zᵢ − (aᵢ − cᵢ))², a weighted isotonic regression. The bound constraints become the constant box zᵢ ∈ [T, B − hₙ − cₙ] for all i, which is non-empty exactly when the column fits.

Algorithm: run weighted pool-adjacent-violators (PAVA) on the targets aᵢ − cᵢ, clip every zᵢ to [T, B − hₙ − cₙ], set yᵢ = zᵢ + cᵢ. This is O(n) after sorting and exactly optimal, because clipping the isotonic solution to a constant interval yields the projection onto the intersection. A property test checks optimality against a QP solver on random instances.

### 6.6 Leaders

Each comment is connected to its anchor by a 0.6 pt line in the category color. Two styles (setting `leaderStyle`):

- `full` (default): a dotted segment at the anchor's underline level from the anchor's outer end to the text-block edge e, then a solid segment across the gutter from (e, λᵢ) to the box at (e ± γ, yᵢ + δ), γ = gutter width.
- `gutter`: only the solid gutter segment, starting at a 4 pt tick at the text-block edge.

Non-crossing: two gutter segments between the vertical lines x = e and x = e + γ cross only if their endpoint orders differ. Both (λᵢ) and (yᵢ) are increasing in i, so no two leaders cross within a column. On a line with several anchors in the same column, the anchor nearest the edge gets level 0, so the dotted segments of farther anchors run below nearer underlines instead of through them.

### 6.7 Overflow

If a column still does not fit after §6.4, in order:

1. Reduce the page's comment font size in 0.5 pt steps down to 7.5 pt and relayout.
2. Spill: the lowest-weight comments (ties: tallest first) become notes. Each leaves a small numbered tag in the margin at its anchor, and its body is printed on a notes page of the same size inserted directly after the page.

The UI shows a warning badge on pages that needed step 2.

### 6.8 Numbering and cross-references

Comments (not highlights) are numbered 1…N across the document in reading order: by page, then anchor y, then anchor x. Numbers are recomputed on every change, so they are always consecutive. `\ref{id}` renders the target's number (in the PDF as an internal link to the target box); a dangling reference renders as "??" in red and is reported by `margin check`.

### 6.9 Performance

Layout is incremental per page: an edit relayouts only its page, plus pages whose comments reference a changed number. Target: under 16 ms per page with 30 comments, measured in CI on the fixture set.

## 7. Editor UI and interaction

The core loop is select → type → Enter, with no mouse travel to the margin and no dialog.

### 7.1 Layout of the window

- **Center**: continuous vertical page view. Each page shows the pdf.js canvas, its text layer, and an SVG overlay rendering the page's display list at output-page geometry. The view always shows the enlarged page, so what you see is the export.
- **Top bar**: file name, category palette (colored chips with their shortcut digit; a "+" chip adds a category inline with name, color and kind; clicking a chip's color swatch opens a color picker), zoom, export button, warning badges (unresolved anchors, overflow, math errors).
- **Right sidebar** (collapsible): list of all comments in reading order with number, category, first line and page; filter by category and by origin (human/agent); click to jump.
- **Settings dialog**: categories (add, rename, recolor, reorder, set weight, set kind), margin width, enlargement cap, font size, leader style, crop override.

### 7.2 Creating a comment

1. Drag over text with the mouse. Alt+drag draws a region rectangle instead.
2. On mouse-up, the anchor is drawn in the active category color and the comment box opens at its laid-out position with the editor focused. Other boxes on that page shift live as the new box grows.
3. Type. Enter or Esc commits. Shift+Enter inserts a line break.
4. Committing an empty comment deletes it, except for highlight categories, which never open an editor.

The active category is chosen before selecting (digits 1–9 or a chip click). While the editor is open, Ctrl+1…9 changes the category of the comment being edited.

### 7.3 Editing and navigation

| Key / action | Effect |
| --- | --- |
| Click a box, or Enter on a focused box | Edit |
| Tab / Shift+Tab (no editor open) | Focus next / previous comment in reading order |
| Delete on a focused box | Delete comment (undoable) |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo (all model changes, including agent changes picked up from disk) |
| Ctrl+M (in editor) | Insert `\(\)` with the cursor inside |
| `@` (in editor) | Cross-reference picker: type a number or text, Enter inserts `\ref{id}` |
| Drag an anchor end | Adjust anchor extent |
| Alt+L / Alt+R on a focused box | Pin to left / right margin; again to unpin |
| Ctrl+F | Search in PDF text and comment bodies |

### 7.4 Live math

The editor is CodeMirror 6 styled to look like the rendered box: same font, size and width. Math segments not containing the cursor are replaced by rendered MathJax widgets (inline decorations); the segment under the cursor shows its source with a rendered preview floating below it, updated with a 150 ms debounce. Leaving the editor renders everything. Line wrapping in the editor is approximate; the committed layout uses the core engine.

### 7.5 Anchoring behavior

- Text selection uses pdf.js's text layer; the selection is converted to quads by intersecting the selected text items with character boxes from the core's extraction, so the stored geometry does not depend on browser rendering.
- The quote (exact, 32-character prefix and suffix) is stored at creation time.
- If the text layer cannot select a formula sensibly, the user uses Alt+drag. The UI shows this hint once when a selection's extracted text is mostly non-alphanumeric.

### 7.6 Persistence

- Every change is written to OPFS immediately (autosave), keyed by the PDF's sha256. Reopening the same PDF restores its annotations.
- Chromium with a file handle: also written to the `.annot.json` next to the PDF after a 1 s debounce.
- Bridge connected (§9.3): written through the bridge.
- Otherwise: "Save annotations" downloads the `.annot.json`.
- A start screen lists recently opened documents from OPFS with last-modified dates; a document can be removed from browser storage there.

## 8. Export

Export writes a new PDF in which every comment is flattened into the page content; the annotation file travels along as an embedded attachment so the PDF can be re-imported loss-free.

### 8.1 Flattened PDF

1. For each original page, create an output page of size kW × kH (§5.2).
2. Embed the original page as a form XObject (`embedPage`) clipped to the crop box and drawn with the transform T (§5.4). Original text stays vector and selectable.
3. Draw the page's display list on top: highlights below the page content in multiply blend, everything else above.
4. Text runs use the embedded, subsetted Fira Sans fonts. Math is drawn as vector paths from the MathJax SVG.
5. Cross-references become internal GoTo links to the target box.
6. Insert notes pages for spilled comments (§6.7).
7. Set metadata: Title = original title (or file name), Producer = "Margin <version>". No author field is copied unless the user enables it.

Native PDF annotation objects are not created. Annotations already in the input PDF (links, existing comments) are dropped by `embedPage`; internal links of the original are not preserved in version 1.

### 8.2 Embedded annotation file

The current `.annot.json` is always attached as `/EmbeddedFiles` entry `margin.annot.json` (MIME type `application/json`, a few kB). Opening an exported PDF in Margin detects the attachment and asks for the original PDF, which it recognizes by the sha256 in the annotation file; the result is the fully editable document again. Optionally (setting `embedOriginal`, default off) the original PDF is attached too as `margin.original.pdf`, so the exported file alone suffices; this roughly doubles the file size.

### 8.3 Determinism and file names

- Export is deterministic: CreationDate and ModDate come from the latest annotation `modified` timestamp, document IDs are derived from the content hash, and fonts are subset in a stable glyph order. Two exports of the same inputs are byte-identical, which makes golden tests possible.
- Default output name: `<name>.annotated.pdf`.
- In the browser, export runs in a Web Worker and finishes with a download (Firefox) or a save picker (Chromium). Target: under 5 s for a 30-page paper with 100 comments.

### 8.4 Grading report

A grading report written separately in LaTeX can be placed in front of the annotated pages. The report is optional: if none is attached (no `report` entry in the annotation file and no `--report` flag), export produces exactly the annotated paper, with no placeholder, blank or cover page and no warning.

- The annotation file stores a reference `report: { fileName, sha256, position: "before" | "after" }`, default `before`.
- Web app: the user drops a compiled report PDF onto the document; it is kept in OPFS next to the paper. The browser does not compile LaTeX.
- CLI: `margin export paper.pdf --report report.pdf`, or `--report report.tex`, which runs the local `latexmk -pdf` and fails with a clear error if no TeX installation is found.
- At export, report pages are scaled uniformly to the output page width kW (never stretched) and centered vertically. They get no margins, comments or numbering.
- If the report file changes after it was attached, the hash mismatch is shown as a warning before export.

## 9. Agent interface

An agent works with Margin entirely through files and the `margin` CLI: it reads the paper as text, adds comments by quoting text, checks the result visually, and the open browser tab picks up the changes live.

### 9.1 CLI

All commands accept `--json` for machine-readable output, print structured errors, and use exit codes 0 (ok), 1 (validation problems found), 2 (usage or I/O error). The annotation file defaults to `<pdf>.annot.json` next to the PDF.

| Command | Purpose |
| --- | --- |
| `margin init paper.pdf` | Create the annotation file with default categories and the PDF hash |
| `margin read paper.pdf [--pages 3-5]` | Page text in reading order as Markdown, one section per page, line-numbered, with existing comments inserted inline as `⟦#4 error k3f9qd: …⟧` after their anchor |
| `margin list [--page N] [--category C]` | Comments with number, ID, category, page, quote, body |
| `margin add --page 3 --quote "is continuous on" --category error --body "…"` | Add a comment anchored by quote; prints the new ID; fails on unresolved or ambiguous quotes with candidates listed |
| `margin edit <id> [--body …] [--category …] [--side …]` | Change a comment |
| `margin rm <id>` | Delete a comment |
| `margin apply ops.json` | Apply a batch of add/edit/rm operations atomically; all are validated before any is written |
| `margin resolve` | Fill missing quads from quotes and missing quotes from quads; set `status` |
| `margin check` | Schema, unresolved anchors, math errors, dangling `\ref`, overflowed pages |
| `margin render paper.pdf --pages 3 -o out/` | PNG per annotated page, for visual checks by multimodal agents |
| `margin export paper.pdf [-o file] [--report file]` | Flattened PDF (§8) |
| `margin pseudonymize`, `margin restore` | §10 |
| `margin serve` | Local bridge (§9.3) |
| `margin schema`, `margin agent-guide` | Print the JSON Schema; print a concise usage guide written for agents |

Agents may also edit `.annot.json` directly. Everything the CLI writes is accepted on input, and a minimal annotation needs only `category`, `body` and an anchor with `page` + `quote.exact` (or `quote` alone if unique in the document); IDs and timestamps are filled in by the next tool that loads the file.

### 9.2 Quote anchoring

Resolution matches `quote.exact` against the document's extracted text after normalization: Unicode NFKC, removal of combining marks, ligature expansion, whitespace collapsed, line-end hyphenation joined. Matching order:

1. Exact match within the given page (or the whole document if no page).
2. If several matches, disambiguate by prefix/suffix similarity.
3. If none, fuzzy match (normalized edit distance ≤ 0.1) and mark the result `status: ok` only if it is unique; otherwise `unresolved` or `ambiguous`, with candidates reported.

The same resolver re-anchors annotations when a different revision of the same paper is opened.

### 9.3 Local bridge (live sync, all browsers)

`margin serve [--dir ~/grading]` starts an HTTP server bound to 127.0.0.1 only, prints a URL with a one-time random token, and serves only files inside `--dir`.

- The web app connects when opened with that URL (or the user pastes the token). Requests carry the token; the server answers CORS and Private Network Access preflights only for the configured app origin.
- Endpoints: list PDFs, read PDF, read/write annotation file, and a Server-Sent Events stream of file changes (from `fs.watch`).
- External changes (an agent running `margin add` or editing JSON) appear in the open tab within 1 s. They enter the undo history as one step labeled with their source.
- Merge rule: changes are merged per annotation ID. If the same annotation changed both locally (unsaved) and on disk, the disk version wins and the local text is kept in a recoverable "conflicts" list.
- Loopback HTTP from an HTTPS page is permitted by both Firefox and Chromium; the CSP allows `connect-src http://127.0.0.1:*` for this purpose only.

In local use, `margin serve` also serves the web app itself from the same address (e.g. `http://127.0.0.1:7311`), so app and bridge share one origin and no CORS setup is needed. This is the recommended way to run Margin in version 1.

Without the bridge, Chromium can poll a file handle; Firefox falls back to re-import by drag and drop.

### 9.4 Reviewing agent comments

Comments with `origin: agent` show a dashed box outline and a small "AI" badge in the UI (never in the export). Enter on a focused agent comment, or "Accept all on page", sets `reviewed: true`. Export warns if unreviewed agent comments exist. The sidebar can filter to unreviewed ones.

### 9.5 Typical agent session

```
margin read paper.pdf --pages 1-4      # agent reads the text with existing comments
margin add --page 2 --quote "for all n" --category typo --body "for all \\(n \\ge 1\\)"
margin apply review-ops.json           # many comments at once
margin check && margin render paper.pdf --pages 2 -o /tmp/r/
```

The repository's `AGENTS.md` (for developing Margin) and the output of `margin agent-guide` (for using Margin) are separate documents; the latter is short enough to paste into any agent's context.

## 10. Pseudonymization

Pseudonymization produces a redacted copy with identical page geometry plus a local mapping file; annotations made on the copy, by a human or an agent, transfer back to the original unchanged except for token substitution.

### 10.1 Terms

The user supplies term groups, in the UI or as a file:

```
# terms.txt — one group per line: TOKEN: variants…
AUTHOR_1: Anna Müller | A. Müller | Müller | Anna
AUTHOR_2: Jonas Keller | J. Keller | Keller
EMAIL: /[\w.+-]+@[\w-]+(\.[\w-]+)+/
LEGI: /\b\d{2}-\d{3}-\d{3}\b/
```

Variants are literal; `/…/` entries are regular expressions. Every match of any variant in a group is replaced by the group's token, rendered as `[AUTHOR_1]`.

Optional suggestions (never applied without confirmation): the title block of page 1, e-mail addresses, student-ID patterns, and words following "by", "Author" or "Name". Model-based name detection is out of scope for version 1.

### 10.2 Matching

Matching runs on the core's extracted text with character quads, after the normalization of §9.2, plus case folding. It handles umlauts encoded as base letter + combining accent, ligatures, names hyphenated across lines, and possessives ("Müller's"). Each match yields the quads of the characters to remove.

### 10.3 Redaction

MuPDF.js applies redactions over the matched quads with image and line-art removal disabled, so only text glyphs under the quads are removed from the content streams; nothing else moves. The token is drawn into the freed area in Fira Sans on a light gray box, scaled horizontally if it is wider than the area.

The following are scrubbed or removed regardless of matches:

| Location | Action |
| --- | --- |
| Info dictionary (Author, Title, Subject, Keywords, Creator) | Removed; Title set to the token-substituted title |
| XMP metadata stream | Removed |
| pdfTeX keys (`PTEX.FileName`, `PTEX.Fullbanner`, …) | Removed; they can contain local file paths |
| Outlines (bookmarks) | Titles token-substituted |
| Link annotations | Removed |
| Embedded files, form fields, JavaScript, thumbnails | Removed |
| Trailer `/ID` | Regenerated |

The output file name is the token-substituted input name, or a user-chosen one.

### 10.4 Verification

After redaction, the redacted PDF is re-loaded and checked: text extraction with the same normalization must contain no match of any term (fuzzy threshold as in §9.2), and the scrubbed locations must be empty. Any failure aborts and reports the location. The UI then shows a review screen with page 1 at full size and every redaction highlighted, because names inside images (scans, logos, signatures) cannot be detected and must be checked by eye.

### 10.5 Mapping file and round trip

`<name>.pseudo.json` stays local and is never embedded in any exported file:

```json
{
  "format": "margin-pseudo",
  "version": 1,
  "originalSha256": "9f2c…",
  "redactedSha256": "41ab…",
  "groups": [
    { "token": "AUTHOR_1", "variants": ["Anna Müller", "A. Müller", "Müller", "Anna"] }
  ]
}
```

- `margin pseudonymize paper.pdf --terms terms.txt` writes `paper.pseudo.pdf` and `paper.pseudo.json`. An existing annotation file is copied with tokens substituted into bodies and quotes.
- The agent works on `paper.pseudo.pdf` and its annotation file.
- `margin restore paper.pseudo.annot.json --map paper.pseudo.json --original paper.pdf` checks both hashes, copies all annotations to `paper.annot.json`, replaces tokens in bodies with the first variant of each group (configurable per group, e.g. first name only), and re-extracts quotes from the original by quads. Because geometry is identical, quads are used unchanged.
- The user then exports from the original as usual.

## 11. Privacy and security

No document data ever leaves the browser or the local machine, and this is enforced by the browser rather than only by code discipline.

- **Static hosting only.** The deployed site is a directory of static files. The server has no endpoint that accepts data, and its access logs contain only asset requests.
- **Content Security Policy** (sent as a header and as a meta tag):

  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:; font-src 'self'; worker-src 'self' blob:;
  connect-src 'self' http://127.0.0.1:*; form-action 'none'; frame-ancestors 'none'; base-uri 'none'
  ```

  `connect-src` permits only same-origin asset fetches and the local bridge. All fonts, WASM and MathJax data are self-hosted; there are no CDN, analytics or telemetry requests.
- **Offline.** A service worker precaches all assets; after the first visit the app works without network.
- **Storage.** Documents and annotations live in OPFS and IndexedDB of the app's origin. A "Forget this document" action deletes both; a "Clear all data" action wipes the origin's storage.
- **Explicit export only.** Data leaves the app only through downloads, save pickers, the bridge (to a user-chosen local directory) or the clipboard.
- **Bridge hardening.** Binds to 127.0.0.1 only; requires a per-session random token; restricts file access to the served directory (path traversal rejected); answers CORS only for the configured app origin.
- **Supply chain.** Dependencies are pinned with a lockfile; the build is reproducible; Subresource Integrity is set on all script tags.
- **Pseudonymization caveat.** Redaction cannot see text inside images; the review step in §10.4 is mandatory before a pseudonymized file is shared.

### Deployment

- **Version 1**: local only. `margin serve` hosts the app and the bridge on 127.0.0.1 and sets the CSP header itself.
- **Later**: a Docker image with nginx serving the static build. nginx sends the CSP header above. The public URL (e.g. `https://margin.example.org`) becomes the allowed origin that a local `margin serve` accepts requests from (`margin serve --allow-origin https://margin.example.org`).

## 12. Testing and acceptance

Every phase is done when its acceptance criteria pass in CI on both Firefox and Chromium; tests are written so that an agent can run them and read the failures.

### 12.1 Fixtures

`fixtures/` holds about 10 LaTeX-compiled PDFs with their `.tex` sources (so they can be regenerated): plain `article`, tight `geometry` margins, two-column, heavy display math, `amsthm` environments, TikZ figures, a scanned page, umlauts and hyphenated names on the title page, `hyperref` with `pdfauthor` set, mixed page sizes. Each has a reference annotation file and expected outputs.

### 12.2 Test layers

| Layer | Tool | Examples |
| --- | --- | --- |
| Unit | Vitest | Markup parser, line breaking, PAVA, geometry formulas, quote normalization |
| Property | Vitest + fast-check | PAVA output is feasible and matches a QP solver to 1e-6; leaders never cross; numbering is a bijection onto 1…N |
| Golden | CLI | `layout.json` and page PNGs per fixture; image diff with a small tolerance |
| Round trip | CLI | load → save is byte-identical; export → re-import recovers the annotation file; pseudonymize → annotate → restore yields identical quads |
| Leak | CLI | For every fixture with terms, the redacted PDF contains no term in text, metadata, outlines or raw bytes (zlib-inflated streams searched) |
| E2E | Playwright | Select → type → Enter creates a comment; Shift+Enter breaks lines; Esc commits; bridge sync appears within 1 s |
| Privacy | Playwright | During a full session, no network request leaves the origin except to 127.0.0.1 |

### 12.3 Acceptance criteria (version 1)

- [ ] A 20-page fixture with 60 comments lays out without overlap, all leaders non-crossing, in under 16 ms per page.
- [ ] Exported PDFs open correctly in Firefox, Chromium, Acrobat Reader and macOS Preview, and print on A4 when k ≤ 1.3.
- [ ] Screen overlay and exported page differ by at most 1 px at 150 dpi (golden comparison).
- [ ] Every UI operation on annotations has a CLI equivalent, and `margin apply` with 100 operations completes in under 2 s.
- [ ] An agent following only `margin agent-guide` can add 10 quote-anchored comments to a fixture with zero unresolved anchors.
- [ ] Pseudonymization leaves no term in any fixture (leak test) and restore reproduces the original anchors exactly.
- [ ] Export without a grading report contains exactly the annotated pages.
- [ ] The privacy E2E test passes with network inspection enabled.

## 13. Implementation phases

Build in six phases, core and CLI first: the layout engine and every agent operation then exist and are tested before any UI is written. Phases 1–3 give a usable grading tool; 4–6 complete it. Each phase starts with its tests and ends at its gate. Hand phases to the coding agent one at a time, with this spec and the repository's `AGENTS.md` in context.

### Phase 1 · Core and CLI (no UI)

- Schema, PDF text with quads, anchoring, geometry, text and math layout, PAVA, leaders, numbering.
- `render-pdf`; CLI: `init`, `read`, `add`, `edit`, `rm`, `apply`, `list`, `check`, `render`, `export`.
- **Gate:** golden and property tests green; layout criteria of §12.3 met.

### Phase 2 · Web editor MVP

- pdf.js viewer with SVG overlay, select → type → Enter, categories, CodeMirror with live math.
- OPFS autosave, import and download, sidebar, settings dialog.
- **Gate:** E2E green in Firefox and Chromium; overlay matches export within 1 px.

### Phase 3 · Agent workflow

- `margin serve` bridge (also serving the app) with live sync and merge, agent review UI, fuzzy quote resolver.
- `margin agent-guide`; `AGENTS.md` finalized.
- **Gate:** an agent adds 10 quote-anchored comments with zero unresolved anchors.

### Phase 4 · Layout and export completeness

- Overflow (font step-down, notes pages), cross-reference picker and PDF links, embedded annotation file, optional grading report.
- Re-import of exported PDFs, Chromium file handles.
- **Gate:** round-trip tests green; exports open correctly in four viewers.

### Phase 5 · Pseudonymization

- Term groups, matching, MuPDF redaction, metadata scrub, verification, review screen.
- Mapping file, `margin pseudonymize` and `margin restore`.
- **Gate:** leak tests green on all fixtures; restore reproduces anchors exactly.

### Phase 6 · Deploy

- PWA with service worker, CSP and SRI, Docker image with nginx.
- **Gate:** privacy E2E test passes against the deployed site.

## 14. Defaults and decisions

The defaults below were chosen so implementation can start; each is a setting or a small code change if decided otherwise.

| Decision | Default chosen |
| --- | --- |
| Margins | Both sides; side chosen by anchor position, overridable per comment |
| Page size | Enlarged uniformly, cap k_max = 1.3; content scaled down only beyond the cap |
| Output | Flattened comments only; no native PDF annotations |
| Comment font | Fira Sans 9 pt, math in MathJax Fira |
| Margin width | 150 pt per side |
| Leader style | `full` (dotted through the line, solid in the gutter) |
| Embedded original in export | Off (annotation file always embedded) |
| Grading report | Optional; without one, export contains only the annotated paper |
| License | AGPL-3.0 (forced by MuPDF.js if published) |
| Browsers | Firefox and Chromium, current stable, desktop only |

Resolved questions:

- **Name**: Margin.
- **Categories**: typo, error, general remark, well done, highlight as defaults. Adding categories and changing colors must be quick: a "+" chip in the palette opens an inline form (name, color picker, kind), and clicking a chip's color swatch recolors it (§7.1).
- **Embedded original**: off by default; the annotation file is always embedded (§8.2).
- **Two-column papers**: nearest-margin rule; the gap between text columns is not used for comments (§6.4).
- **Grading report**: optional; a PDF (or, via the CLI, a `.tex` file) placed before the annotated pages (§8.4).
- **Hosting**: local use first through `margin serve`, which serves the app and the bridge on one address; later a Docker image behind nginx (§11).
