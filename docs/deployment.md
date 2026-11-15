# Setup and deployment

Margin runs in two ways:

| Setup | What runs where | Use it when |
| --- | --- | --- |
| **Local** (recommended for grading with agents) | `margin serve` on your computer serves the app *and* your grading folder on `http://127.0.0.1:7311` | You grade on one machine, possibly with an AI agent |
| **Server** | A `margin` container behind your reverse proxy at `https://margin.example.org`; documents stay in each visitor's browser | Several people should use Margin without installing anything |

Both can be combined: the hosted app can talk to a `margin serve` running on the visitor's own computer
(see [Hosted app with a local bridge](#hosted-app-with-a-local-bridge)).

Before you deploy, read [privacy.md](privacy.md); it explains what each setup means for your data.

---

## Requirements

| | Local | Building the server image | Running the server image |
| --- | --- | --- | --- |
| Node.js ≥ 22 | ✓ | (inside Docker) | |
| pnpm 10 | ✓ | (inside Docker) | |
| Docker (or Podman) | | ✓ | ✓ |
| `latexmk` (TeX Live, MacTeX) | only for `margin export --report report.tex` and `pnpm fixtures:build` | | |
| A TLS reverse proxy (Caddy, nginx, Traefik) | | | ✓, for anything other than `localhost` |

pnpm: Node 22 and 24 ship Corepack, so `corepack enable` provides the version pinned in
`package.json`. On Node 25 and later, install it with `npm install -g pnpm@10`.

Supported browsers: current Firefox and Chromium-based browsers (Chrome, Edge, Brave), desktop.

---

## Local setup

### 1. Install

```sh
git clone <your Margin repository> margin
cd margin
corepack enable          # once per machine (Node 22/24)
pnpm install
pnpm --filter @margin/web build
```

Check the installation (optional, about 5 s):

```sh
pnpm test
```

### 2. Make the `margin` command available

The CLI runs from the sources; there is no separate build step. Either use `pnpm margin …` inside the
repository, or put a wrapper on your `PATH`:

```sh
mkdir -p ~/bin
cat > ~/bin/margin <<EOF
#!/bin/sh
exec node "$PWD/packages/cli/bin/margin.js" "\$@"
EOF
chmod +x ~/bin/margin
margin --help
```

(`~/bin` must be on your `PATH`; adapt for your shell.)

### 3. Start Margin for a grading folder

```sh
margin serve --dir ~/grading/assignment-3
```

It prints:

```
Margin bridge for /Users/you/grading/assignment-3
Open: http://127.0.0.1:7311/#token=3f1c…
Press Ctrl+C to stop.
```

Open that URL in Firefox or Chromium. The start screen lists the PDFs in the folder; pick one and grade.
Annotations are written to `<paper>.annot.json` next to each PDF, and changes made by the CLI or an
agent appear in the open tab within a second.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--dir D` | current directory | Folder whose PDFs and annotation files are served (subfolders included) |
| `--port N` | 7311 | Port on 127.0.0.1 |
| `--allow-origin URL[,URL…]` | none | Other app origins allowed to use this bridge (hosted app) |
| `--app-dir D` | `packages/web/dist` | Built web app to serve |
| `--json` | | Print the URL and token as JSON (for scripts) |

Recommendations:

- Serve a folder that contains **only** the papers you are grading, not your home directory.
- Stop `margin serve` (Ctrl+C) when you are done; the token is valid until then.
- Use the same port every time: browser storage belongs to the address, so a different port means a
  different (empty) list of recent documents.
- The token changes on every start. If a tab says the bridge refused the token, open the new URL.

### 4. Without the bridge

The app also works without folder access: open it (from `margin serve` or a hosted copy) and drop PDFs onto it instead of picking them
from the "Local bridge" list. Documents and annotations then live in browser storage; use *Save
annotations* (Ctrl+S) and *Export* to get files out. In Chromium, *Open* uses the file picker; picking
the `.annot.json` together with the PDF keeps that file updated.

For development only: `pnpm dev` (hot reload, no CSP) and `pnpm --filter @margin/web preview` (CSP as a
meta tag only). Do not use them for real grading.

### 5. Updating

```sh
git pull
pnpm install
pnpm --filter @margin/web build
```

Restart `margin serve`. The open tab loads the new version on the next reload; the service worker
replaces its cache automatically.

### 6. Working with an AI agent

Give the agent the output of `margin agent-guide` as its briefing and let it run `margin` commands in
the grading folder while `margin serve` is running. Its comments appear live, marked "AI", until you
accept them. For student papers, give the agent **pseudonymized copies only**:

```sh
margin pseudonymize paper.pdf --terms terms.txt --review review/   # writes paper.pseudo.pdf + paper.pseudo.json
# check review/*.png by eye, then move paper.pseudo.pdf into the agent's folder
margin restore paper.pseudo.annot.json --map paper.pseudo.json --original paper.pdf
```

Keep `terms.txt`, `paper.pseudo.json` and the originals out of the agent's reach. See
[guide.md](guide.md#pseudonymization) and [privacy.md](privacy.md#10-ai-agents).

---

## Server deployment

On a server, Margin is one container behind your reverse proxy, like any other service. It publishes no
ports; your proxy reaches it over a shared Docker network as `http://margin:8080`. The container only
serves the app's files (nginx inside, unprivileged, read-only file system, no capabilities). It has no
data, no database and no volume; visitors' documents never reach the server.

### 1. Start it

The proxy network must exist (most reverse-proxy setups already have one; the default name is `proxy`):

```sh
docker network create proxy        # only if it does not exist yet; attach your proxy to it
```

Then, in the repository:

```sh
git clone <your Margin repository> margin && cd margin
docker compose up -d --build
```

That builds the image from the checkout (nothing is pulled from a registry except the base images) and
starts the container `margin` on the network `proxy`.

Optional settings go in a `.env` file next to `compose.yaml` (git ignores it, so `git pull` never
touches it):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXY_NETWORK` | `proxy` | Name of your reverse proxy's Docker network |
| `MARGIN_SOURCE_URL` | empty | Link to the source code, shown on the start screen. The AGPL-3.0 (section 13) requires that users of a hosted copy can get its source; set it to the code you deploy |

### 2. Point your reverse proxy at it

nginx:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name margin.example.org;
    ssl_certificate     /etc/letsencrypt/live/margin.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/margin.example.org/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    access_log off;
    location / {
        proxy_pass http://margin:8080;
    }
}
```

Caddy: `reverse_proxy margin:8080`. Traefik: service port `8080`.

- Start Margin before reloading the proxy: nginx resolves upstream names when it loads its
  configuration and fails with *host not found in upstream* otherwise.
- The proxy must pass Margin's response headers through unchanged (the CSP and other security headers
  come from the container). The examples do.
- Serve it over HTTPS (the service worker and several browser APIs require it), at the root of its own
  host name: sub-paths such as `/margin/` are not supported.
- Keep the proxy's access log off, or state in your privacy notice that it records IP addresses.

### 3. Update

```sh
git pull
docker compose up -d --build
```

Assets have content-hashed names and are cached for a year; `index.html` and `sw.js` are revalidated on
every load, so browsers switch to the new version on their next visit and the service worker discards the
old cache.

For reproducible images, pin the base images by digest when building:

```sh
docker compose build --build-arg NODE_IMAGE=node:22-alpine@sha256:<digest> \
  --build-arg NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine@sha256:<digest>
docker compose up -d
```

### 4. Verify

From any machine:

```sh
curl -sI https://margin.example.org/ | grep -iE 'content-security-policy|referrer-policy|x-content-type'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://margin.example.org/    # expect 405
```

The phase 6 gate, the privacy end-to-end test, from a development checkout of the same version:

```sh
pnpm exec playwright install chromium firefox     # once
E2E_BASE_URL=https://margin.example.org pnpm test:e2e --grep "full session"
```

It opens a paper, writes a comment with math, exports, pseudonymizes, reloads offline, and fails if any
request left the origin or if the CSP header differs from `packages/bridge/src/csp.ts`. (It uses the
fixture PDFs from the repository; nothing is stored on the server.)

---

## Hosted app with a local bridge

Visitors of a hosted copy can still grade the files of a local folder, with live agent sync:

1. On their own computer (with the repository installed, see the local setup):

   ```sh
   margin serve --dir ~/grading --allow-origin https://margin.example.org
   ```

2. Open `https://margin.example.org/?bridge=http://127.0.0.1:7311#token=<token>`, or open
   `https://margin.example.org` and paste the URL printed by `margin serve` into the "Local bridge" field
   on the start screen and press *Connect*.

The CSP allows the hosted page to connect to `http://127.0.0.1:*` and nowhere else. Browsers allow
loopback HTTP from an HTTPS page; recent Chromium versions ask the user once to allow "local network
access" for the site. Without `--allow-origin`, the bridge refuses the hosted page and the app says
which flag is missing.

Trust: the hosted page's code then reads your local folder through the bridge. Use this only with a
deployment you trust; otherwise use the local setup, which serves the app from your own checkout.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Port 7311 is in use; pass --port.` | Another `margin serve` is running, or another program uses the port. Stop it, or use `--port 7312` (a separate browser storage, see above). |
| The browser shows "Margin bridge is running, but the web app is not built." | Run `pnpm --filter @margin/web build`, then restart `margin serve`. |
| "The bridge refused the token." | `margin serve` was restarted (new token). Open the newly printed URL. |
| "Cannot reach the bridge at … start it with --allow-origin …" | The app is opened from another origin (hosted copy). Restart `margin serve` with the `--allow-origin` it names. |
| Start screen says "storage unavailable", or documents disappear | Private windows and some privacy settings disable or wipe site storage. Use a normal window, or keep files on disk via the bridge. |
| A hosted copy still shows the old version | Reload once more (the service worker installs the new version in the background), or check that `sw.js` and `index.html` are not cached by a proxy. |
| `latexmk was not found` | Install TeX Live / MacTeX, or compile the report yourself and pass the PDF to `--report`. |
| Changes to the annotation file made by an agent do not appear (without bridge) | Only the bridge (all browsers) and linked files (Chromium) pick up external changes. Otherwise drop the `.annot.json` onto the app again. |
| The container restarts endlessly, `docker compose ps` shows `Restarting (0)` and the logs are empty | The image has no nginx stage: the final `FROM ${NGINX_IMAGE}` block of the `Dockerfile` is missing or commented out, so the image ends with the Node build stage, whose default command (`node`) exits at once. Restore the block and run `docker compose up -d --build`. |
| The reverse proxy's `nginx -t` says *host not found in upstream* | The proxy cannot resolve `margin`: check that `docker compose ps` shows the container running, and that the proxy container is on the same network (`docker network inspect proxy`). Start Margin before reloading the proxy. |
| Docker build fails at `pnpm install --frozen-lockfile` | The lockfile does not match `package.json`. Run `pnpm install` locally and commit `pnpm-lock.yaml`. |
