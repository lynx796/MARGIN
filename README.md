# MARGIN

PDF annotation for grading: typed, colored, LaTeX-capable comments in widened page margins, laid
out automatically and exported as a flattened PDF. Local-first; see `margin-spec.md`.

Status: phase 1 of 6 (core and CLI, no UI yet).

```sh
pnpm install
pnpm margin init paper.pdf
pnpm margin add paper.pdf --category error --quote "is continuous on" --body 'Only on \((0,1]\).'
pnpm margin read paper.pdf --pages 1-2
pnpm margin check paper.pdf
pnpm margin render paper.pdf -o out/      # PNGs for a visual check
pnpm margin export paper.pdf              # paper.annotated.pdf
```

`pnpm margin --help` lists all commands. Development notes are in `AGENTS.md`.
