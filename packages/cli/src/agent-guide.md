# Margin — guide for agents

Margin puts typeset comments in the margins of a compiled PDF (a paper, thesis or exercise
sheet). You work through the `margin` command and plain files; a human reviews your comments
in the browser, where they appear within a second if `margin serve` is running.

Coordinates never matter to you: you anchor a comment by **quoting text** from the paper.

## Workflow

```sh
margin init paper.pdf                    # once; creates paper.annot.json (skip if it exists)
margin read paper.pdf --pages 1-4        # the text, line-numbered, existing comments inline
margin add paper.pdf --page 2 --quote "is continuous on" --category error --body 'Only on \((0,1]\).'
margin apply ops.json paper.pdf          # many comments at once (see below)
margin check paper.pdf                   # must report no errors
margin render paper.pdf --pages 2 -o /tmp/r/   # PNG of page 2 with comments, to look at
```

If you are not in the PDF's directory, pass the PDF path; the annotation file is the PDF's
name with `.annot.json` next to it (or give `--annot file`). Add `--json` to any command for
machine-readable output; errors are then `{"ok": false, "error": {code, message}}`.
Exit codes: 0 ok, 1 problems found (invalid quote, check errors), 2 usage or I/O error.

## Reading

`margin read` prints one `# Page N` section per page, each line prefixed by its line number.
Existing comments show after their anchor as `⟦#4 error k3f9qd: body⟧` (number, category,
ID, body). Highlights show as `⟦hl id⟧`. Line numbers are for you only; never put them in a quote.
Read the pages you comment on before quoting them.

## Quoting

- Copy the quote **verbatim** from `margin read`, 3 to 15 words (a phrase, not a sentence).
  It may span a line break; write the words with single spaces.
- A word hyphenated at a line end (`inter-` / `national`) is quoted whole: `international`.
- Always pass `--page N`. If the quote occurs more than once on that page, the command fails
  and lists the candidates: quote more words, or add `--prefix "text before"` or
  `--suffix "text after"`.
- Quotes tolerate small differences (ligatures, accents, curly quotes, and up to 10 % typos),
  but a quote that cannot be found fails with `quote-unresolved`; fix the quote, do not guess.
- For a formula, figure or table with no text you can quote, use a region:
  `--page 3 --region x0,y0,x1,y1` in points of the original page (origin top-left, y down; page
  sizes are in `document.pages` of the annotation file). Use it only as a last resort.

## Categories

Default categories: `typo` (small slips), `error` (mathematical or factual mistakes),
`remark` (general remarks, questions), `good` (praise), `hl` (highlight only: no body).
`margin list` and the annotation file's `categories` show the ones in use; an unknown
category fails the command. Use `error` sparingly and only when you are sure.

## Comment text

The `--body` is a small markup language:

| Write | Result |
| --- | --- |
| `\(x^2\)` | inline math (TeX) |
| `\[ ... \]` | display math |
| `**bold**`, `*italic*`, `` `code` `` | styling |
| `\ref{id}` | cross-reference to another comment by ID |
| blank line | new paragraph |

Keep comments short (1–3 sentences; the margin is narrow). `margin check` reports `math-error`
for TeX that does not compile. Backslashes need care in transport: in a shell, put the body in
single quotes (`--body '\(x^2\)'`); in JSON, double every backslash (`"\\(x^2\\)"`).

## Batches

`margin apply ops.json` applies a list of operations **atomically**: all are validated first;
if any fails, nothing is written and every problem is listed with its index.

```json
[
  { "op": "add", "page": 2, "quote": "for all n", "category": "typo", "body": "for all \\(n \\ge 1\\)" },
  { "op": "add", "page": 2, "quote": "is bounded", "suffix": " by the", "category": "error", "body": "Not shown." },
  { "op": "edit", "id": "k3f9qd", "body": "New text", "category": "remark" },
  { "op": "rm", "id": "p8x2mz" }
]
```

Prefer one batch per page or section over many single calls. `margin add` prints the new ID.

## Rules

- Your comments carry `origin: agent`; the human reviews and accepts them. Do not edit or
  delete comments you did not create (`margin list` shows `origin`), and never set `--reviewed`.
- Never modify the PDF. Do not hand-edit coordinates (`quads`); give quotes and let Margin
  resolve them. You may edit `*.annot.json` directly (add `x-…` keys for your own metadata),
  but `margin add`/`apply` are safer: they validate and resolve quotes for you.
- Finish with `margin check`; if it reports `anchor-unresolved` or `anchor-ambiguous`, repair
  the quote of that comment (`margin rm <id>` and add it again, or `margin edit`).
- `margin export paper.pdf -o out.pdf` writes the flattened PDF with all comments; the
  human normally does this.
