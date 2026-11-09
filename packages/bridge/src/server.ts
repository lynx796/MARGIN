import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { MarginError, parseAnnotFile } from '@margin/core';
import { CSP_HEADER } from './csp.ts';

// The local bridge (spec §9.3): an HTTP server on 127.0.0.1 that gives the web app access to the PDFs
// and annotation files of one directory, tells it when they change, and serves the app itself.
//
// Hardening (spec §11): loopback only; every API request needs the session token; the Host header
// must be a loopback name (DNS rebinding); cross-origin requests are answered only for the
// configured app origins; only .pdf and .annot.json files inside the directory are reachable.

export interface BridgeOptions {
  /** Directory to serve; nothing outside it is ever read or written. */
  dir: string;
  /** Port to listen on; 0 picks a free one. Default 7311. */
  port?: number;
  /** Directory of the built web app; omitted or missing means the bridge serves only the API. */
  appDir?: string;
  /** Extra origins allowed to call the API from a browser (e.g. a hosted copy of the app). */
  allowOrigins?: string[];
  /** Session token; random if omitted. */
  token?: string;
}

export interface Bridge {
  /** `http://127.0.0.1:<port>/#token=…`: open this to use the app with the bridge connected. */
  url: string;
  origin: string;
  port: number;
  token: string;
  dir: string;
  close(): Promise<void>;
}

export interface BridgeFile {
  /** PDF path relative to the directory, with `/` separators. */
  path: string;
  size: number;
  modified: string;
  /** Whether `<name>.annot.json` exists next to it. */
  annotations: boolean;
}

/** Change notification sent over the event stream. `etag` is null when the file was removed. */
export interface BridgeEvent {
  kind: 'pdf' | 'annot';
  /** PDF path (for `annot` events, the PDF the annotation file belongs to). */
  path: string;
  etag: string | null;
}

export const DEFAULT_PORT = 7311;
const MAX_ANNOT_BYTES = 32 * 1024 * 1024;
const MAX_LISTED = 5000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'http',
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function etagOf(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `a/b/paper.pdf` → `a/b/paper.annot.json`. */
export function annotNameFor(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, '') + '.annot.json';
}

