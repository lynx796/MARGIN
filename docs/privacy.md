# Privacy and security

Margin is used to grade student work, so the documents it handles contain personal data: names, student
IDs, e-mail addresses, and the work itself. This page describes **everything Margin does with that data**:
where it is stored, what goes over the network, what ends up in the files it writes, and where the
limits are.

Each statement below is marked with how it was checked:

- ✅ **Verified**: checked in the code *and* by an automated test that runs in CI, or by direct
  inspection of the built output. The test or file is named.
- 🔍 **Code-checked**: confirmed by reading the implementation; no dedicated test.
- ⚠️ **Flag**: a limitation, a risk, or a point where the implementation differs from
  `margin-spec.md`. The full list is in [Findings](#findings-spec-vs-implementation).

Audit date: 2026-11-11, on branch `feat/phase6-deploy`.

---

## 1. In short

- Margin has **no server-side logic and no accounts**. The web app is a set of static files; all
  processing (PDF parsing, layout, math, export, redaction) runs in your browser or in the local CLI.
- **No request leaves the app's origin.** The browser enforces this with a Content Security Policy,
  and an end-to-end test checks it in Chromium and Firefox during a full session.
- Documents and annotations are kept in **your browser's storage for the app's address**, and in
  files you save yourself. Nothing is uploaded.
- Margin **does not contact any AI service**. If you let an AI agent work with Margin, the agent
  reads files on your computer, and the agent's provider sees whatever the agent reads. Use a
  pseudonymized copy for that (section 9).
- Exported PDFs **carry the full annotation file as an attachment**, including which comments an AI
  agent wrote (section 8). Read that section before you send exports to students.

---

## 2. What data Margin handles

| Data | Personal? | Comes from |
| --- | --- | --- |
| The paper (PDF) | Yes: names, IDs, e-mails, the student's work, PDF metadata (author, file paths in pdfTeX keys) | You open it |
| Annotation file (`.annot.json`) | Yes: your comments, quotes from the paper, file name and SHA-256 of the paper, timestamps, who wrote each comment (`origin`), agent metadata (`x-*`) | Margin, you, agents |
| Grading report (PDF) | Usually: names, grades | You attach it |
| Pseudonymization terms (`terms.txt`) | **Yes, by definition**: the names and IDs to remove | You type them |
| Mapping file (`.pseudo.json`) | **Yes**: token ↔ real name | Margin creates it |
| Pseudonymized copy (`.pseudo.pdf`) | Reduced (see section 9 for what remains) | Margin creates it |
| Bridge token | Secret | `margin serve` prints it |

---

## 3. Where data is stored

### 3.1 In the browser

All browser storage belongs to the app's **origin** (scheme + host + port). 🔍 `packages/web/src/lib/storage.ts`, `bridge.ts`, `PageView.svelte`.

| Storage | Key / path | Content | Lifetime |
| --- | --- | --- | --- |
| Origin Private File System | `margin/<sha256>/document.pdf` | Every PDF you open, **including PDFs opened through the bridge** and pseudonymized copies you continue on | Until forgotten or cleared |
| OPFS | `margin/<sha256>/annotations.json` | The annotation file (autosaved 300 ms after each change) | Same |
| OPFS | `margin/<sha256>/report.pdf` | Attached grading report | Same |
| IndexedDB `margin` → `blobs` | same keys | Fallback when OPFS is unavailable (some private modes) | Same |
| IndexedDB `margin` → `docs` | `<sha256>` | File name, page count, last change (the "Recent documents" list) | Same |
| IndexedDB `margin` → `kv` | `defaultCategories` | Your category set | Same |
| IndexedDB `margin` → `kv` | `terms:<sha256 of original>` | **The pseudonymization terms you typed (real names)** | Same |
| IndexedDB `margin` → `kv` | `pseudo:<sha256 of copy>` | **The mapping file (real names)** | Same |
| IndexedDB `margin` → `kv` | `handle:<sha256>` | File handle of a linked annotation file (Chromium; reveals the file name, grants nothing without your permission) | Same |
| `sessionStorage` | `margin.bridge` | Bridge address and token | Until the tab is closed |
| `localStorage` | `margin.hint.region` | "Hint was shown" flag, no document data | Until cleared |
| Cache Storage | `margin-<build hash>` | The app's own files (JS, CSS, fonts, WASM), **no document data** | Replaced by the next deployment |

**Deleting data** ✅ (`e2e/persistence.spec.ts`, `e2e/settings.spec.ts`; the *Clear all data* test
inspects IndexedDB, OPFS and `localStorage` afterwards):

- *Forget this document* (settings, or ✕ on the start screen) deletes the PDF, annotation file, report,
  terms, mapping and file handle stored for **that document's hash**.
- *Clear all data* (settings) empties all the stores above except Cache Storage (app files only) and
  the bridge connection of open tabs.

⚠️ **Each origin has its own storage.** `http://127.0.0.1:7311`, `http://127.0.0.1:7312`,
`http://localhost:7311` and `https://margin.example.org` are four separate stores. Forgetting or
clearing in one does not touch the others. Use the browser's site-data settings to see all of them.

⚠️ **The pseudonymized copy is a separate document.** Forgetting the original removes its terms, but
the copy (if you continued on it in the browser) and its mapping (real names) stay until you forget
the copy too.

⚠️ The browser decides how long storage lasts. Margin does not request persistent storage, so under
storage pressure the browser may evict it; and it is not encrypted beyond what your OS profile
provides. Anyone with access to your browser profile can read it.

### 3.2 On disk

Margin writes files only where you tell it to:

- **Web app**: downloads, the save picker (Chromium), a linked annotation file (Chromium, section 6),
  or through the bridge into the served directory.
- **CLI**: next to the PDF (`paper.annot.json`, `paper.annotated.pdf`, `paper.pseudo.pdf`,
  `paper.pseudo.json`, `paper.pseudo.annot.json`) or to `-o`. Writes are atomic (temp file + rename).
  🔍 `packages/cli/src/workspace.ts`.
- The bridge writes `.annot.json` files inside its directory only, via a hidden temp file and rename.
  ✅ `packages/bridge/test/bridge.test.ts`.

---

## 4. Network

### 4.1 What the app requests

✅ **No request leaves the origin during a full session.** `e2e/privacy.spec.ts` records every request
of the browser context (pages, workers, service worker) while it opens a paper, writes a comment with
math (MathJax loads glyph data on demand), exports (worker, embedded fonts), pseudonymizes (MuPDF
WebAssembly) and reloads offline. It passes in Chromium and Firefox. `e2e/export.spec.ts` checks the
same for the export path.

✅ **Everything is self-hosted.** The build output (`packages/web/dist`) contains all fonts, WASM and
MathJax data; there are no CDN, analytics, telemetry or update requests. pdf.js runs with
`useSystemFonts: false` and `disableFontFace: true`, and no font, CMap or decoder URLs are configured,
so it never fetches anything. 🔍 `packages/core/src/pdf/document.ts`.

The only requests are:

| Request | When |
| --- | --- |
| App files from the app's own origin | Page load; afterwards from the service worker cache |
| `http://127.0.0.1:<port>/api/…` | Only when you connected a bridge (section 7) |

### 4.2 Content Security Policy

✅ The same policy is sent as an HTTP header by `margin serve` and by the nginx image, and as a
`<meta>` tag in the built `index.html` (`packages/bridge/src/csp.ts` is the single source;
`packages/web/test/deploy.test.ts` checks that nginx sends exactly that string; `privacy.spec.ts`
checks the meta tag, and the header when run against a deployment).

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:; font-src 'self'; worker-src 'self' blob:;
connect-src 'self' http://127.0.0.1:*; form-action 'none'; base-uri 'none'; frame-ancestors 'none'
```

What it means for your data:

- `connect-src 'self' http://127.0.0.1:*`: scripts can send data **only** to the app's own origin and to
  loopback. The browser blocks everything else, even if a dependency tried.
- `script-src 'self'`: no inline or third-party scripts; no `eval` (only WebAssembly compilation).
- `form-action 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`: no form submissions, no base-URL
  tricks, the app cannot be framed by another site.
- ✅ `e2e/smoke.spec.ts` asserts that a session causes no CSP violation.

Additional headers (nginx and `margin serve`): `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`; nginx also sends `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and
`Cross-Origin-Resource-Policy: same-origin` and a restrictive `Permissions-Policy`.

⚠️ `style-src 'unsafe-inline'` is allowed (Svelte and CodeMirror set inline styles). It does not
permit sending data anywhere (`connect-src` and `img-src` still apply).

⚠️ `img-src data:` and `blob:` are allowed (generated previews). A `data:` image cannot leak data off
the device.

### 4.3 Offline use and the service worker

✅ After the first visit the app works without network: `sw.js` (generated by
`packages/web/offline.ts`) precaches every file of the build. `privacy.spec.ts` reloads the app
offline and opens a stored paper.

🔍 The service worker handles only `GET` requests to its own origin and **never** `/api/` (bridge) or
other origins. It stores app files only; documents never pass through it. Pages are fetched
network-first (a new deployment is picked up at once), assets cache-first.

⚠️ The first visit downloads the whole app (about 22 MB, mostly the MuPDF WebAssembly needed for
pseudonymization) so that everything works offline later.

### 4.4 Subresource Integrity

✅ The build adds `integrity="sha384-…"` to the entry script, all module preloads and the stylesheet
in `index.html` (`packages/web/offline.ts`; tested in `packages/web/test/deploy.test.ts`; verified
against the built file).

⚠️ Chunks loaded later (MathJax glyph data, the export and redaction workers, WebAssembly) carry no
integrity attribute: browsers offer no way to do so for dynamic imports without an inline import map,
which the CSP forbids. They are same-origin and limited by `script-src 'self'`. In practice SRI
protects against tampering by a CDN; Margin uses none.

---

## 5. Hosted deployment (server)

✅ **The server only serves files.** The nginx configuration (`deploy/nginx.conf`) answers `GET` and
`HEAD` only (every other method gets 405) and proxies nothing (`deploy.test.ts` checks both). There is
no endpoint that could receive a document. Documents are never sent to the server; they stay in the
visitor's browser.

🔍 **Access logs are off** in the shipped configuration. If you turn them on, they contain visitors' IP
addresses, user agents and the asset URLs they loaded (never document data). Mention that in your
privacy notice if you enable them.

⚠️ The server operator controls the code that browsers run. Whoever can change the files on the
server can change the CSP and the app. A hosted copy is therefore only as trustworthy as its operator;
the local setup (`margin serve`) avoids this.

⚠️ **AGPL-3.0 §13**: a hosted copy must offer its users the source code. Build the image with
`--build-arg SOURCE_URL=https://…` so that the start screen links to it.

---

## 6. Chromium file handles

🔍 In Chromium, *Open* uses the browser's file picker. If you pick the annotation file together with
the PDF, or save it with *Save annotations*, the app keeps a handle to that one file, writes every
change to it and re-reads it once a second to pick up changes by other programs
(`packages/web/src/lib/filelink.ts`). ✅ `e2e/filelink.spec.ts`.

- The browser asks for permission; the app can access **only the file you picked**, nothing else in
  its folder.
- The handle is remembered (IndexedDB `kv` → `handle:<sha256>`) so the link can be restored next
  time; the browser asks again for permission after a restart.
- Clicking the file name in the top bar stops the link.

---

## 7. The local bridge (`margin serve`)

`margin serve --dir D` starts an HTTP server that lets the web app read the PDFs and read/write the
annotation files of one directory, and serves the app itself. ✅ for all points below:
`packages/bridge/test/bridge.test.ts` (access control, traversal, preflight, SSE) and
`e2e/bridge.spec.ts` (real browser, real server).

| Protection | Detail |
| --- | --- |
| Loopback only | Listens on `127.0.0.1`; not reachable from the network |
| Token | 24 random bytes (`crypto.randomBytes`), compared in constant time. Every `/api/` request needs `Authorization: Bearer <token>`. A wrong token gets 401 |
| DNS rebinding | The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` |
| Origin | A browser request whose `Origin` is not the bridge itself or an `--allow-origin` is refused (403); CORS and Private Network Access preflights are answered only for those origins |
| Path confinement | Only `.pdf` and `.annot.json` below `D`; no `..`, no dotfiles or dot-directories, no backslashes or NUL; symbolic links that lead out of `D` are refused; directory listing skips dotfiles and does not follow symlinked directories |
| Writes | Only annotation files; validated against the schema before writing (422 otherwise), at most 32 MB, optimistic concurrency with `If-Match` (412 on a stale version) |
| App files | Served with the CSP header, `nosniff`, `no-referrer` |

How the token travels: `margin serve` prints `http://127.0.0.1:7311/#token=…`. The token is in the URL
**fragment**, which browsers never send to a server. The app moves it to `sessionStorage` (this tab
only) and removes it from the address bar.

⚠️ **The token is per session, not one-time.** The spec says "one-time random token"; the
implementation issues one random token per `margin serve` run, valid until the process stops, and
reusable by any program that knows it. Stop `margin serve` when you are done.

⚠️ The URL with the token is printed to the terminal (and in `--json` output). Anything that records
your terminal (logs, screen sharing) records the token. Browsers may keep the initially opened URL in
their history even after the app removed it from the address bar.

⚠️ Any local program that knows the token can read every PDF under `D` and write annotation files
there. Serve a directory that contains only the papers you are grading, not your home directory.

⚠️ **Hosted app + local bridge.** With `margin serve --allow-origin https://margin.example.org`, the
hosted page may talk to your local bridge. The hosted page's code then reads your local files, so you
trust the operator of that site (section 5). Recent Chromium versions additionally ask you to allow
"local network access" for that site.

⚠️ Documents opened through the bridge are also saved in browser storage (section 3.1), so that they
appear under "Recent documents". Forget them there if you do not want a browser copy.

---

## 8. Exported PDFs

What an exported `paper.annotated.pdf` contains (🔍 `packages/core/src/render-pdf/render.ts`;
✅ `packages/cli/test/roundtrip.test.ts`):

- The original pages, embedded unchanged as vector content (text stays selectable), with comments,
  highlights and leaders drawn on top. Annotations of the original (links, comments) are dropped.
- Metadata: **Title** = the paper's title (or file name), Producer = `Margin <version>`, Creator =
  `Margin`, creation/modification date = the latest comment's `modified` time. The paper's Author,
  Subject, Keywords and XMP are **not** copied.
- **Attachment `margin.annot.json`, always.** This is the complete annotation file, so that the export
  can be re-imported. It contains:
  - every comment's body and the quoted text of the paper;
  - the paper's file name and SHA-256;
  - creation and modification timestamps of each comment (when you graded);
  - **`origin: "agent"` and `reviewed` on comments written by an AI agent**;
  - any `x-*` metadata an agent added (for example its reasoning);
  - the grading report's file name and hash, if one is attached.
- Attachment `margin.original.pdf`, only if *Embed original* is enabled (off by default).
- The grading report pages, if attached.
- Document ID: derived from the paper's hash and the layout (deterministic exports), so two exports of
  the same paper can be recognised as related.

⚠️ **The "AI" badge is not drawn into the export, but the provenance is in the attachment.** Anyone who
opens the attachments panel of a PDF viewer can read which comments came from an agent, whether you
reviewed them, when each comment was written, and any `x-*` notes. The spec does not mention this.
If students should not see it, strip those fields before exporting (for example with `margin apply`
edits, or by removing `x-*` keys), or decide on and document a policy.

⚠️ Pages of the original are embedded as-is, including what the student's PDF contains in them
(for example pdfTeX's `PTEX.FileName` keys on included figures, which can reveal local paths of the
student's computer). Margin does not add anything of yours there.

---

## 9. Pseudonymization

Purpose: produce a copy of a paper without names so that it can be given to an AI agent or another
service, and transfer comments made on the copy back to the original. Spec §10.

### 9.1 What it does

✅ `packages/cli/test/pseudo.test.ts` (leak test on the `names` fixture: text, metadata, outlines, raw
bytes and decoded streams), `packages/core/src/pseudo/*.test.ts`, `e2e/pseudo.spec.ts`.

1. **Terms.** You list groups such as `AUTHOR_1: Anna Müller | A. Müller | Müller`, or regular
   expressions such as `/\b\d{2}-\d{3}-\d{3}\b/`. Suggestions (title block, e-mails, ID patterns,
   words after "by", "Author", "Name") are offered but never applied without your confirmation.
2. **Matching** on the extracted text after normalization (Unicode NFKC, combining marks, ligatures,
   hyphenation across lines, case), including possessives and OT1-style accents ("M¨uller").
3. **Redaction** with MuPDF: glyphs under each match are **removed from the content stream** (not
   covered), then `[AUTHOR_1]` is drawn in the freed space.
4. **Scrub**, whether or not a term matched: Info dictionary (Title replaced by its pseudonymized form),
   XMP metadata, pdfTeX keys, associated files (`/AF`), embedded files, forms, JavaScript, open
   actions, page annotations (all, not only links), thumbnails, structure tree, piece info; bookmark
   titles are pseudonymized and only internal targets kept; named destinations are renamed;
   unreferenced objects are garbage-collected; the trailer `/ID` is regenerated.
5. **Verification** on the result, independent of how it was made: extracted text must contain no
   term (also approximately, edit distance ≤ 10 %), the scrubbed places must be empty, and no term may
   appear in the raw file or any decoded stream (Latin-1, UTF-8, UTF-16). **If anything is found,
   nothing is written.**
6. **Review.** In the web app the copy cannot be saved until you tick that you checked it by eye; the
   CLI writes review PNGs with `--review dir`.
7. The copy's annotation file has terms replaced in bodies, quotes, category names and all other text
   fields; the grading report reference is removed.
8. **Restore** checks both hashes, copies comments back, replaces tokens by the real names and takes
   quotes from the original by position.

✅ Fixed during this audit: unknown top-level fields of the annotation file (for example an agent's
`x-*` notes) were copied into the copy's annotation file **without** substitution. They are now
substituted (`packages/core/src/pseudo/mapping.test.ts`).

### 9.2 What it cannot do

⚠️ **Text inside images** (scans, photos, logos, signatures, screenshots) is not detected. This is
why the review by eye is mandatory.

⚠️ **Only the terms you list are removed.** A name you did not list, a nickname, a misspelling beyond
the fuzzy threshold, or identifying content (acknowledgements, "my supervisor at …", a project name)
stays. The suggestions are heuristics.

⚠️ **PDFs whose fonts have no Unicode mapping** (text that pastes as gibberish) cannot be matched, and
the verification cannot see names in them either. Check such papers especially carefully, or do not
pseudonymize them automatically.

⚠️ **Everything except the matched glyphs stays**: page layout, figures, drawings, font names,
document structure, writing style. These can allow re-identification by someone who knows the
students.

⚠️ The **mapping file and the terms contain the real names.** They never go into an exported or
pseudonymized file (🔍 `render-pdf` attaches only the annotation file and, optionally, the original;
the mapping is a separate download), but they are in browser storage (section 3.1) and in
`paper.pseudo.json` next to the paper. Never give them to the agent.

⚠️ MuPDF is AGPL-3.0, which makes the whole project AGPL-3.0 (section 5).

---

## 10. AI agents

- 🔍 Margin itself never contacts an AI service; there is no API key, model call or upload anywhere in
  the code.
- An agent using Margin reads the paper through `margin read`, which prints **the full page text**,
  and may render page images with `margin render`. Whatever the agent reads goes to the agent's
  provider under that provider's terms.
- To limit what the provider sees: pseudonymize first, let the agent work on `paper.pseudo.pdf` only,
  and run `margin restore` yourself. Do not give the agent access to the directory that holds the
  original, the terms file or the mapping file. When using `margin serve` with an agent, serve a
  directory that contains only the pseudonymized copies.
- Agent comments are marked (`origin: agent`) and shown with a dashed outline and an "AI" badge until
  you accept them; export warns about unreviewed agent comments. ✅ `e2e/bridge.spec.ts`.

---

## 11. CLI

- 🔍 No network access: the CLI reads and writes local files; MathJax and fonts load from
  `node_modules` and `fonts/`. `margin serve` is the only command that opens a socket (loopback only).
- ⚠️ `margin export --report report.tex` runs your local `latexmk` on that file. TeX can read files
  and, if your TeX installation enables shell escape, run commands. Only compile reports you wrote.

---

## 12. Supply chain

- 🔍 Dependencies are pinned by `pnpm-lock.yaml`; the Docker build uses `--frozen-lockfile`.
- 🔍 The web build is reproducible: two builds of the same commit produced identical files (the
  service worker's cache name, a hash over every file, was identical across builds in this audit).
- ⚠️ The Dockerfile references base images by tag (`node:22-alpine`,
  `nginxinc/nginx-unprivileged:stable-alpine`). Pin them by digest for reproducible images.
- ✅ The Docker image was built and run with the hardening options of `deploy/compose.yaml`
  (read-only, all capabilities dropped), and `privacy.spec.ts` passed against it in Chromium and
  Firefox, including the CSP header check (2026-11-15). Run the checks in
  [deployment.md](deployment.md#5-verify-a-deployment) after deploying your own copy.

---

## Findings: spec vs. implementation

Status after this audit. "Fixed" items were changed on branch `feat/phase6-deploy`.

| # | Spec says | Implementation | Status |
| --- | --- | --- | --- |
| 1 | §11, phase 6: service worker, SRI, Docker/nginx, privacy E2E test | Missing entirely before this audit | **Fixed**: `offline.ts`, `deploy/`, `Dockerfile`, `e2e/privacy.spec.ts` |
| 2 | §10: copy's annotation file has tokens substituted | Unknown top-level fields (`x-*`) were copied unchanged, leaking names to the agent | **Fixed**, with test |
| 3 | §2: released under AGPL-3.0 | No `LICENSE` file; no source offer for hosted copies (AGPL §13) | **Fixed**: `LICENSE`, start screen notice, `SOURCE_URL` build arg. Operators must set it |
| 4 | §2, §7.6, phase 4: Chromium file handles: open with handle, write back, poll | Not implemented (only the save picker for exports) | **Fixed**: `filelink.ts`, `e2e/filelink.spec.ts`. Differs from spec: the app cannot write "next to the PDF" without a directory handle, so the *picked or saved annotation file* is linked; debounce 300 ms (shared autosave) instead of 1 s |
| 5 | §11: "Clear all data wipes the origin's storage" | Cleared Margin's stores but left a `localStorage` flag; does not touch the service-worker cache (app files only) or other origins | Flag cleared now; the rest **documented** (3.1) |
| 6 | §9.4: AI marks never in the export | True for the drawing; but `origin`, `reviewed`, timestamps and `x-*` are in the embedded annotation file | **Open, needs a decision** (8) |
| 7 | §9.3: "one-time random token" | Per-session, reusable token | **Open**, documented (7) |
| 8 | §11: access logs "contain only asset requests" | True, but they would contain IPs and user agents | nginx access log **off by default** |
| 9 | §11: SRI "on all script tags" | On every tag in `index.html`; impossible for dynamic chunks/workers under this CSP | **Documented** (4.4) |
| 10 | §11: reproducible build | Web build reproducible; Docker base images by tag | **Open**: pin digests |
| 11 | §10.3: "Link annotations removed" | All page annotations removed, plus more than the spec lists | Stricter than spec (fine) |
| 12 | §11: hosted app reaches local bridge | Works with `--allow-origin`; Chromium may show a local-network permission prompt | **Documented** (7) |
| 13 | §12.3: exports open in Acrobat Reader and macOS Preview | Only pdf.js/Chromium/Firefox are tested automatically | **Manual check needed** |
| 14 | §12.1: ~10 fixtures incl. a scanned page and `amsthm` | 7 fixtures; no scanned page (the main case pseudonymization cannot handle) | **Open** |
| 15 | — | `?e2e` test hooks ship in the production build (expose app state on `window`, disable the save picker) | Low risk under the CSP; **documented** |
| 16 | — | Documents opened via the bridge are copied into browser storage | **Documented** (3.1, 7) |
