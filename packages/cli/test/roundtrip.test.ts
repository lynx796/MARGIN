import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PdfDoc } from '@margin/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '../src/main.ts';

// Phase 4 gate (spec §13): export → re-import round trip, grading report, embedded original.

const FIXTURES = new URL('../../../fixtures/', import.meta.url).pathname;
let dir: string;
const cwd = process.cwd();

async function margin(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
  try {
    return { code: await run(argv), stdout, stderr };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

const pageCount = async (path: string) => {
  const doc = await PdfDoc.open(new Uint8Array(readFileSync(path)));
  const n = doc.pageCount;
  await doc.destroy();
  return n;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'margin-rt-'));
  copyFileSync(join(FIXTURES, 'plain/plain.pdf'), join(dir, 'paper.pdf'));
  copyFileSync(join(FIXTURES, 'mixed/mixed.pdf'), join(dir, 'report.pdf'));
  process.chdir(dir);
  process.env.MARGIN_NOW = '2026-11-08T12:00:00Z';
  process.env.MARGIN_SEED = '5';
  await margin('init', 'paper.pdf');
  await margin('add', '--category', 'error', '--quote', 'fluffy notion', '--body', 'Vague.');
  await margin('add', '--category', 'remark', '--quote', 'Second page', '--body', 'See also \\(x^2\\).');
});

afterAll(() => {
  process.chdir(cwd);
  delete process.env.MARGIN_NOW;
  delete process.env.MARGIN_SEED;
});

describe('export round trip', () => {
  it('exports exactly the annotated pages when no report is attached', async () => {
    expect((await margin('export', 'paper.pdf')).code).toBe(0);
    expect(await pageCount('paper.annotated.pdf')).toBe(2);
    expect(JSON.parse(readFileSync('paper.annot.json', 'utf8')).report).toBeUndefined();
  });

  it('import recovers the annotation file byte for byte, given the original', async () => {
    mkdirSync('restored');
    copyFileSync('paper.pdf', 'restored/paper.pdf');
    const r = await margin('import', 'paper.annotated.pdf', 'restored/paper.pdf');
    expect(r.code).toBe(0);
    expect(readFileSync('restored/paper.annot.json', 'utf8')).toBe(readFileSync('paper.annot.json', 'utf8'));
  });

  it('import asks for the original, and rejects a wrong one', async () => {
    mkdirSync('empty');
    const needs = await margin('import', 'paper.annotated.pdf', '--annot', 'empty/x.annot.json');
    expect(needs.code).toBe(2);
    expect(needs.stderr).toContain('original-needed');
    const wrong = await margin('import', 'paper.annotated.pdf', 'report.pdf', '--annot', 'empty/x.annot.json');
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('original-mismatch');
    expect(existsSync('empty/x.annot.json')).toBe(false);
  });

  it('import rejects PDFs that Margin did not export', async () => {
    const r = await margin('import', 'paper.pdf');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not-exported');
  });

  it('an embedded original makes the export self-contained', async () => {
    const file = JSON.parse(readFileSync('paper.annot.json', 'utf8'));
    file.settings.embedOriginal = true;
    mkdirSync('solo/in', { recursive: true });
    writeFileSync('solo/in/paper.annot.json', JSON.stringify(file));
    copyFileSync('paper.pdf', 'solo/in/paper.pdf');
    expect((await margin('export', 'solo/in/paper.pdf', '-o', 'solo/self.pdf')).code).toBe(0);
    const r = await margin('import', 'solo/self.pdf');
    // The paper is written next to the export under its recorded name, with its annotation file.
    expect(r.code).toBe(0);
    expect(readFileSync('solo/paper.pdf').equals(readFileSync('paper.pdf'))).toBe(true);
    expect(JSON.parse(readFileSync('solo/paper.annot.json', 'utf8')).document.sha256).toBe(file.document.sha256);
  });
});

describe('grading report', () => {
  it('--report places the pages in front and is remembered', async () => {
    const reportPages = await pageCount('report.pdf');
    const r = await margin('export', 'paper.pdf', '--report', 'report.pdf', '-o', 'with-report.pdf');
    expect(r.code).toBe(0);
    expect(await pageCount('with-report.pdf')).toBe(2 + reportPages);
    expect(JSON.parse(readFileSync('paper.annot.json', 'utf8')).report).toMatchObject({ fileName: 'report.pdf', position: 'before' });
    // Later exports use the recorded report, with identical output.
    await margin('export', 'paper.pdf', '-o', 'again.pdf');
    expect(readFileSync('again.pdf').equals(readFileSync('with-report.pdf'))).toBe(true);
  });

  it('--position after puts it behind the annotated pages', async () => {
    const r = await margin('export', 'paper.pdf', '--position', 'after', '-o', 'after.pdf');
    expect(r.code).toBe(0);
    expect(readFileSync('after.pdf').equals(readFileSync('with-report.pdf'))).toBe(false);
    expect(await pageCount('after.pdf')).toBe(await pageCount('with-report.pdf'));
  });

  it('warns when the report changed after it was attached, and fails when it is gone', async () => {
    const original = readFileSync('report.pdf');
    copyFileSync(join(FIXTURES, 'tight/tight.pdf'), 'report.pdf');
    const changed = await margin('export', 'paper.pdf', '-o', 'changed.pdf');
    expect(changed.code).toBe(0);
    expect(changed.stderr).toContain('report-changed');
    expect((await margin('check', 'paper.pdf')).stdout).toContain('report-changed');
    writeFileSync('report.pdf', original);
    const gone = JSON.parse(readFileSync('paper.annot.json', 'utf8'));
    gone.report.fileName = 'nowhere.pdf';
    writeFileSync('gone.annot.json', JSON.stringify(gone));
    const r = await margin('export', 'paper.pdf', '--annot', 'gone.annot.json', '-o', 'gone.pdf');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('report-missing');
  });

  it('a .tex report fails clearly without latexmk', async () => {
    writeFileSync('r.tex', '\\documentclass{article}\\begin{document}x\\end{document}');
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const r = await margin('export', 'paper.pdf', '--report', 'r.tex', '-o', 'x.pdf');
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('no-latex');
    } finally {
      process.env.PATH = saved;
    }
  });
});
