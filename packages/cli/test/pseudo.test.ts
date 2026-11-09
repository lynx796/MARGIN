import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { matchRanges, normalizeQuote, parseTerms, PdfDoc, type AnnotFile, type TermGroup } from '@margin/core';
import { run } from '../src/main.ts';

// Phase 5 gate (spec §12.2, §12.3): for every fixture with terms, the pseudonymized PDF contains no
// term in its text, metadata, outlines or raw bytes (zlib-inflated streams searched), the page
// geometry is unchanged, and restore reproduces the original anchors exactly.
// The leak scan here is independent of core's own verification: it parses the file by hand.

const FIXTURES = new URL('../../../fixtures/', import.meta.url).pathname;
const fixtures = readdirSync(FIXTURES).filter((n) => existsSync(join(FIXTURES, n, 'terms.txt')));

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

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** Every byte sequence in the file a term could hide in: the raw file, inflated streams, decoded strings. */
function haystacks(pdf: Uint8Array): { where: string; text: string; font: boolean }[] {
  const raw = latin1(pdf);
  const out: { where: string; text: string; font: boolean }[] = [{ where: 'raw file', text: raw, font: false }];
  const re = /<<((?:(?!>>\s*stream)[\s\S])*)>>\s*stream\r?\n/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    const dict = m[1]!;
    // Font programs carry their designers' notices (e-mail addresses), never document text.
    const font = /\/Length1|\/Subtype\s*\/(?:Type1C|CIDFontType0C|OpenType)/.test(dict);
    try {
      out.push({ where: `stream at ${m.index}`, text: latin1(inflateSync(pdf.subarray(start, end))), font });
    } catch {
      /* not deflated */
    }
  }
  // Strings inside any of them: hex (often UTF-16) and literal strings with octal escapes.
  for (const h of [...out]) {
    for (const s of h.text.matchAll(/<([0-9A-Fa-f\s]{4,})>/g)) {
      const bytes = Buffer.from(s[1]!.replace(/\s/g, ''), 'hex');
      const text = bytes[0] === 0xfe && bytes[1] === 0xff ? bytes.subarray(2).swap16().toString('utf16le') : bytes.toString('latin1');
      out.push({ where: `${h.where}, hex string`, text, font: h.font });
    }
    out.push({ where: `${h.where}, unescaped`, text: h.text.replace(/\\([0-7]{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))), font: h.font });
  }
  return out;
}

function leaks(pdf: Uint8Array, groups: TermGroup[]): string[] {
  const found: string[] = [];
  for (const h of haystacks(pdf)) {
    const lower = h.text.toLowerCase();
    for (const g of groups) {
      for (const v of g.variants) {
        if (v.startsWith('/')) {
          if (h.font) continue;
          const m = h.text.match(new RegExp(v.slice(1, v.lastIndexOf('/')), 'iu'));
          if (m) found.push(`${h.where}: ${g.token} ${JSON.stringify(m[0])}`);
          continue;
        }
        const forms = new Set([v.toLowerCase(), normalizeQuote(v).toLowerCase(), Buffer.from(v.toLowerCase(), 'utf8').toString('latin1')]);
        for (const f of forms) {
          const at = lower.search(new RegExp(`(?<![a-z0-9\\u00c0-\\u024f])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9\\u00c0-\\u024f])`));
          if (at >= 0) found.push(`${h.where}: ${g.token} ${JSON.stringify(h.text.slice(at, at + f.length))}`);
        }
      }
    }
  }
  return found;
}

const cwd = process.cwd();
beforeAll(() => {
  process.env.MARGIN_NOW = '2026-11-08T12:00:00Z';
  process.env.MARGIN_SEED = '7';
});
afterAll(() => {
  process.chdir(cwd);
  delete process.env.MARGIN_NOW;
  delete process.env.MARGIN_SEED;
});