function pdfNameFor(annotPath: string): string {
  return annotPath.replace(/\.annot\.json$/i, '') + '.pdf';
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const root = (() => {
    try {
      return realpathSync(resolve(options.dir));
    } catch {
      throw new MarginError('io', `Cannot serve ${options.dir}: no such directory.`, { path: options.dir });
    }
  })();
  if (!statSync(root).isDirectory()) throw new MarginError('io', `${options.dir} is not a directory.`, { path: options.dir });
  const appDir = options.appDir && existsSync(join(options.appDir, 'index.html')) ? realpathSync(resolve(options.appDir)) : null;
  const token = options.token ?? randomBytes(24).toString('hex');
  const extraOrigins = new Set((options.allowOrigins ?? []).map((o) => o.replace(/\/+$/, '')));
  let port = 0;
  const ownOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const originAllowed = (o: string) => ownOrigins().has(o) || extraOrigins.has(o);

  // ── Paths ───────────────────────────────────────────────────────────────────────────────────

  /** Absolute path of a relative path under the directory, after rejecting anything outside it. */
  function inside(rel: string, suffixes: RegExp): string {
    if (!rel || rel.includes('\0') || rel.includes('\\')) throw new HttpError(400, 'Invalid path.', 'bad-path');
    const parts = rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) throw new HttpError(403, 'Path not allowed.', 'forbidden');
    if (!suffixes.test(rel)) throw new HttpError(403, 'Only PDF and annotation files are served.', 'forbidden');
    const abs = resolve(root, rel);
    if (!abs.startsWith(root + sep)) throw new HttpError(403, 'Path not allowed.', 'forbidden');
    // Symbolic links must not lead out of the directory either.
    const probe = existsSync(abs) ? abs : dirname(abs);
    let real: string;
    try {
      real = realpathSync(probe);
    } catch {
      throw new HttpError(404, 'Not found.', 'not-found');
    }
    if (real !== root && !real.startsWith(root + sep)) throw new HttpError(403, 'Path not allowed.', 'forbidden');
    return abs;
  }

  const pdfPath = (rel: string) => inside(rel, /\.pdf$/i);
  const annotPath = (rel: string) => inside(annotNameFor(rel), /\.annot\.json$/i);

  function list(): BridgeFile[] {
    const out: BridgeFile[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (out.length >= MAX_LISTED) return;
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const rel = prefix + e.name;
        if (e.isDirectory()) walk(join(dir, e.name), rel + '/');
        else if (e.isFile() && /\.pdf$/i.test(e.name)) {
          const st = statSync(join(dir, e.name));
          out.push({ path: rel, size: st.size, modified: st.mtime.toISOString(), annotations: existsSync(join(dir, annotNameFor(e.name))) });
        }
      }
    };
    walk(root, '');
    return out;
  }

  // ── Change stream ───────────────────────────────────────────────────────────────────────────

  const clients = new Set<ServerResponse>();
  const known = new Map<string, string | null>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function broadcast(ev: BridgeEvent): void {
    const msg = `event: change\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(msg);
  }

  /** Compare a file with what was last announced and announce it if its content changed. */
  function checkFile(rel: string): void {
    const abs = join(root, rel);
    let tag: string | null = null;
    try {
      if (statSync(abs).isFile()) tag = etagOf(readFileSync(abs));
    } catch {
      /* removed */
    }
    if (known.has(rel) && known.get(rel) === tag) return;
    known.set(rel, tag);
    const isAnnot = /\.annot\.json$/i.test(rel);
    broadcast({ kind: isAnnot ? 'annot' : 'pdf', path: isAnnot ? pdfNameFor(rel) : rel, etag: tag });
  }

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      const rel = filename?.toString().split(sep).join('/');
      if (!rel || rel.split('/').some((p) => p.startsWith('.')) || !/\.(pdf|annot\.json)$/i.test(rel)) return;
      clearTimeout(timers.get(rel));
      timers.set(
        rel,
        setTimeout(() => {
          timers.delete(rel);
          checkFile(rel);
        }, 40),
      );
    });
    watcher.on('error', () => undefined);
  } catch {
    /* No recursive watching on this platform: the app falls back to its own polling. */
  }

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': keep-alive\n\n');
  }, 15_000);
  heartbeat.unref();

  // ── Requests ────────────────────────────────────────────────────────────────────────────────

  function send(res: ServerResponse, status: number, body: string | Uint8Array, type: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  const sendJson = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', headers);

  async function readBody(req: IncomingMessage, limit: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new HttpError(413, 'Request body too large.', 'too-large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function authorize(req: IncomingMessage): void {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !sameToken(m[1]!, token)) throw new HttpError(401, 'Missing or wrong token. Open the URL printed by margin serve.', 'unauthorized');
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, cors: Record<string, string>): Promise<void> {
    authorize(req);
    const rel = url.searchParams.get('path') ?? '';
    const route = url.pathname;
    if (req.method === 'GET' && route === '/api/files') return sendJson(res, 200, { dir: basename(root), files: list() }, cors);
    if (req.method === 'GET' && route === '/api/pdf') {
      const abs = pdfPath(rel);
      if (!existsSync(abs)) throw new HttpError(404, `${rel} does not exist.`, 'not-found');
      const bytes = readFileSync(abs);
      return send(res, 200, bytes, 'application/pdf', { ...cors, ETag: `"${etagOf(bytes)}"` });
    }
    if (route === '/api/annot') {
      const abs = annotPath(rel);
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      const tag = current === null ? null : etagOf(current);
      if (req.method === 'GET') {
        if (!existsSync(pdfPath(rel))) throw new HttpError(404, `${rel} does not exist.`, 'not-found');
        // No annotation file yet is a normal state, not an error (browsers log 404s as errors).
        if (current === null) return send(res, 204, '', 'application/json', cors);
        known.set(annotNameFor(rel), tag);
        return send(res, 200, current, 'application/json; charset=utf-8', { ...cors, ETag: `"${tag}"` });
      }
      if (req.method === 'PUT') {
        if (!existsSync(pdfPath(rel))) throw new HttpError(404, `${rel} does not exist.`, 'not-found');
        const text = await readBody(req, MAX_ANNOT_BYTES);
        try {
          parseAnnotFile(text);
        } catch (e) {
          throw new HttpError(422, e instanceof Error ? e.message : 'Invalid annotation file.', e instanceof MarginError ? e.code : 'invalid');
        }
        // Optimistic concurrency: the caller names the version it based its write on, so a change
        // made on disk in the meantime is merged by the app instead of being overwritten.
        const ifMatch = /^"?([0-9a-f]{64})"?$/.exec(req.headers['if-match'] ?? '')?.[1];
        if (req.headers['if-match'] && req.headers['if-match'] !== '*' && ifMatch !== (tag ?? '')) {
          throw new HttpError(412, 'The annotation file changed on disk; fetch it, merge and retry.', 'precondition-failed', { etag: tag });
        }
        const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.tmp`);
        writeFileSync(tmp, text);
        renameSync(tmp, abs);
        const written = etagOf(text);
        known.set(annotNameFor(rel), written);
        broadcast({ kind: 'annot', path: rel, etag: written });
        return sendJson(res, 200, { etag: written }, { ...cors, ETag: `"${written}"` });
      }
    }
    if (req.method === 'GET' && route === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...cors });
      res.write('retry: 1000\nevent: hello\ndata: {}\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    throw new HttpError(404, 'Unknown endpoint.', 'not-found');
  }

  function serveApp(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.', 'method');
    const headers = { 'Content-Security-Policy': CSP_HEADER, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
    if (!appDir) {
      return send(res, 200, 'Margin bridge is running, but the web app is not built. Run: pnpm --filter @margin/web build\n', 'text/plain; charset=utf-8', headers);
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Bad request.', 'bad-path');
    }
    let abs = resolve(appDir, '.' + rel);
    if (abs !== appDir && !abs.startsWith(appDir + sep)) throw new HttpError(403, 'Path not allowed.', 'forbidden');
    if (!existsSync(abs) || statSync(abs).isDirectory()) abs = join(appDir, 'index.html');
    const bytes = readFileSync(abs);
    res.writeHead(200, { 'Content-Type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': bytes.length, ...headers });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      let cors: Record<string, string> = {};
      try {
        const url = new URL(req.url ?? '/', 'http://bridge');
        const host = req.headers.host ?? '';
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Unexpected Host header.', 'forbidden');
        const isApi = url.pathname.startsWith('/api/');
        const origin = req.headers.origin;
        if (origin) {
          if (isApi && !originAllowed(origin)) throw new HttpError(403, `Origin ${origin} is not allowed. Start margin serve with --allow-origin ${origin}.`, 'forbidden');
          if (originAllowed(origin)) cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'ETag', Vary: 'Origin' };
        }
        if (req.method === 'OPTIONS') {
          // CORS and Private Network Access preflight: answered only for allowed origins (rejected above).
          res.writeHead(204, {
            ...cors,
            'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type, if-match',
            'Access-Control-Expose-Headers': 'ETag',
            'Access-Control-Allow-Private-Network': 'true',
            'Access-Control-Max-Age': '600',
          });
          return void res.end();
        }
        if (isApi) return await api(req, res, url, cors);
        serveApp(req, res, url.pathname);
      } catch (e) {
        if (e instanceof HttpError) return sendJson(res, e.status, { ok: false, error: { code: e.code, message: e.message, ...e.extra } }, cors);
        sendJson(res, 500, { ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } }, cors);
      }
    })();
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      fail(new MarginError('io', e.code === 'EADDRINUSE' ? `Port ${options.port ?? DEFAULT_PORT} is in use; pass --port.` : `Cannot start the bridge: ${e.message}`)),
    );
    server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', () => ok());
  });
  port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/#token=${token}`,
    origin,
    port,
    token,
    dir: root,
    close: () =>
      new Promise<void>((ok) => {
        clearInterval(heartbeat);
        timers.forEach(clearTimeout);
        watcher?.close();
        for (const c of clients) c.end();
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}
