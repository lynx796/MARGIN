# Margin user guide

Margin grades compiled LaTeX papers: you select text in the PDF, type a comment (with math), press
Enter, and the comment appears in a widened page margin, typeset and connected to its text by a
colored leader. Export produces a flattened PDF for the student. Everything runs locally; see
[privacy.md](privacy.md). Installation: [deployment.md](deployment.md).

Contents: [Concepts](#concepts) · [The web app](#the-web-app) · [Comment markup](#comment-markup) ·
[Keyboard](#keyboard) · [Saving and files](#saving-and-files) · [Export](#export) ·
[AI agents](#working-with-ai-agents) · [Pseudonymization](#pseudonymization) · [CLI](#cli-reference) ·
[The annotation file](#the-annotation-file)

---

## Concepts

- **Annotation file.** All comments of `paper.pdf` live in `paper.annot.json`, plain JSON (schema:
  `margin schema`). It is the single source of truth for the web app, the CLI and agents. The PDF itself
  is never modified.
- **Anchor.** A comment is attached either to **text** (stored as the quoted words plus their position)
  or to a **region** (a rectangle, for formulas and figures). Quotes let a comment find its text again
  in a new revision of the paper.
- **Categories.** Each comment has a category with a color and a kind: *comment* (box in the margin) or
  *highlight* (colored marking only, no box). Defaults (ID in brackets, as used by the CLI): Typo
  (`typo`), Error (`error`), General remark (`remark`), Well done (`good`), Highlight (`hl`).
- **Layout.** Pages are enlarged (up to 1.3×, then the content is scaled down) so that both margins are
  about 150 pt wide. Comments are placed beside their anchor without overlapping; if a page is too
  full, the font steps down to 7.5 pt and then the least important comments move to a notes page after
  it. What you see on screen is exactly what the export contains.

---

## The web app

### Opening documents

- **With `margin serve`** (recommended): the start screen lists the PDFs of the served folder under
  *Local bridge*. Annotations are read from and written to `paper.annot.json` next to each PDF.
- **Drop** a PDF onto the window, optionally together with its `.annot.json`. Or click *Open a PDF*.
  In Chromium this opens the file picker; if you pick the `.annot.json` along with the PDF, every change
  is written back to that file, and changes made to it by other programs appear in the app (the file
  name is shown in the top bar; click it to stop).
- **Recent documents**: everything you opened is kept in this browser and listed on the start screen.
  ✕ removes a document from browser storage.
- **Exported PDFs** can be dropped too: Margin finds the attached annotation file and reopens the
  original paper (from the export if it was embedded, from browser storage, or from a PDF dropped along
  with it) as an editable document.
- **A new revision of a paper** with the old annotation file: Margin notices the mismatch and offers
  *Re-anchor*, which finds every quote in the new text.

### Writing comments

1. Choose a category: digits **1–9**, or click its chip in the top bar.
2. **Drag over text.** For a formula or figure, **Alt+drag** a rectangle instead.
3. Type the comment. The box grows in the margin while you type; math is rendered as you go.
4. **Enter** or **Esc** commits. **Shift+Enter** inserts a line break. An empty comment is deleted.

Highlight categories never open an editor: the selection is simply marked.

While editing, **Ctrl+1…9** changes the comment's category, **Ctrl+M** inserts `\(\)` and **@** opens a
picker to reference another comment (`\ref{id}`, printed as that comment's number).

### Navigating and changing comments

- Click a box, or focus it with **Tab** / **Shift+Tab** and press **Enter**, to edit.
- **Delete** removes the focused comment. **Ctrl+Z** / **Ctrl+Shift+Z** undo and redo everything,
  including changes made by agents.
- **Alt+L** / **Alt+R** pins the focused comment to the left or right margin (again to unpin).
- Drag the ends of a text anchor to adjust what it covers.
- **Ctrl+F** searches the paper's text and the comment bodies.
- The **sidebar** lists all comments in reading order; filter by category or origin (human, agent,
  unreviewed) and click to jump.
- **Badges** in the top bar warn about unresolved anchors, math errors, overflowing pages and
  unreviewed agent comments.

### Categories

- **+** in the category bar adds one (name, color, kind). Clicking a chip's color swatch recolors it.
- In *Settings*: rename, reorder, delete, choose the kind, and set the **weight** (heavier comments
  stay closer to their anchor when space is tight, and are moved to notes pages last).

### Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Margin width per side | 150 pt | Space for comments on each side |
| Maximum enlargement | 1.3 | How much a page may grow before its content is scaled down instead |
| Comment font size | 9 pt | Fira Sans; steps down automatically on crowded pages |
| Leader style | full | *full*: dotted line through the text line, solid in the gutter; *gutter only* |
| Horizontal crop | automatic | Where the paper's text block is, detected from the ink; override if needed |
| Grading report | none | A compiled report PDF placed before or after the paper on export |
| Attach the original paper to exports | off | Makes the export self-contained (roughly doubles its size) |
| Forget this document / Clear all data | | Delete this document, or everything, from browser storage |

Settings other than the category defaults are stored in the annotation file, so they travel with it.

---

## Comment markup

| Write | Result |
| --- | --- |
| `\(x^2\)` | Inline math (TeX, rendered by MathJax) |
| `\[ \sum_i x_i \]` | Display math on its own line |
| `**bold**`, `*italic*` | Bold, italic |
| `` `code` `` | Monospace |
| `\ref{id}` | The current number of another comment (a link in the export) |
| Shift+Enter / newline | Line break; an empty line starts a new paragraph |
| `\\`, `\*`, `` \` `` | A literal backslash, asterisk, backtick |

A TeX error shows the source in red and is counted in the warning badge; export still works.

---

## Keyboard

| Key | Where | Effect |
| --- | --- | --- |
| 1–9 | viewer | Choose the active category |
| drag / Alt+drag | page | Text anchor / region anchor |
| Enter, Esc | editor | Commit |
| Shift+Enter | editor | Line break |
| Ctrl+1…9 | editor | Change the category of this comment |
| Ctrl+M | editor | Insert `\(\)` |
| @ | editor | Reference another comment |
| Tab, Shift+Tab | viewer | Next / previous comment |
| Enter | focused comment | Edit it; on an agent comment: accept it |
| Delete, Backspace | focused comment | Delete it |
| Alt+L, Alt+R | focused comment | Pin left / right |
| Ctrl+Z, Ctrl+Shift+Z (Ctrl+Y) | anywhere | Undo, redo |
| Ctrl+F | anywhere | Search |
| Ctrl+S | anywhere | Save the annotation file |

On macOS, Cmd works wherever Ctrl is listed.

---

## Saving and files

Every change is saved in the browser immediately. In addition:

| Situation | Where annotations go |
| --- | --- |
| Opened through `margin serve` | `paper.annot.json` in the served folder, on every change |
| Chromium, annotation file opened or saved with the picker | That file, on every change |
| Otherwise | Browser only; **Ctrl+S** (*Save annotations*) downloads `paper.annot.json` |

When an annotation file changes on disk while it is open (an agent, the CLI, an editor), the change is
merged comment by comment and becomes one undo step. If the same comment was changed on both sides,
the disk version wins and yours is listed under *Conflicts* in the sidebar, where you can restore it.

---

## Export

*Export* writes `paper.annotated.pdf`:

- each page enlarged, the original page content unchanged (text stays selectable), comments, highlights
  and leaders drawn in, cross-references as links;
- notes pages after crowded pages, if needed;
- the grading report before (or after) the paper, if one is attached; otherwise exactly the annotated
  pages;
- the annotation file attached as `margin.annot.json`, so the export can be reopened in Margin; the
  original paper attached too if you enabled it.

Before exporting, Margin warns about unreviewed agent comments. The "AI" marks are not drawn into the
PDF, but the attached annotation file records which comments an agent wrote; see
[privacy.md](privacy.md#8-exported-pdfs).

Grading report: write it in LaTeX, compile it, and attach the PDF in *Settings → Grading report* (or
`margin export --report report.pdf`; the CLI can also compile `report.tex` with `latexmk`).

---

## Working with AI agents

Every operation in the web app has a CLI equivalent, so a coding agent (for example Claude Code) can
grade alongside you without a browser:

1. Start `margin serve --dir <folder>` and open the printed URL.
2. Give the agent the output of `margin agent-guide`; it explains quoting, categories, batches and checks.
3. The agent reads the paper (`margin read`), adds comments by quoting text (`margin add`,
   `margin apply`), checks them (`margin check`) and looks at the result (`margin render`).
4. Its comments appear in your tab within a second, with a dashed outline and an "AI" badge. Accept one
   with Enter or by clicking the badge, all on a page with *Accept all on page*, or edit it (which
   accepts it too). The sidebar filter *unreviewed* lists the rest.

Give agents pseudonymized copies of student papers, not the originals (next section).

---

## Pseudonymization

Makes a copy of a paper with names and IDs replaced by tokens such as `[AUTHOR_1]`, for an AI agent or
another external service, and transfers the comments made on the copy back to the original.

**Terms**, one group per line; variants separated by `|`; `/…/` is a regular expression:

```
AUTHOR_1: Anna Müller | A. Müller | Müller | Anna
AUTHOR_2: Jonas Keller | J. Keller | Keller
EMAIL: /[\w.+-]+@[\w-]+(\.[\w-]+)+/
LEGI: /\b\d{2}-\d{3}-\d{3}\b/
```

**In the web app:** *Pseudonymize…* in the top bar. Margin suggests candidates (title block, e-mail
addresses, ID patterns, names after "by"/"Author"/"Name"); add the ones you want. *Redact and verify*
removes the matched text, scrubs metadata, bookmarks, attachments, forms and links, and verifies the
result. Then **check the review by eye** (names in images cannot be detected), tick the confirmation,
and save the copy and the mapping file, or continue on the copy in the browser. On the copy,
*Transfer to original* copies your comments back with the real names.

**With the CLI:**

```sh
margin pseudonymize paper.pdf --suggest                 # candidate terms, writes nothing
margin pseudonymize paper.pdf --terms terms.txt --review review/
#   → paper.pseudo.pdf, paper.pseudo.json (mapping, keep private),
#     paper.pseudo.annot.json (if paper.annot.json existed), review/*.png to check by eye
# … the agent annotates paper.pseudo.pdf …
margin restore paper.pseudo.annot.json --map paper.pseudo.json --original paper.pdf [--as AUTHOR_1=Anna]
```

`restore` checks that both PDFs match the mapping, replaces tokens by the first variant of each group
(or the `--as` text), and writes the comments into `paper.annot.json`.

Keep `terms.txt` and the mapping file away from the agent. Limits (images, unlisted names, PDFs without
text mapping) are listed in [privacy.md](privacy.md#92-what-it-cannot-do).

---

## CLI reference

`margin --help` prints the full list; every command takes `--json` (machine-readable output and
errors) and `--annot <file>`. Exit codes: 0 ok, 1 problems found, 2 usage or I/O error.

| Command | Purpose |
| --- | --- |
| `margin init paper.pdf` | Create `paper.annot.json` with the default categories |
| `margin read paper.pdf [--pages 3-5]` | Page text as Markdown, line-numbered, existing comments inline |
| `margin list [--page N] [--category C]` | Comments with number, ID, category, page, quote, body |
| `margin add --page N --quote "…" --category C --body "…"` | Add a comment anchored by quote (`--prefix`/`--suffix` disambiguate; `--region x0,y0,x1,y1` for a rectangle) |
| `margin edit <id> [--body …] [--category …] [--side …] [--reviewed]` | Change a comment |
| `margin rm <id>` | Delete a comment |
| `margin apply ops.json` | Many add/edit/rm operations, all or nothing |
| `margin resolve` | Fill in missing positions and quotes |
| `margin check` | Schema, unresolved anchors, math errors, dangling `\ref`, overflow, report |
| `margin render paper.pdf -o dir [--pages N] [--dpi 150]` | PNG per annotated page, for a visual check |
| `margin export paper.pdf [-o out.pdf] [--report r.pdf\|r.tex] [--position before\|after]` | The flattened PDF |
| `margin import exported.pdf [original.pdf]` | Recover the annotation file (and embedded original) from an export |
| `margin pseudonymize`, `margin restore` | See [Pseudonymization](#pseudonymization) |
| `margin serve [--dir D] [--port 7311] [--allow-origin URL]` | The local bridge and app ([deployment.md](deployment.md)) |
| `margin schema`, `margin agent-guide` | The JSON Schema; the guide for agents |

`MARGIN_NOW` (ISO time) and `MARGIN_SEED` (integer) pin timestamps and new IDs, for reproducible runs.

A batch for `margin apply`:

```json
[
  { "op": "add", "page": 2, "quote": "for all n", "category": "typo", "body": "for all \\(n \\ge 1\\)" },
  { "op": "edit", "id": "k3f9qd", "body": "New text" },
  { "op": "rm", "id": "p8x2mz" }
]
```

---

## The annotation file

```json
{
  "format": "margin-annot",
  "version": 1,
  "document": { "fileName": "paper.pdf", "sha256": "…", "pageCount": 12, "pages": [{ "width": 595.28, "height": 841.89 }] },
  "categories": [{ "id": "error", "name": "Error", "color": "#dc2626", "kind": "comment", "weight": 3 }],
  "settings": { "marginWidth": 150 },
  "annotations": [
    {
      "id": "k3f9qd",
      "category": "error",
      "body": "Only on \\((0,1]\\).",
      "anchor": { "type": "text", "page": 3, "quote": { "exact": "is continuous on", "prefix": "…", "suffix": "…" }, "quads": [[72.1, 340.2, 151.8, 350.6]] },
      "side": "auto",
      "origin": "human",
      "created": "2026-11-11T09:00:00Z",
      "modified": "2026-11-11T09:00:00Z"
    }
  ]
}
```

- Coordinates are PDF points of the original page, origin at the top-left of the crop box, y down.
- A hand-written annotation needs only `category`, `body` and an anchor with `page` and `quote.exact`;
  IDs, timestamps and positions are filled in by the next tool that loads the file.
- Unknown fields, including `x-*` keys for your own or an agent's metadata, are kept on every round trip
  (and travel into exports; see [privacy.md](privacy.md#8-exported-pdfs)).
- `margin schema` prints the complete JSON Schema (`schema/annot.schema.json`).
