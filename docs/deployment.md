# Setup and deployment

Margin runs in two ways:

| Setup | What runs where | Use it when |
| --- | --- | --- |
| **Local** (recommended) | `margin serve` on your computer serves the app *and* your grading folder on `http://127.0.0.1:7311` | You grade on one machine, possibly with an AI agent |
| **Server** | A Docker image with nginx serves the app as static files at `https://margin.example.org`; documents stay in each visitor's browser | Several people should use Margin without installing anything |

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

The app also works without folder access: open it (from `margin serve`, a hosted copy, or any static
server set up as in [Without Docker](#4-without-docker)) and drop PDFs onto it instead of picking them
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

## Server deployment (Docker + nginx)

The image contains only the static web app and nginx. It has no data, no database, no API, and needs
no volume. Visitors' documents never reach it.

### 1. Build the image

```sh
docker build -t margin:latest \
  --build-arg SOURCE_URL=https://git.example.org/you/margin .
```

`SOURCE_URL` is shown on the start screen as "Source code". The AGPL-3.0 (section 13) requires that
users of a hosted copy can get its source; point it at the exact code you deploy.

For reproducible images, pin the base images by digest:

```sh
docker build -t margin:latest \
  --build-arg NODE_IMAGE=node:22-alpine@sha256:<digest> \
  --build-arg NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine@sha256:<digest> \
  --build-arg SOURCE_URL=… .
```

### 2. Run it

```sh
docker run -d --name margin --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  margin:latest
```

or with Compose:

```sh
docker compose -f deploy/compose.yaml up -d --build
```

The container runs nginx as an unprivileged user on port 8080 with a read-only file system. It is bound
to `127.0.0.1` so that only the reverse proxy on the same host reaches it. `http://localhost:8080` works
directly for a test (browsers treat `localhost` as secure, so the service worker works there).

### 3. Put TLS in front

Anything other than `localhost` must be served over HTTPS (the service worker and several browser APIs
require it). With [Caddy](https://caddyserver.com), which obtains certificates automatically:

```caddyfile
margin.example.org {
    reverse_proxy 127.0.0.1:8080
    header Strict-Transport-Security "max-age=31536000"
}
```

With an existing nginx on the host:

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
        proxy_pass http://127.0.0.1:8080;
    }
}
```

Both examples assume the proxy runs **on the host**, where the container is reachable at
`127.0.0.1:8080`. If your reverse proxy itself runs **in a container**, `127.0.0.1` is that container,
and a name like `margin` only resolves on a shared Docker network (otherwise `nginx -t` fails with
*host not found in upstream*). Then:

```sh
docker network create proxy            # once; attach your proxy container to it as well
```

uncomment the `networks:` lines in `deploy/compose.yaml`, run `docker compose -f deploy/compose.yaml
up -d --build`, and use `proxy_pass http://margin:8080;` in the proxy. Start Margin before reloading the
proxy: nginx resolves upstream names when it loads its configuration.

The proxy must pass the container's response headers through unchanged (both examples do). Keep the
proxy's own access log off, or state in your privacy notice that it records IP addresses.

Serve Margin at the root of its own host name. Hosting under a sub-path (`/margin/`) is not supported:
the build references `/assets/…` and `/sw.js` absolutely.

### 4. Without Docker

Any static web server works if it

1. serves `packages/web/dist/` at the root of a host name,
2. sends the headers of `deploy/security-headers.conf` on every response (at least the
   `Content-Security-Policy` header: the `<meta>` tag in `index.html` cannot express `frame-ancestors`),
3. serves `.wasm` as `application/wasm` and `.mjs` as `text/javascript`,
4. revalidates `index.html`, `sw.js` and `manifest.webmanifest` (`Cache-Control: no-cache`), and
5. falls back to `index.html` for unknown paths.

`deploy/nginx.conf` is a complete example.

### 5. Verify a deployment

Headers:

```sh
curl -sI https://margin.example.org/ | grep -iE 'content-security-policy|referrer-policy|x-content-type'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://margin.example.org/    # expect 405
```

The phase 6 gate: the privacy end-to-end test against the deployed site. From a checkout of the same
version:

```sh
pnpm exec playwright install chromium firefox     # once
E2E_BASE_URL=https://margin.example.org pnpm test:e2e --grep "full session"
```

It opens a paper, writes a comment with math, exports, pseudonymizes, reloads offline, and fails if any
request left the origin or if the CSP header differs from `packages/bridge/src/csp.ts`. (It uses the
fixture PDFs from the repository; nothing is stored on the server.)

### 6. Updating

Rebuild the image and replace the container. Assets have content-hashed names and are cached for a
year; `index.html` and `sw.js` are revalidated on every load, so browsers switch to the new version on
their next visit and the service worker discards the old cache.

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
| `docker compose up` prints *pull access denied for margin … may require 'docker login'* | Older copies of `deploy/compose.yaml` lacked `pull_policy: build`, so Compose first tried to pull `margin:latest` from Docker Hub, where it does not exist, and then built it locally. Harmless; update the compose file to silence it. |
| The container restarts endlessly, `docker compose ps` shows `Restarting (0)` and the logs are empty | The image has no nginx stage: the final `FROM ${NGINX_IMAGE}` block of the `Dockerfile` is missing or commented out, so the image ends with the Node build stage, whose default command (`node`) exits at once. Restore the block and rebuild with `--build`. Check with `docker image inspect margin:latest --format '{{.Config.Cmd}}'` (it must not be `[node]`). |
| The reverse proxy's `nginx -t` says *host not found in upstream* | The proxy cannot resolve the Margin container: see [Put TLS in front](#3-put-tls-in-front) for a proxy running in a container, and make sure Margin is running first. |
| Docker build fails at `pnpm install --frozen-lockfile` | The lockfile does not match `package.json`. Run `pnpm install` locally and commit `pnpm-lock.yaml`. |
