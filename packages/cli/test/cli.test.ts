import { copyFileSync, mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '../src/main.ts';

const FIXTURES = new URL('../../../fixtures/', import.meta.url).pathname;
let dir: string;
const cwd = process.cwd();

/** Run the CLI in-process in the temp dir, capturing stdout/stderr. */
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
  dir = mkdtempSync(join(tmpdir(), 'margin-cli-'));
  copyFileSync(join(FIXTURES, 'plain/plain.pdf'), join(dir, 'paper.pdf'));
  process.chdir(dir);
  process.env.MARGIN_NOW = '2026-11-08T12:00:00Z';
  process.env.MARGIN_SEED = '11';
});

afterAll(() => {
  process.chdir(cwd);
  delete process.env.MARGIN_NOW;
  delete process.env.MARGIN_SEED;
});

describe('margin CLI', () => {
  it('init creates the annotation file and refuses to overwrite it', async () => {
    expect((await margin('init', 'paper.pdf')).code).toBe(0);
    const file = JSON.parse(readFileSync('paper.annot.json', 'utf8'));
    expect(file.document).toMatchObject({ fileName: 'paper.pdf', pageCount: 2 });
    expect(file.categories.map((c: { id: string }) => c.id)).toEqual(['typo', 'error', 'remark', 'good', 'hl']);
    const again = await margin('init', 'paper.pdf');
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('error[exists]');
  });

  it('add anchors by quote, prints the ID, and lists candidates when ambiguous', async () => {
    const ok = await margin('add', '--category', 'typo', '--quote', 'fluffy notion', '--body', 'Vague.');
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toMatch(/^[0-9a-hjkmnp-tv-z]{6}$/);
    const amb = await margin('--json', 'add', '--category', 'error', '--quote', 'The map f', '--body', 'x');
    expect(amb.code).toBe(1);
    expect(amb.json().error.code).toBe('quote-ambiguous');
    expect(amb.json().error.details[0].candidates).toHaveLength(3);
    const missing = await margin('add', '--category', 'error', '--quote', 'not in the paper');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('quote-unresolved');
  });

  it('apply is atomic and edit/rm change comments', async () => {
    writeFileSync('ops.json', JSON.stringify([
      { op: 'add', category: 'error', quote: 'intermediate value theorem', body: 'Which one? \\(g\\) must be continuous.' },
      { op: 'add', category: 'remark', quote: 'Second page', body: 'Fine.', 'x-agent': { model: 'test' } },
    ]));
    const res = await margin('--json', 'apply', 'ops.json');
    expect(res.code).toBe(0);
    const [a, b] = res.json().results.map((r: { id: string }) => r.id);
    const before = readFileSync('paper.annot.json', 'utf8');
    writeFileSync('bad.json', JSON.stringify([{ op: 'rm', id: a }, { op: 'add', category: 'nope', quote: 'x' }]));
    expect((await margin('apply', 'bad.json')).code).toBe(1);
    expect(readFileSync('paper.annot.json', 'utf8')).toBe(before);
    expect((await margin('edit', b, '--body', 'Changed.', '--side', 'left')).code).toBe(0);
    const file = JSON.parse(readFileSync('paper.annot.json', 'utf8'));
    expect(file.annotations.find((x: { id: string }) => x.id === b)).toMatchObject({ body: 'Changed.', side: 'left', 'x-agent': { model: 'test' } });
    expect((await margin('rm', b)).code).toBe(0);
    expect((await margin('rm', b)).code).toBe(1);
  });

  it('list and read show comments with numbers in reading order', async () => {
    const list = (await margin('--json', 'list')).json().annotations;
    expect(list.map((r: { number: number }) => r.number)).toEqual([1, 2]);
    expect(list[0].quote).toBe('fluffy notion');
    const read = await margin('read', '--pages', '1');
    expect(read.stdout).toMatch(/^# Page 1/);
    expect(read.stdout).toMatch(/fluffy notion ⟦#1 typo [0-9a-z]{6}: Vague\.⟧/);
    expect(read.stdout).toMatch(/\n\s*\d+  diate value theorem ⟦#2 error/);
    expect((await margin('read', '--pages', '9')).code).toBe(2);
  });

  it('check reports dangling references and math errors', async () => {
    expect((await margin('check')).code).toBe(0);
    const id = (await margin('add', '--category', 'remark', '--quote', 'affine case', '--body', 'See \\ref{zzzzzz} and \\(x^{\\).')).stdout.trim();
    const res = await margin('--json', 'check');
    expect(res.code).toBe(1);
    expect(res.json().problems.map((p: { code: string }) => p.code).sort()).toEqual(['dangling-ref', 'math-error']);
    await margin('rm', id);
  });

  it('render writes PNGs and layout.json; export writes the flattened PDF', async () => {
    const r = await margin('render', '-o', 'out');
    expect(r.code).toBe(0);
    expect(readdirSync('out').sort()).toEqual(['layout.json', 'page-001.png']);
    const layout = JSON.parse(readFileSync('out/layout.json', 'utf8'));
    expect(layout.pages[0].prims.length).toBeGreaterThan(5);
    expect((await margin('export')).code).toBe(0);
    expect(existsSync('paper.annotated.pdf')).toBe(true);
    const first = readFileSync('paper.annotated.pdf');
    await margin('export', '-o', 'again.pdf');
    expect(readFileSync('again.pdf').equals(first)).toBe(true);
  });

  it('reports usage errors with exit code 2', async () => {
    expect((await margin('frobnicate')).code).toBe(2);
    expect((await margin('add', '--nope')).code).toBe(2);
    expect((await margin('--json', 'edit')).json()).toMatchObject({ ok: false, error: { code: 'usage' } });
  });

  it('schema prints the JSON Schema', async () => {
    expect(JSON.parse((await margin('schema')).stdout).title).toBe('Margin annotation file');
  });
});
