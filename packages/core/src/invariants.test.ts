import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Core must run unchanged in browsers and Node (AGENTS.md): no Node built-ins, no DOM globals.
// Test files and test helpers (src/test/) are exempt: they run only under Vitest in Node.

const SRC = new URL('.', import.meta.url).pathname;
const FORBIDDEN = [
  /from ['"]node:/,
  /from ['"](fs|path|os|url|crypto|child_process|buffer|stream|zlib)['"]/,
  /\bimport\(['"]node:/,
  /(?<![\w./'"-])(document|window|navigator|localStorage)\.(?!ts\b)/,
  /\brequire\(/,
  /\bprocess\./,
  /\bBuffer\./,
  /\bDate\.now\(\)/,
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'test' ? [] : sources(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

describe('core invariants', () => {
  it.each(sources(SRC).map((p) => [p.slice(SRC.length), p]))('%s has no Node or DOM dependencies', (_name, path) => {
    const text = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const pattern of FORBIDDEN) expect(text, `matches ${pattern}`).not.toMatch(pattern);
  });
});
