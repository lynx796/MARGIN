# AGENTS.md — developing Margin

Margin is a local-first PDF grading annotator. The full specification is `margin-spec.md`; read the
section relevant to your task before changing behavior. This file is for agents *developing* Margin.
(Agents *using* Margin read `margin agent-guide` instead.)

## Commands

```sh
pnpm install                 # once
pnpm test                    # all unit, property and golden tests (Vitest)
pnpm typecheck               # tsc -b over all packages
pnpm margin <command> …      # run the CLI from source, e.g. pnpm margin read fixtures/plain/plain.pdf
pnpm fixtures:build          # recompile fixture PDFs from their .tex sources (needs latexmk)
pnpm golden:update           # regenerate golden outputs after an intended layout change; review the diff
```

## Packages

| Package | Role |
| --- | --- |
| `packages/core` | All logic. Framework-free TypeScript, runs in browser and Node. |
| `packages/cli` | The `margin` command. Thin wrapper: file I/O, argument parsing, PNG encoding. |

`packages/web` and `packages/bridge` come in later phases (spec §13).

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

The **display list** (`layout/types.ts`) is the contract between layout and rendering.

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
- Fixtures are LaTeX-compiled PDFs with their `.tex` sources and a reference `.annot.json`.

## Git

Work on a feature branch (`feat/<topic>`), commit in focused steps, merge into `main` with `--no-ff`
once `pnpm test` and `pnpm typecheck` pass.
