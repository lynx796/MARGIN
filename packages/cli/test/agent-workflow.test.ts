import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '../src/main.ts';

// Phase 3 gate (spec §13): an agent that has only read `margin agent-guide` adds 10 quote-anchored
// comments with zero unresolved anchors. The "agent" here does what the guide says: read the text,
// quote 3–15 words verbatim with --page, apply them as one batch, then check.

const FIXTURES = new URL('../../../fixtures/', import.meta.url).pathname;
let dir: string;
const cwd = process.cwd();

async function margin(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string; json: () => any }> {
  let stdout = '';
  let stderr = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  try {
    const code = await run(argv);
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'margin-agent-'));
  copyFileSync(join(FIXTURES, 'twocolumn/twocolumn.pdf'), join(dir, 'paper.pdf'));
  process.chdir(dir);
});

afterAll(() => process.chdir(cwd));

describe('margin agent-guide', () => {
  it('prints a guide short enough to paste into any agent context, covering every command it uses', async () => {
    const r = await margin('agent-guide');
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n').length).toBeLessThan(120);
    for (const word of ['margin read', 'margin add', 'margin apply', 'margin check', 'margin render', '--page', 'origin: agent', 'quote-unresolved']) {
      expect(r.stdout, word).toContain(word);
    }
    expect((await margin('agent-guide', '--json')).json().guide).toBe(r.stdout);
  });
});

describe('gate: an agent adds 10 quote-anchored comments with zero unresolved anchors', () => {
  it('follows the guide: init, read, quote verbatim, apply, check', async () => {
    expect((await margin('init', 'paper.pdf')).code).toBe(0);

    // 1. Read what the agent would read.
    const read = (await margin('read', 'paper.pdf', '--json')).json() as { pages: { page: number; lines: string[] }[] };
    expect(read.pages.length).toBeGreaterThan(0);

    // 2. Choose ten phrases of 5 words from the text, verbatim; a few start mid-line, one spans
    //    a line break, one carries a typo (the guide promises tolerance for those).
    const quotes: { page: number; quote: string }[] = [];
    for (const p of read.pages) {
      const lines = p.lines.filter((l) => l.trim().split(/\s+/).length >= 8);
      for (let i = 0; i < lines.length && quotes.length < 10; i += 2) {
        const words = lines[i]!.trim().split(/\s+/);
        quotes.push({ page: p.page, quote: words.slice(1, 6).join(' ') });
      }
    }
    const next = read.pages[0]!.lines.filter((l) => l.trim().split(/\s+/).length >= 8);
    const across = `${next[1]!.trim().split(/\s+/).slice(-3).join(' ')} ${next[2]!.trim().split(/\s+/).slice(0, 3).join(' ')}`;
    quotes.splice(8, 2, { page: 1, quote: across }, { page: 1, quote: quotes[0]!.quote.replace(/^(\S+ )(\S)(\S+)/, '$1$3') });
    expect(quotes).toHaveLength(10);

    const categories = ['typo', 'error', 'remark', 'good', 'error'];
    const ops = quotes.map((q, i) => ({ op: 'add', page: q.page, quote: q.quote, category: categories[i % 5], body: `Comment ${i + 1} on \\(x_${i}\\).` }));
    writeFileSync('ops.json', JSON.stringify(ops, null, 2));

    // 3. Apply as one batch.
    const applied = await margin('apply', 'ops.json', 'paper.pdf', '--json');
    expect(applied.stderr).toBe('');
    expect(applied.code, applied.stdout).toBe(0);
    expect(applied.json().results).toHaveLength(10);

    // 4. Verify.
    const check = await margin('check', 'paper.pdf');
    expect(check.code, check.stdout + check.stderr).toBe(0);
    const file = JSON.parse(readFileSync('paper.annot.json', 'utf8'));
    expect(file.annotations).toHaveLength(10);
    for (const a of file.annotations) {
      expect(a.status, a.id).toBe('ok');
      expect(a.origin).toBe('agent');
      expect(a.anchor.quads.length).toBeGreaterThan(0);
    }
    // The typo'd quote was matched fuzzily and now stores the paper's own words: two comments share them.
    expect(file.annotations.filter((a: any) => a.anchor.quote.exact === quotes[0]!.quote)).toHaveLength(2);
    const resolve = await margin('resolve', 'paper.pdf');
    expect(resolve.code).toBe(0);

    // 5. The human's view: nothing is reviewed yet.
    const unreviewed = (await margin('list', 'paper.pdf', '--unreviewed', '--json')).json().annotations;
    expect(unreviewed).toHaveLength(10);
    const id = unreviewed[0].id as string;
    expect((await margin('edit', id, 'paper.pdf', '--reviewed')).code).toBe(0);
    expect((await margin('list', 'paper.pdf', '--unreviewed', '--json')).json().annotations).toHaveLength(9);
  });

  it('reports an unresolvable quote with exit code 1 and writes nothing', async () => {
    const before = readFileSync('paper.annot.json', 'utf8');
    const r = await margin('add', 'paper.pdf', '--page', '1', '--quote', 'words that the paper never says', '--category', 'error', '--body', 'x');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('quote-unresolved');
    expect(readFileSync('paper.annot.json', 'utf8')).toBe(before);
  });
});
