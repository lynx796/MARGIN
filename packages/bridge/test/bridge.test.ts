import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBridge, type Bridge, type BridgeEvent } from '../src/index.ts';

const FIX = new URL('../../../fixtures/plain/', import.meta.url).pathname;
let dir: string;
let outside: string;
let appDir: string;
let bridge: Bridge;

const auth = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${bridge.token}`, ...extra });
const api = (path: string, init: RequestInit = {}) => fetch(`${bridge.origin}${path}`, { ...init, headers: { ...auth(), ...(init.headers as Record<string, string>) } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'margin-bridge-'));
  outside = mkdtempSync(join(tmpdir(), 'margin-outside-'));
  appDir = mkdtempSync(join(tmpdir(), 'margin-app-'));
  writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title>');
  mkdirSync(join(dir, 'sub'));
  copyFileSync(join(FIX, 'plain.pdf'), join(dir, 'plain.pdf'));
  copyFileSync(join(FIX, 'plain.annot.json'), join(dir, 'plain.annot.json'));
  copyFileSync(join(FIX, 'plain.pdf'), join(dir, 'sub', 'second.pdf'));
  writeFileSync(join(outside, 'secret.pdf'), 'secret');
  writeFileSync(join(outside, 'secret.annot.json'), '{}');
  symlinkSync(outside, join(dir, 'escape'));
  bridge = await startBridge({ dir, port: 0, appDir, allowOrigins: ['https://margin.example.org'] });
});

afterAll(async () => {
  await bridge.close();
  for (const d of [dir, outside, appDir]) rmSync(d, { recursive: true, force: true });
});

describe('access control', () => {
  it('prints a loopback URL with the token in the fragment', () => {
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{48}$/);
  });

  it('rejects API requests without or with a wrong token', async () => {
    expect((await fetch(`${bridge.origin}/api/files`)).status).toBe(401);
    expect((await fetch(`${bridge.origin}/api/files`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await api('/api/files')).status).toBe(200);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((ok) => {
      const r = request({ host: '127.0.0.1', port: bridge.port, path: '/api/files', headers: { ...auth(), Host: 'evil.example' } }, (m) => ok(m.statusCode ?? 0));
      r.end();
    });
    expect(status).toBe(403);
  });

  it('answers CORS only for the own and configured origins', async () => {
    const own = await api('/api/files', { headers: { Origin: bridge.origin } });
    expect(own.headers.get('access-control-allow-origin')).toBe(bridge.origin);
    const hosted = await api('/api/files', { headers: { Origin: 'https://margin.example.org' } });
    expect(hosted.status).toBe(200);
    expect(hosted.headers.get('access-control-allow-origin')).toBe('https://margin.example.org');
    const evil = await api('/api/files', { headers: { Origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers the preflight with Private Network Access only for allowed origins', async () => {
    const ok = await fetch(`${bridge.origin}/api/annot`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://margin.example.org', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Private-Network': 'true' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-private-network')).toBe('true');
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
    const bad = await fetch(`${bridge.origin}/api/annot`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('file access', () => {
  it('lists PDFs recursively with their annotation state', async () => {
    const body = (await (await api('/api/files')).json()) as { files: { path: string; annotations: boolean }[] };
    expect(body.files.map((f) => [f.path, f.annotations])).toEqual([['plain.pdf', true], ['sub/second.pdf', false]]);
  });

  it('serves the PDF bytes', async () => {
    const res = await api('/api/pdf?path=plain.pdf');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe('%PDF-');
  });

  it.each([
    ['../../etc/passwd'],
    ['..%2F..%2Fetc%2Fpasswd.pdf'],
    ['/etc/passwd.pdf'],
    ['sub/../../x.pdf'],
    ['escape/secret.pdf'],
    ['.hidden.pdf'],
    ['plain.pdf%00.txt'],
    ['package.json'],
  ])('refuses %s', async (path) => {
    const res = await api(`/api/pdf?path=${path}`);
    expect([400, 403, 404]).toContain(res.status);
    const a = await api(`/api/annot?path=${path}`);
    expect([400, 403, 404]).toContain(a.status);
  });

  it('refuses to follow a symbolic link out of the directory for annotation files', async () => {
    const res = await api('/api/annot?path=escape/secret.pdf');
    expect(res.status).toBe(403);
    const put = await api('/api/annot?path=escape/secret.pdf', { method: 'PUT', body: '{}' });
    expect(put.status).toBe(403);
  });

  it('rejects invalid annotation files and leaves the old one in place', async () => {
    const before = await (await api('/api/annot?path=plain.pdf')).text();
    const res = await api('/api/annot?path=plain.pdf', { method: 'PUT', body: '{"nonsense": true}' });
    expect(res.status).toBe(422);
    expect(await (await api('/api/annot?path=plain.pdf')).text()).toBe(before);
  });

  it('writes with If-Match: a stale version gets 412 and the current ETag', async () => {
    const got = await api('/api/annot?path=plain.pdf');
    const text = await got.text();
    const e0 = got.headers.get('etag')!;
    // Another process changes the file after we read it.
    writeFileSync(join(dir, 'plain.annot.json'), text + '\n');
    const stale = await api('/api/annot?path=plain.pdf', { method: 'PUT', body: text, headers: { 'If-Match': e0 } });
    expect(stale.status).toBe(412);
    const e1 = ((await stale.json()) as { error: { etag: string } }).error.etag;
    expect(e1).toMatch(/^[0-9a-f]{64}$/);
    expect(`"${e1}"`).not.toBe(e0);
    const retry = await api('/api/annot?path=plain.pdf', { method: 'PUT', body: text, headers: { 'If-Match': `"${e1}"` } });
    expect(retry.status).toBe(200);
    expect(await (await api('/api/annot?path=plain.pdf')).text()).toBe(text);
  });

  it('creates an annotation file for a PDF that has none', async () => {
    const text = await (await api('/api/annot?path=plain.pdf')).text();
    expect((await api('/api/annot?path=sub/second.pdf')).status).toBe(204);
    expect((await api('/api/annot?path=missing.pdf')).status).toBe(404);
    expect((await api('/api/annot?path=sub/second.pdf', { method: 'PUT', body: text })).status).toBe(200);
    expect((await api('/api/annot?path=sub/second.pdf')).status).toBe(200);
  });
});

describe('static app', () => {
  it('serves the app with the CSP header and falls back to index.html', async () => {
    for (const path of ['/', '/some/route']) {
      const res = await fetch(`${bridge.origin}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>app</title>');
      const csp = res.headers.get('content-security-policy')!;
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain('connect-src');
      expect(csp).toContain("frame-ancestors 'none'");
    }
  });

  it('does not serve files outside the app directory', async () => {
    const res = await fetch(`${bridge.origin}/..%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('root:');
  });
});

describe('change stream', () => {
  async function events(): Promise<{ next(match: (e: BridgeEvent) => boolean, ms?: number): Promise<BridgeEvent>; stop(): void }> {
    const ctl = new AbortController();
    const res = await api('/api/events', { signal: ctl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const seen: BridgeEvent[] = [];
    let wake: (() => void) | undefined;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += decoder.decode(value);
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.includes('event: change')) seen.push(JSON.parse(block.split('data: ')[1]!) as BridgeEvent);
            wake?.();
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return {
      async next(match, ms = 3000) {
        const deadline = Date.now() + ms;
        for (;;) {
          const hit = seen.find(match);
          if (hit) return hit;
          if (Date.now() > deadline) throw new Error(`no matching event; saw ${JSON.stringify(seen)}`);
          await new Promise<void>((ok) => {
            wake = ok;
            setTimeout(ok, 50);
          });
        }
      },
      stop: () => ctl.abort(),
    };
  }

  it('announces external changes to annotation files within a second', async () => {
    const ev = await events();
    const text = await (await api('/api/annot?path=plain.pdf')).text();
    const changed = text.replace(/\n$/, '') + '\n\n';
    const t0 = Date.now();
    writeFileSync(join(dir, 'plain.annot.json'), changed);
    const got = await ev.next((e) => e.kind === 'annot' && e.path === 'plain.pdf');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(got.etag).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(dir, 'plain.annot.json'), text);
    ev.stop();
  });

  it('announces writes made through the API and ignores temporary files', async () => {
    const ev = await events();
    writeFileSync(join(dir, '.plain.annot.json.123.tmp'), 'x');
    const text = await (await api('/api/annot?path=plain.pdf')).text();
    const res = await api('/api/annot?path=plain.pdf', { method: 'PUT', body: text.replace(/\n$/, '') + '\n\n\n' });
    const { etag } = (await res.json()) as { etag: string };
    const got = await ev.next((e) => e.kind === 'annot' && e.etag === etag);
    expect(got.path).toBe('plain.pdf');
    await api('/api/annot?path=plain.pdf', { method: 'PUT', body: text });
    ev.stop();
  });
});