describe.each(fixtures)('pseudonymize fixture %s', (name) => {
  let dir: string;
  let groups: TermGroup[];
  let original: Uint8Array;
  let redacted: Uint8Array;
  const hasAnnot = existsSync(join(FIXTURES, name, `${name}.annot.json`));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), `margin-pseudo-${name}-`));
    for (const f of [`${name}.pdf`, 'terms.txt', ...(hasAnnot ? [`${name}.annot.json`] : [])]) copyFileSync(join(FIXTURES, name, f), join(dir, f));
    groups = parseTerms(readFileSync(join(dir, 'terms.txt'), 'utf8'));
    original = new Uint8Array(readFileSync(join(dir, `${name}.pdf`)));
    const r = await margin('pseudonymize', join(dir, `${name}.pdf`), '--terms', join(dir, 'terms.txt'));
    expect(r.code, r.stderr).toBe(0);
    redacted = new Uint8Array(readFileSync(join(dir, `${name}.pseudo.pdf`)));
  });

  it('leaves no term in text, metadata, outlines or raw bytes (leak test)', async () => {
    expect(leaks(redacted, groups)).toEqual([]);
    const doc = await PdfDoc.open(redacted);
    for (const page of await doc.allText()) expect(matchRanges(page.text, groups).map((r) => page.text.slice(r.start, r.end)), `page ${page.page}`).toEqual([]);
    await doc.destroy();
    // The original does contain them: the scan would see a leak.
    expect(leaks(original, groups).length).toBeGreaterThan(0);
  });

  it('keeps the page geometry and every line without a term', async () => {
    const a = await PdfDoc.open(original);
    const b = await PdfDoc.open(redacted);
    expect(b.pages).toEqual(a.pages);
    for (let p = 1; p <= a.pageCount; p++) {
      const ta = await a.text(p);
      const tb = await b.text(p);
      const lines = ta.lines.map((l) => ta.text.slice(l.start, l.end)).filter((l) => l.length > 3 && matchRanges(l, groups).length === 0 && !ta.hidden);
      for (const l of lines) expect(tb.text, `page ${p}`).toContain(l);
    }
    await a.destroy();
    await b.destroy();
  });

  it('is reproducible with a fixed seed', async () => {
    const r = await margin('pseudonymize', join(dir, `${name}.pdf`), '--terms', join(dir, 'terms.txt'), '-o', join(dir, 'again.pdf'));
    expect(r.code, r.stderr).toBe(0);
    expect(Buffer.compare(readFileSync(join(dir, 'again.pdf')), Buffer.from(redacted))).toBe(0);
  });

  it.runIf(hasAnnot)('copies the annotation file with tokens, and restore reproduces the anchors exactly', async () => {
    const orig: AnnotFile = JSON.parse(readFileSync(join(dir, `${name}.annot.json`), 'utf8'));
    const pseudo: AnnotFile = JSON.parse(readFileSync(join(dir, `${name}.pseudo.annot.json`), 'utf8'));
    expect(JSON.stringify(pseudo.annotations.map((a) => [a.body, a.anchor.type === 'text' ? a.anchor.quote : null])).match(/Müller|Keller|Ruffieux/)).toBeNull();
    expect(pseudo.annotations.map((a) => a.anchor.type === 'text' ? a.anchor.quads : a.anchor.rect)).toEqual(orig.annotations.map((a) => a.anchor.type === 'text' ? a.anchor.quads : a.anchor.rect));
    // The pseudonymized file resolves on the redacted PDF as it is.
    expect((await margin('check', join(dir, `${name}.pseudo.pdf`))).code).toBe(0);

    const out = join(dir, 'restored.annot.json');
    const r = await margin('restore', join(dir, `${name}.pseudo.annot.json`), '--map', join(dir, `${name}.pseudo.json`), '--original', join(dir, `${name}.pdf`), '-o', out);
    expect(r.code, r.stderr).toBe(0);
    const restored: AnnotFile = JSON.parse(readFileSync(out, 'utf8'));
    expect(restored.document).toEqual(orig.document);
    expect(restored.annotations.map((a) => a.anchor)).toEqual(orig.annotations.map((a) => a.anchor));
    expect(JSON.stringify(restored.annotations.map((a) => a.body))).not.toMatch(/\[[A-Z_0-9]+\]/);
  });
});

