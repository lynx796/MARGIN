import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP_HEADER } from '../../bridge/src/csp.ts';
import { addIntegrity, serviceWorkerSource } from '../offline.ts';

const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);

describe('deployment (spec §11)', () => {
  it('nginx sends the same CSP as margin serve', () => {
    const conf = readFileSync(repo('deploy/security-headers.conf'), 'utf8');
    const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(conf)?.[1];
    expect(csp).toBe(CSP_HEADER);
  });

  it('the image ends with the nginx stage serving the build', () => {
    // Without it the image is the Node build stage, whose default command exits at once (restart loop).
    const stages = readFileSync(repo('Dockerfile'), 'utf8').split('\n').filter((l) => /^FROM\s/.test(l));
    expect(stages.at(-1)).toBe('FROM ${NGINX_IMAGE}');
    expect(readFileSync(repo('Dockerfile'), 'utf8')).toMatch(/^COPY --from=build \/src\/packages\/web\/dist \/usr\/share\/nginx\/html$/m);
  });

  it('nginx accepts no request that could carry data', () => {
    const conf = readFileSync(repo('deploy/nginx.conf'), 'utf8');
    expect(conf).toMatch(/if \(\$request_method !~ \^\(GET\|HEAD\)\$\) \{\s*return 405;/);
    expect(conf).not.toMatch(/proxy_pass|fastcgi_pass|uwsgi_pass|dav_methods/);
  });
});

describe('subresource integrity', () => {
  const files: Record<string, string> = { 'assets/a.js': 'console.log(1)', 'assets/b.js': 'export {}', 'assets/c.css': 'body{}' };
  const read = (p: string) => new TextEncoder().encode(files[p]!);
  const sri = (s: string) => 'sha384-' + createHash('sha384').update(s).digest('base64');

  it('adds integrity to the entry script, module preloads and stylesheets only', () => {
    const html = [
      '<script type="module" crossorigin src="/assets/a.js"></script>',
      '<link rel="modulepreload" crossorigin href="/assets/b.js">',
      '<link rel="stylesheet" crossorigin href="/assets/c.css">',
      '<link rel="icon" href="/icon.svg" type="image/svg+xml" />',
      '<link rel="manifest" href="/manifest.webmanifest" />',
    ].join('\n');
    const out = addIntegrity(html, read);
    expect(out).toContain(`src="/assets/a.js" integrity="${sri(files['assets/a.js']!)}"></script>`);
    expect(out).toContain(`href="/assets/b.js" integrity="${sri(files['assets/b.js']!)}">`);
    expect(out).toContain(`href="/assets/c.css" integrity="${sri(files['assets/c.css']!)}">`);
    expect(out).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml" />');
    expect(out).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it('the service worker leaves the bridge API and other origins alone', () => {
    const sw = serviceWorkerSource('margin-x', ['index.html']);
    expect(sw).toContain("url.origin !== self.location.origin || url.pathname.startsWith('/api/')");
    expect(sw).toContain('"./index.html"');
  });
});
