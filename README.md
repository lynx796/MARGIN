# MARGIN

PDF annotation for grading: typed, colored, LaTeX-capable comments in widened page margins, laid
out automatically and exported as a flattened PDF. Local-first; see `margin-spec.md`.

Status: all six phases of the spec are implemented (core and CLI, web editor, agent workflow, layout and
export completeness, pseudonymization, deployment).

Documentation:

- [docs/guide.md](docs/guide.md): using Margin (web app, CLI, agents, pseudonymization, file format)
- [docs/deployment.md](docs/deployment.md): local setup and server deployment (Docker + nginx)
- [docs/privacy.md](docs/privacy.md): what happens to your data, verified against the code, with open findings

```sh
pnpm install
pnpm margin init paper.pdf
pnpm margin add paper.pdf --category error --quote "is continuous on" --body 'Only on \((0,1]\).'
pnpm margin read paper.pdf --pages 1-2
pnpm margin check paper.pdf
pnpm margin render paper.pdf -o out/      # PNGs for a visual check
pnpm margin export paper.pdf              # paper.annotated.pdf
```

Web app: `pnpm dev`, open the printed URL, drop a PDF (optionally with its `.annot.json`). Select
text, type, press Enter; Alt+drag selects a rectangle; digits 1–9 choose the category.

Live work with an agent: `pnpm margin serve --dir ~/grading` (after `pnpm --filter @margin/web build`)
serves the app and your PDFs on 127.0.0.1 and prints a URL with a session token. Open it, pick a PDF;
comments an agent adds with the CLI appear within a second, flagged "AI" until you accept them
(Enter, the badge, or "Accept all on page"). Give an agent `pnpm margin agent-guide` as its only briefing.

`pnpm margin --help` lists all commands. Development notes are in `AGENTS.md`.

License: AGPL-3.0-or-later (see `LICENSE`; required by MuPDF, which does the redaction).
