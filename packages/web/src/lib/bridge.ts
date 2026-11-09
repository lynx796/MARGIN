// Client of the local bridge (spec §9.3, served by `margin serve`): list and read PDFs, read and write
// annotation files, and follow changes made by other programs. Every request carries the session token.

import { sha256Hex } from '@margin/core';

export interface BridgeFile {
  path: string;
  size: number;
  modified: string;
  annotations: boolean;
}

/** Change notification; `etag` is the SHA-256 of the file's content, null if it was removed. */
export interface BridgeEvent {
  kind: 'pdf' | 'annot';
  path: string;
  etag: string | null;
}

export interface BridgeConnection {
  origin: string;
  token: string;
}

export type PutResult = { ok: true; etag: string } | { ok: false; conflict: true; etag: string | null };

const STORAGE_KEY = 'margin.bridge';

/**
 * Where to find a bridge: the URL printed by `margin serve` (`…/#token=…`) when this page was opened
 * from it; `?bridge=<origin>` selects another origin (a hosted app talking to a local bridge); else
 * the connection remembered for this tab. The token is removed from the address bar after reading.
 */
export function connectionFromLocation(): BridgeConnection | null {
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
  if (token) {
    const origin = new URLSearchParams(location.search).get('bridge') ?? location.origin;
    const conn = { origin: origin.replace(/\/+$/, ''), token };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
    } catch {
      /* storage may be unavailable */
    }
    history.replaceState(null, '', location.pathname + location.search);
    return conn;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as BridgeConnection | null;
    if (saved?.origin && saved.token) return saved;
  } catch {
    /* ignore */
  }
  return null;
}

/** Parse what a user pastes: the full URL with `#token=…`, or `origin token`. */
export function parseConnection(text: string): BridgeConnection | null {
  const t = text.trim();
  try {
    const url = new URL(t);
    const token = new URLSearchParams(url.hash.replace(/^#/, '')).get('token') ?? url.searchParams.get('token');
    if (token) return { origin: url.origin, token };
  } catch {
    /* not a URL */
  }
  const m = /^(https?:\/\/\S+)\s+([0-9a-f]{16,})$/i.exec(t);
  return m ? { origin: m[1]!.replace(/\/+$/, ''), token: m[2]! } : null;
}

export function forgetConnection(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'bridge',
  ) {
    super(message);
  }
}

export class BridgeClient {
  readonly origin: string;
  private token: string;

  constructor(conn: BridgeConnection) {
    this.origin = conn.origin;
    this.token = conn.token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.origin + path, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...(init.headers as Record<string, string>) } });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      // A browser reports a refused origin (no CORS headers) the same way as a bridge that is not running.
      const hint = this.origin === location.origin ? '' : ` If it is running, start it with --allow-origin ${location.origin}.`;
      throw new BridgeError(0, `Cannot reach the bridge at ${this.origin}. Is margin serve running?${hint}`, 'unreachable');
    }
    return res;
  }

  private async fail(res: Response): Promise<never> {
    let message = `${res.status} ${res.statusText}`;
    let code = 'bridge';
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      /* not JSON */
    }
    throw new BridgeError(res.status, message, code);
  }

  async files(): Promise<{ dir: string; files: BridgeFile[] }> {
    const res = await this.request('/api/files');
    if (!res.ok) return this.fail(res);
    return res.json();
  }

  async pdf(path: string): Promise<Uint8Array> {
    const res = await this.request(`/api/pdf?path=${encodeURIComponent(path)}`);
    if (!res.ok) return this.fail(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** The annotation file of a PDF, or null if there is none yet (the bridge answers 204). */
  async annot(path: string): Promise<{ text: string; etag: string } | null> {
    const res = await this.request(`/api/annot?path=${encodeURIComponent(path)}`);
    if (res.status === 204) return null;
    if (!res.ok) return this.fail(res);
    // The ETag is the SHA-256 of the text; computed here because a cross-origin page may not read the header.
    const text = await res.text();
    return { text, etag: await sha256Hex(new TextEncoder().encode(text)) };
  }

  /** Write the annotation file; with `ifMatch` only if the disk still has that version. */
  async putAnnot(path: string, text: string, ifMatch: string | null): Promise<PutResult> {
    const res = await this.request(`/api/annot?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: text,
      headers: { 'Content-Type': 'application/json', ...(ifMatch ? { 'If-Match': `"${ifMatch}"` } : {}) },
    });
    if (res.status === 412) return { ok: false, conflict: true, etag: ((await res.json()) as { error: { etag: string | null } }).error.etag };
    if (!res.ok) return this.fail(res);
    return { ok: true, etag: ((await res.json()) as { etag: string }).etag };
  }

  /**
   * Follow the change stream until the returned function is called. Reconnects after failures;
   * `onStatus(true)` fires after every (re)connect so the caller can catch up on missed changes.
   */
  follow(onEvent: (e: BridgeEvent) => void, onStatus: (connected: boolean) => void): () => void {
    const ctl = new AbortController();
    void (async () => {
      while (!ctl.signal.aborted) {
        try {
          const res = await this.request('/api/events', { signal: ctl.signal });
          if (!res.ok || !res.body) throw new BridgeError(res.status, 'event stream refused');
          onStatus(true);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (block.includes('event: change') && data) {
                try {
                  onEvent(JSON.parse(data) as BridgeEvent);
                } catch {
                  /* malformed event: ignore */
                }
              }
            }
          }
        } catch (e) {
          if (ctl.signal.aborted) return;
          if (e instanceof BridgeError && (e.status === 401 || e.status === 403)) {
            onStatus(false);
            return;
          }
        }
        if (ctl.signal.aborted) return;
        onStatus(false);
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    return () => ctl.abort();
  }
}