describe('pseudonymize and restore (names fixture)', () => {
  let dir: string;
  const p = (f: string) => join(dir, f);
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'margin-pseudo-cli-'));
    for (const f of ['names.pdf', 'names.annot.json', 'terms.txt']) copyFileSync(join(FIXTURES, 'names', f), p(f));
    expect((await margin('pseudonymize', p('names.pdf'), '--terms', p('terms.txt'))).code).toBe(0);
  });

  it('an agent comment quoting a token transfers to the original with the real words', async () => {
    const add = await margin('add', p('names.pseudo.pdf'), '--page', '1', '--quote', '[AUTHOR_1]’s lemma the order', '--category', 'remark', '--body', 'Which lemma of [AUTHOR_1]?');
    expect(add.code, add.stderr).toBe(0);
    const id = add.stdout.trim();
    const r = await margin('restore', p('names.pseudo.annot.json'), '--map', p('names.pseudo.json'), '--original', p('names.pdf'), '--as', 'AUTHOR_1=Anna', '-o', p('agent.annot.json'));
    expect(r.code, r.stderr).toBe(0);
    const a = (JSON.parse(readFileSync(p('agent.annot.json'), 'utf8')) as AnnotFile).annotations.find((x) => x.id === id)!;
    expect(a.body).toBe('Which lemma of Anna?');
    expect(a.anchor.type === 'text' && normalizeQuote(a.anchor.quote!.exact)).toBe(normalizeQuote('Müller’s lemma the order'));
  });

  it('restore merges into an existing annotation file by ID', async () => {
    const r = await margin('restore', p('names.pseudo.annot.json'), '--map', p('names.pseudo.json'), '--original', p('names.pdf'));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('merged');
    const merged: AnnotFile = JSON.parse(readFileSync(p('names.annot.json'), 'utf8'));
    expect(merged.annotations).toHaveLength(5);
  });

  it('restore checks both hashes and the tokens', async () => {
    const wrongOriginal = await margin('restore', p('names.pseudo.annot.json'), '--map', p('names.pseudo.json'), '--original', p('names.pseudo.pdf'), '-o', p('x.json'));
    expect(wrongOriginal.code).toBe(1);
    expect(wrongOriginal.stderr).toContain('original-mismatch');
    const wrongAnnot = await margin('restore', p('names.annot.json'), '--map', p('names.pseudo.json'), '--original', p('names.pdf'), '-o', p('x.json'));
    expect(wrongAnnot.stderr).toContain('pseudo-mismatch');
    const badToken = await margin('restore', p('names.pseudo.annot.json'), '--map', p('names.pseudo.json'), '--original', p('names.pdf'), '--as', 'NOPE=x', '-o', p('x.json'));
    expect(badToken.code).toBe(2);
    expect(existsSync(p('x.json'))).toBe(false);
  });

  it('refuses to overwrite, warns about unused terms, and reports bad terms files', async () => {
    const again = await margin('pseudonymize', p('names.pdf'), '--terms', p('terms.txt'));
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('exists');
    writeFileSync(p('t2.txt'), 'AUTHOR_1: Anna Müller\nGHOST: Nobody Here\n');
    const unused = await margin('pseudonymize', p('names.pdf'), '--terms', p('t2.txt'), '--annot', p('none.json'), '-o', p('u.pdf'));
    expect(unused.code, unused.stderr).toBe(0);
    expect(unused.stderr).toContain('GHOST matched nothing');
    writeFileSync(p('bad.txt'), 'author: x\n');
    const bad = await margin('pseudonymize', p('names.pdf'), '--terms', p('bad.txt'), '-o', p('b.pdf'));
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('terms-invalid');
  });

  it('--suggest lists candidates without writing anything', async () => {
    const r = await margin('--json', 'pseudonymize', p('names.pdf'), '--suggest');
    const s = JSON.parse(r.stdout).suggestions as { kind: string; text: string }[];
    expect(s).toContainEqual(expect.objectContaining({ kind: 'title-block', text: 'Anna Müller' }));
    expect(s).toContainEqual(expect.objectContaining({ kind: 'email', text: 'anna.mueller@student.ethz.ch' }));
    expect(s).toContainEqual(expect.objectContaining({ kind: 'student-id', text: '19-123-456' }));
  });
});
