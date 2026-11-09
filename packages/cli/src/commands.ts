import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { DEFAULT_PORT, startBridge } from '@margin/bridge';
import {
  applyOps,
  checkFile,
  computeNumbers,
  createAnnotFile,
  documentGeometry,
  parsePseudoMap,
  parseTerms,
  pseudonymize,
  restoreAnnotations,
  serializePseudoMap,
  suggestTerms,
  importExported,
  sha256Hex,
  layoutDocument,
  MarginError,
  pageIndexes,
  parseAnnotFile,
  PdfDoc,
  rangeForQuads,
  renderPdf,
  resolveAll,
  schema,
  serialize,
  type Annotation,
  type LayoutResult,
  type Op,
  type Rect,
  type Side,
} from '@margin/core';
import { annotPathFor, loadFonts, loadOptions, openWorkspace, readBytes, VERSION, writeAtomic, type Workspace } from './workspace.ts';
import { EXIT_OK, EXIT_PROBLEMS, type Output } from './output.ts';

export interface Args {
  positionals: string[];
  values: Record<string, string | boolean | string[] | undefined>;
}

function str(args: Args, name: string): string | undefined {
  const v = args.values[name];
  return typeof v === 'string' ? v : undefined;
}

function list(args: Args, name: string): string[] {
  const v = args.values[name];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}

function int(args: Args, name: string): number | undefined {
  const v = str(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new MarginError('usage', `--${name} must be an integer, got "${v}".`);
  return n;
}

function rect(args: Args, name: string): Rect | undefined {
  const v = str(args, name);
  if (v === undefined) return undefined;
  const parts = v.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw new MarginError('usage', `--${name} must be x0,y0,x1,y1 in PDF points.`);
  return parts as Rect;
}

/** Parse "3", "3-5", "1,4,7-9" into sorted page numbers within 1…max. */
export function parsePages(spec: string | undefined, max: number): number[] {
  if (!spec) return Array.from({ length: max }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new MarginError('usage', `Invalid page range "${spec}"; use e.g. 3, 3-5 or 1,4,7-9.`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) {
      if (p < 1 || p > max) throw new MarginError('usage', `Page ${p} is out of range (document has ${max} pages).`);
      out.add(p);
    }
  }
  return [...out].sort((x, y) => x - y);
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ⏎ ');
}

function quoteOf(a: Annotation): string {
  return a.anchor.type === 'text' ? (a.anchor.quote?.exact ?? '') : `[region ${a.anchor.rect.join(', ')}]`;
}

async function withLayout(ws: Workspace, pages?: number[]): Promise<{ doc: PdfDoc; layout: LayoutResult; geometry: Awaited<ReturnType<typeof documentGeometry>> }> {
  const doc = await ws.pdf();
  const geometry = await documentGeometry(doc, ws.file);
  const layout = await layoutDocument(ws.file, geometry, loadFonts(), pages);
  return { doc, layout, geometry };
}

// ── init ──────────────────────────────────────────────────────────────────────────────────────

export async function cmdInit(args: Args, out: Output): Promise<number> {
  const pdfPath = args.positionals[0];
  if (!pdfPath) throw new MarginError('usage', 'Usage: margin init <paper.pdf> [--force]');
  const annotPath = str(args, 'annot') ? resolve(str(args, 'annot')!) : annotPathFor(resolve(pdfPath));
  if (existsSync(annotPath) && !args.values.force) {
    throw new MarginError('exists', `${annotPath} already exists; pass --force to overwrite it.`, { path: annotPath });
  }
  const doc = await PdfDoc.open(readBytes(pdfPath));
  const file = createAnnotFile(doc.info(basename(pdfPath)));
  writeAtomic(annotPath, serialize(file));
  out.result({ annotationFile: annotPath, pages: doc.pageCount, sha256: doc.sha256 }, `Created ${annotPath} (${doc.pageCount} pages).`);
  return EXIT_OK;
}

// ── read ──────────────────────────────────────────────────────────────────────────────────────

export async function cmdRead(args: Args, out: Output): Promise<number> {
  const ws = openWorkspace(args.positionals[0], str(args, 'annot'));
  const doc = await ws.pdf();
  ws.warnings.forEach((w) => out.warn(w));
  const pages = parsePages(str(args, 'pages'), doc.pageCount);
  const numbers = computeNumbers(ws.file);
  const kinds = new Map(ws.file.categories.map((c) => [c.id, c.kind]));
  const sections: string[] = [];
  const jsonPages: unknown[] = [];
  for (const p of pages) {
    const t = await doc.text(p);
    // Insertion points: after each anchor's last character.
    const inserts = new Map<number, string[]>();
    const onPage = ws.file.annotations
      .filter((a) => a.anchor.page === p)
      .sort((a, b) => (numbers[a.id] ?? Infinity) - (numbers[b.id] ?? Infinity) || (a.id < b.id ? -1 : 1));
    for (const a of onPage) {
      const rects = a.anchor.type === 'region' ? [a.anchor.rect] : a.anchor.quads;
      const range = rects ? rangeForQuads(t, rects) : null;
      const at = range ? range[1] : t.text.length;
      const label = kinds.get(a.category) === 'highlight' ? `⟦${a.category} ${a.id}⟧` : `⟦#${numbers[a.id] ?? '?'} ${a.category} ${a.id}: ${oneLine(a.body)}⟧`;
      inserts.set(at, [...(inserts.get(at) ?? []), label]);
    }
    let text = '';
    for (let i = 0; i <= t.text.length; i++) {
      const ins = inserts.get(i);
      if (ins) text += ' ' + ins.join(' ');
      if (i < t.text.length) text += t.text[i];
    }
    const lines = text.split('\n');
    const width = String(lines.length).length;
    sections.push(`# Page ${p}\n\n` + lines.map((l, i) => `${String(i + 1).padStart(width)}  ${l.trimStart()}`).join('\n'));
    jsonPages.push({ page: p, lines: lines.map((l) => l.trimStart()) });
  }
  out.result({ pages: jsonPages }, sections.join('\n\n'));
  return EXIT_OK;
}

// ── list ──────────────────────────────────────────────────────────────────────────────────────

export async function cmdList(args: Args, out: Output): Promise<number> {
  const ws = openWorkspace(args.positionals[0], str(args, 'annot'));
  const page = int(args, 'page');
  const category = str(args, 'category');
  const origin = str(args, 'origin');
  const numbers = computeNumbers(ws.file);
  const rows = ws.file.annotations
    .filter((a) => (page === undefined || a.anchor.page === page) && (category === undefined || a.category === category))
    .filter((a) => (origin === undefined || a.origin === origin) && (!args.values.unreviewed || (a.origin === 'agent' && !a.reviewed)))
    .sort((a, b) => (numbers[a.id] ?? Infinity) - (numbers[b.id] ?? Infinity) || (a.anchor.page ?? 0) - (b.anchor.page ?? 0) || (a.id < b.id ? -1 : 1))
    .map((a) => ({
      number: numbers[a.id] ?? null,
      id: a.id,
      category: a.category,
      page: a.anchor.page ?? null,
      quote: quoteOf(a),
      body: a.body,
      origin: a.origin,
      ...(a.origin === 'agent' ? { reviewed: a.reviewed === true } : {}),
      ...(a.status && a.status !== 'ok' ? { status: a.status } : {}),
    }));
  const text = rows.length
    ? rows.map((r) => `${r.number === null ? '  -' : String(r.number).padStart(3)}  ${r.id}  ${r.category.padEnd(8)} p${r.page ?? '?'}  "${r.quote}"${r.status ? ` [${r.status}]` : ''}${r.body ? `\n       ${oneLine(r.body)}` : ''}`).join('\n')
    : 'No annotations.';
  out.result({ annotations: rows }, text);
  return EXIT_OK;
}

// ── add / edit / rm / apply ───────────────────────────────────────────────────────────────────

async function runOps(ws: Workspace, ops: Op[], out: Output): Promise<number> {
  const doc = await ws.pdf();
  ws.warnings.forEach((w) => out.warn(w));
  const needsText = ops.some((o) => o.op === 'add');
  const opts = loadOptions();
  const { file, results } = applyOps(ws.file, ops, {
    indexes: needsText ? await pageIndexes(doc) : [],
    pageCount: doc.pageCount,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.random ? { random: opts.random } : {}),
  });
  ws.file.annotations = file.annotations;
  ws.save();
  const text = results.map((r) => (ops.length === 1 && r.op === 'add' ? r.id : `${r.op} ${r.id}`)).join('\n');
  out.result({ results }, text);
  return EXIT_OK;
}

export async function cmdAdd(args: Args, out: Output): Promise<number> {
  const ws = openWorkspace(args.positionals[0], str(args, 'annot'));
  const category = str(args, 'category');
  if (!category) throw new MarginError('usage', 'margin add needs --category (e.g. typo, error, remark, good, hl).');
  const quote = str(args, 'quote');
  const region = rect(args, 'region');
  if (!quote && !region) throw new MarginError('usage', 'margin add needs --quote "<text>" or --region x0,y0,x1,y1 with --page.');
  const page = int(args, 'page');
  const op: Op = {
    op: 'add',
    category,
    body: str(args, 'body') ?? '',
    ...(page !== undefined ? { page } : {}),
    ...(quote ? { quote } : {}),
    ...(str(args, 'prefix') ? { prefix: str(args, 'prefix') } : {}),
    ...(str(args, 'suffix') ? { suffix: str(args, 'suffix') } : {}),
    ...(region ? { region } : {}),
    ...(str(args, 'side') ? { side: str(args, 'side') as Side } : {}),
    ...(str(args, 'origin') ? { origin: str(args, 'origin') as 'human' | 'agent' } : {}),
  };
  return runOps(ws, [op], out);
}

export async function cmdEdit(args: Args, out: Output): Promise<number> {
  const [id, pdf] = args.positionals;
  if (!id) throw new MarginError('usage', 'Usage: margin edit <id> [--body …] [--category …] [--side auto|left|right] [--reviewed]');
  const ws = openWorkspace(pdf, str(args, 'annot'));
  const op: Op = {
    op: 'edit',
    id,
    ...(str(args, 'body') !== undefined ? { body: str(args, 'body') } : {}),
    ...(str(args, 'category') ? { category: str(args, 'category') } : {}),
    ...(str(args, 'side') ? { side: str(args, 'side') as Side } : {}),
    ...(args.values.reviewed ? { reviewed: true } : {}),
  };
  return runOps(ws, [op], out);
}

export async function cmdRm(args: Args, out: Output): Promise<number> {
  const [id, pdf] = args.positionals;
  if (!id) throw new MarginError('usage', 'Usage: margin rm <id>');
  return runOps(openWorkspace(pdf, str(args, 'annot')), [{ op: 'rm', id }], out);
}

export async function cmdApply(args: Args, out: Output): Promise<number> {
  const [opsPath, pdf] = args.positionals;
  if (!opsPath) throw new MarginError('usage', 'Usage: margin apply <ops.json>');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(opsPath, 'utf8'));
  } catch (e) {
    throw new MarginError('usage', `Cannot read operations from ${opsPath}: ${(e as Error).message}`);
  }
  const ops = Array.isArray(data) ? data : (data as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) throw new MarginError('usage', `${opsPath} must contain an array of operations or {"ops": [...]}.`);
  return runOps(openWorkspace(pdf, str(args, 'annot')), ops as Op[], out);
}

// ── resolve / check ───────────────────────────────────────────────────────────────────────────

export async function cmdResolve(args: Args, out: Output): Promise<number> {
  const ws = openWorkspace(args.positionals[0], str(args, 'annot'));
  const doc = await ws.pdf();
  // A PDF that differs from the one annotated: find every quote again instead of trusting stored quads.
  const resolutions = await resolveAll(doc, ws.file, { reanchor: doc.sha256 !== ws.file.document.sha256 });
  ws.file.document.sha256 = doc.sha256;
  ws.file.document.pageCount = doc.pageCount;
  ws.file.document.pages = doc.pages.map((p) => ({ ...p }));
  ws.save();
  const rows = [...resolutions.entries()].map(([id, r]) => ({ id, status: r.status, ...(r.status === 'ambiguous' ? { candidates: r.candidates } : {}) }));
  const bad = rows.filter((r) => r.status !== 'ok');
  out.result({ annotations: rows }, bad.length ? bad.map((r) => `${r.id}: ${r.status}`).join('\n') : `All ${rows.length} anchors resolved.`);
  return bad.length ? EXIT_PROBLEMS : EXIT_OK;
}

export async function cmdCheck(args: Args, out: Output): Promise<number> {
  const ws = openWorkspace(args.positionals[0], str(args, 'annot'));
  const { doc, layout } = await withLayout(ws);
  const problems = checkFile(ws.file, { pdfSha256: doc.sha256, diagnostics: layout.diagnostics });
  if (ws.file.report) {
    const path = resolve(dirname(ws.annotPath), ws.file.report.fileName);
    if (!existsSync(path)) problems.push({ code: 'report-missing', severity: 'error', path: '/report/fileName', message: `The grading report ${ws.file.report.fileName} is missing.` });
    else if ((await sha256Hex(readBytes(path))) !== ws.file.report.sha256) problems.push({ code: 'report-changed', severity: 'warning', path: '/report/sha256', message: `${ws.file.report.fileName} changed after it was attached.` });
  }
  const errors = problems.filter((p) => p.severity === 'error');
  const text = problems.length ? problems.map((p) => `${p.severity}[${p.code}]: ${p.message}`).join('\n') : `OK: ${ws.file.annotations.length} annotations, no problems.`;
  out.result({ problems }, text);
  return errors.length ? EXIT_PROBLEMS : EXIT_OK;
}

// ── export / render ───────────────────────────────────────────────────────────────────────────

/** Compile a report written in LaTeX with the local latexmk (§8.4); returns the PDF path. */
function compileReport(texPath: string): string {
  try {
    execFileSync('latexmk', ['-pdf', '-interaction=nonstopmode', '-halt-on-error', basename(texPath)], { cwd: dirname(texPath), stdio: 'pipe' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MarginError('no-latex', 'Compiling a .tex report needs a TeX installation (latexmk was not found). Compile it yourself and pass the PDF to --report.');
    }
    throw new MarginError('report-compile', `latexmk failed for ${texPath}: ${String((e as { stdout?: Buffer }).stdout ?? (e as Error).message).split('\n').slice(-15).join('\n')}`);
  }
  return texPath.replace(/\.tex$/i, '.pdf');
}

/**
 * The grading report to put in front of (or behind) the annotated pages (§8.4): `--report` (and
 * `--position`), which is then remembered in the annotation file, else the file's `report` entry.
 * Without either there is no report and nothing is added.
 */
async function loadReport(ws: Workspace, args: Args): Promise<{ bytes: Uint8Array; position: 'before' | 'after' } | undefined> {
  const flag = str(args, 'report');
  const position = str(args, 'position');
  if (position !== undefined && position !== 'before' && position !== 'after') throw new MarginError('usage', '--position must be before or after.');
  if (flag) {
    let path = resolve(flag);
    if (extname(path).toLowerCase() === '.tex') path = compileReport(path);
    const bytes = readBytes(path);
    ws.file.report = { fileName: relative(dirname(ws.annotPath), path), sha256: await sha256Hex(bytes), position: (position as 'before' | 'after' | undefined) ?? ws.file.report?.position ?? 'before' };
    ws.save();
    return { bytes, position: ws.file.report.position };
  }
  const ref = ws.file.report;
  if (!ref) {
    if (position) throw new MarginError('usage', '--position needs a grading report: pass --report <file>.');
    return undefined;
  }
  if (position && position !== ref.position) {
    ref.position = position as 'before' | 'after';
    ws.save();
  }
  const path = resolve(dirname(ws.annotPath), ref.fileName);
  if (!existsSync(path)) throw new MarginError('report-missing', `The grading report ${ref.fileName} is missing; pass --report <file> or remove "report" from the annotation file.`, { path: '/report/fileName' });
  const bytes = readBytes(path);
  if ((await sha256Hex(bytes)) !== ref.sha256) {
    ws.warnings.push(new MarginError('report-changed', `${ref.fileName} changed after it was attached; export uses the current file. Pass --report ${ref.fileName} to accept it.`, { path: '/report/sha256' }));
  }
  return { bytes, position: ref.position };
}

async function exportBytes(ws: Workspace, report?: { bytes: Uint8Array; position: 'before' | 'after' }): Promise<{ bytes: Uint8Array; layout: LayoutResult }> {
  const { doc, layout, geometry } = await withLayout(ws);
  const bytes = await renderPdf({ pdfBytes: doc.bytes, file: ws.file, layout, geometry, fonts: loadFonts(), producer: `Margin ${VERSION}`, ...(report ? { report } : {}) });
  return { bytes, layout };
}

export async function cmdExport(args: Args, out: Output): Promise<number> {
  const ws = openWorkspace(args.positionals[0], str(args, 'annot'));
  const report = await loadReport(ws, args);
  const { bytes, layout } = await exportBytes(ws, report);
  ws.warnings.forEach((w) => out.warn(w));
  const target = str(args, 'o') ?? join(dirname(ws.pdfPath), basename(ws.pdfPath).replace(/\.pdf$/i, '') + '.annotated.pdf');
  writeAtomic(target, bytes);
  for (const o of layout.diagnostics.overflow) out.warn({ code: 'overflow', severity: 'warning', message: `Page ${o.page}: ${o.ids.length} comment(s) moved to a notes page (${o.ids.join(', ')}).` });
  out.result({ output: resolve(target), bytes: bytes.length, pages: layout.pages.length, report: report ? ws.file.report!.fileName : null }, `Wrote ${target}.`);
  return EXIT_OK;
}

/**
 * `margin import exported.pdf [original.pdf]`: recover the editable document from an exported PDF
 * (§8.2). The original is the attached one, or the given file, which must match by sha256.
 */
export async function cmdImport(args: Args, out: Output): Promise<number> {
  const [exportedPath, originalArg] = args.positionals;
  if (!exportedPath) throw new MarginError('usage', 'Usage: margin import <exported.pdf> [original.pdf] [--force]');
  const imported = await importExported(readBytes(exportedPath), loadOptions());
  if (!imported) throw new MarginError('not-exported', `${exportedPath} has no Margin annotation file attached.`, { path: exportedPath });
  const { file } = imported;
  let original = imported.original;
  if (originalArg) {
    original = readBytes(originalArg);
    if ((await sha256Hex(original)) !== file.document.sha256) {
      throw new MarginError('original-mismatch', `${originalArg} is not the paper this export was made from (sha256 differs).`, { path: originalArg });
    }
  }
  if (!original) {
    throw new MarginError('original-needed', `The original paper (${file.document.fileName}, sha256 ${file.document.sha256.slice(0, 12)}…) is not attached; pass it: margin import ${exportedPath} <original.pdf>.`);
  }
  const dir = dirname(resolve(originalArg ?? exportedPath));
  const pdfPath = originalArg ? resolve(originalArg) : join(dir, file.document.fileName);
  const annotPath = str(args, 'annot') ? resolve(str(args, 'annot')!) : annotPathFor(pdfPath);
  if (existsSync(annotPath) && !args.values.force) throw new MarginError('exists', `${annotPath} already exists; pass --force to overwrite it.`, { path: annotPath });
  if (!originalArg) {
    if (existsSync(pdfPath) && !args.values.force) throw new MarginError('exists', `${pdfPath} already exists; pass --force to overwrite it, or pass the original explicitly.`, { path: pdfPath });
    writeAtomic(pdfPath, original);
  }
  writeAtomic(annotPath, serialize(file));
  out.result({ annotationFile: annotPath, pdf: pdfPath, annotations: file.annotations.length }, `Restored ${annotPath} (${file.annotations.length} annotations) for ${pdfPath}.`);
  return EXIT_OK;
}

export async function cmdRender(args: Args, out: Output): Promise<number> {
  const ws = openWorkspace(args.positionals[0], str(args, 'annot'));
  const outDir = str(args, 'o');
  if (!outDir) throw new MarginError('usage', 'Usage: margin render <paper.pdf> [--pages 3-5] -o <dir> [--dpi 150]');
  const dpi = int(args, 'dpi') ?? 150;
  const { bytes, layout } = await exportBytes(ws);
  ws.warnings.forEach((w) => out.warn(w));
  const exported = await PdfDoc.open(bytes);
  const annotated = [...new Set(ws.file.annotations.map((a) => a.anchor.page).filter((p): p is number => p !== undefined))].sort((a, b) => a - b);
  const pages = str(args, 'pages') ? parsePages(str(args, 'pages'), exported.pageCount) : annotated;
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const p of pages) {
    const bm = await exported.rasterize(p, dpi);
    const png = new PNG({ width: bm.width, height: bm.height });
    png.data = Buffer.from(bm.data.buffer, bm.data.byteOffset, bm.data.byteLength);
    const path = join(outDir, `page-${String(p).padStart(3, '0')}.png`);
    writeFileSync(path, PNG.sync.write(png));
    written.push(path);
  }
  const layoutPath = join(outDir, 'layout.json');
  writeFileSync(layoutPath, JSON.stringify({ pages: layout.pages.filter((l) => pages.includes(l.page)), numbers: layout.numbers }, null, 1) + '\n');
  await exported.destroy();
  out.result({ files: written, layout: layoutPath }, written.length ? written.join('\n') : 'No annotated pages; pass --pages to render specific pages.');
  return EXIT_OK;
}

// ── schema ────────────────────────────────────────────────────────────────────────────────────

export async function cmdSchema(): Promise<number> {
  process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
  return EXIT_OK;
}

// ── agent-guide ───────────────────────────────────────────────────────────────────────────────

export async function cmdAgentGuide(_args: Args, out: Output): Promise<number> {
  const text = readFileSync(new URL('./agent-guide.md', import.meta.url), 'utf8');
  out.result({ guide: text }, text);
  return EXIT_OK;
}

// ── serve ─────────────────────────────────────────────────────────────────────────────────────

export async function cmdServe(args: Args, out: Output): Promise<number> {
  const dir = str(args, 'dir')?.replace(/^~(?=\/|$)/, homedir()) ?? args.positionals[0] ?? '.';
  const port = int(args, 'port') ?? DEFAULT_PORT;
  const allowOrigins = (str(args, 'allow-origin') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  const appDir = str(args, 'app-dir') ?? new URL('../../web/dist/', import.meta.url).pathname;
  const bridge = await startBridge({ dir, port, appDir, allowOrigins });
  out.result(
    { url: bridge.url, origin: bridge.origin, port: bridge.port, token: bridge.token, dir: bridge.dir },
    `Margin bridge for ${bridge.dir}\nOpen: ${bridge.url}\nPress Ctrl+C to stop.`,
  );
  await new Promise<void>((done) => {
    const stop = () => done();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await bridge.close();
  return EXIT_OK;
}

// ── pseudonymize / restore ───────────────────────────────────────────────────────────────────

function refuseOverwrite(args: Args, ...paths: string[]): void {
  if (args.values.force) return;
  for (const p of paths) if (existsSync(p)) throw new MarginError('exists', `${p} already exists; pass --force to overwrite it.`, { path: p });
}

/** Page PNGs of the redacted PDF with every redaction outlined in red, for the review by eye (§10.4). */
async function writeReview(bytes: Uint8Array, matches: { page: number; quads: Rect[] }[], dir: string, dpi: number): Promise<string[]> {
  const doc = await PdfDoc.open(bytes);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  try {
    for (let p = 1; p <= doc.pageCount; p++) {
      const bm = await doc.rasterize(p, dpi);
      const k = dpi / 72;
      const px = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= bm.width || y >= bm.height) return;
        const i = (y * bm.width + x) * 4;
        bm.data[i] = 220;
        bm.data[i + 1] = 38;
        bm.data[i + 2] = 38;
        bm.data[i + 3] = 255;
      };
      for (const m of matches.filter((x) => x.page === p)) {
        for (const q of m.quads) {
          const [x0, y0, x1, y1] = [Math.floor(q[0] * k) - 2, Math.floor(q[1] * k) - 2, Math.ceil(q[2] * k) + 2, Math.ceil(q[3] * k) + 2];
          for (let t = 0; t < 2; t++) {
            for (let x = x0; x <= x1; x++) (px(x, y0 + t), px(x, y1 - t));
            for (let y = y0; y <= y1; y++) (px(x0 + t, y), px(x1 - t, y));
          }
        }
      }
      const png = new PNG({ width: bm.width, height: bm.height });
      png.data = Buffer.from(bm.data.buffer, bm.data.byteOffset, bm.data.byteLength);
      const path = join(dir, `review-${String(p).padStart(3, '0')}.png`);
      writeFileSync(path, PNG.sync.write(png));
      written.push(path);
    }
  } finally {
    await doc.destroy();
  }
  return written;
}

export async function cmdPseudonymize(args: Args, out: Output): Promise<number> {
  const pdfPath = args.positionals[0];
  if (!pdfPath) throw new MarginError('usage', 'Usage: margin pseudonymize <paper.pdf> --terms terms.txt [-o out.pdf] [--review dir] [--force]  |  --suggest');
  const pdfBytes = readBytes(pdfPath);
  if (args.values.suggest) {
    const doc = await PdfDoc.open(pdfBytes);
    const suggestions = suggestTerms(await doc.allText());
    await doc.destroy();
    out.result({ suggestions }, suggestions.length ? suggestions.map((s) => `${s.kind.padEnd(13)} p.${s.page}  ${s.text}`).join('\n') + '\n\nSuggestions only: put the ones you want in a terms file (TOKEN: variant | variant).' : 'No suggestions.');
    return EXIT_OK;
  }
  const termsPath = str(args, 'terms');
  if (!termsPath) throw new MarginError('usage', 'margin pseudonymize needs --terms <file> (one group per line: TOKEN: variant | variant | /regex/). Use --suggest for candidates.');
  const groups = parseTerms(readFileSync(termsPath, 'utf8'));
  const annotIn = str(args, 'annot') ? resolve(str(args, 'annot')!) : annotPathFor(resolve(pdfPath));
  const annotations = existsSync(annotIn) ? parseAnnotFile(readFileSync(annotIn, 'utf8'), loadOptions()) : undefined;
  if (annotations && annotations.document.sha256 !== (await sha256Hex(pdfBytes))) {
    throw new MarginError('pdf-mismatch', `${annotIn} belongs to a different version of the PDF; run margin resolve first.`, { path: annotIn });
  }

  const { random } = loadOptions();
  const result = await pseudonymize({ pdfBytes, fileName: basename(pdfPath), groups, fonts: loadFonts(), ...(annotations ? { annotations } : {}), ...(random ? { random } : {}) });
  const outPdf = str(args, 'o') ? resolve(str(args, 'o')!) : join(dirname(resolve(pdfPath)), result.fileName);
  const outMap = outPdf.replace(/\.pdf$/i, '') + '.json';
  const outAnnot = annotPathFor(outPdf);
  refuseOverwrite(args, outPdf, outMap, ...(result.annotations ? [outAnnot] : []));
  writeAtomic(outPdf, result.bytes);
  writeAtomic(outMap, serializePseudoMap(result.map));
  if (result.annotations) writeAtomic(outAnnot, serialize({ ...result.annotations, document: { ...result.annotations.document, fileName: basename(outPdf) } }));
  const review = str(args, 'review') ? await writeReview(result.bytes, result.matches, str(args, 'review')!, int(args, 'dpi') ?? 100) : [];

  const counts = groups.map((g) => ({ token: g.token, count: result.matches.filter((m) => m.token === g.token).length }));
  const unused = counts.filter((c) => c.count === 0).map((c) => c.token);
  const lines = [
    `Wrote ${outPdf}`,
    `      ${outMap} (keep it private: it maps tokens to names)`,
    ...(result.annotations ? [`      ${outAnnot} (${result.annotations.annotations.length} annotations)`] : []),
    `Redacted ${result.matches.length} occurrences: ${counts.map((c) => `${c.token} ${c.count}`).join(', ')}.`,
    `Also removed: ${result.scrubbed.join(', ') || 'nothing'}.`,
    'Verified: no term in text, metadata, outlines or raw streams.',
    ...(review.length ? [`Review images: ${review.join(', ')}`] : []),
    'Before sharing, check every page by eye: names inside images (scans, logos, signatures) cannot be detected.',
  ];
  for (const t of unused) out.warn({ code: 'term-unused', severity: 'warning', message: `${t} matched nothing; check its spelling.` });
  out.result({ pdf: outPdf, map: outMap, annotationFile: result.annotations ? outAnnot : null, redactions: counts, scrubbed: result.scrubbed, review }, lines.join('\n'));
  return EXIT_OK;
}

export async function cmdRestore(args: Args, out: Output): Promise<number> {
  const pseudoPath = args.positionals[0];
  const mapPath = str(args, 'map');
  const originalPath = str(args, 'original');
  if (!pseudoPath || !mapPath || !originalPath) throw new MarginError('usage', 'Usage: margin restore <paper.pseudo.annot.json> --map paper.pseudo.json --original paper.pdf [--as TOKEN=text …] [-o paper.annot.json]');
  const map = parsePseudoMap(readFileSync(mapPath, 'utf8'));
  const pseudo = parseAnnotFile(readFileSync(pseudoPath, 'utf8'), loadOptions());
  const restoreAs: Record<string, string> = {};
  for (const a of list(args, 'as')) {
    const eq = a.indexOf('=');
    if (eq < 1) throw new MarginError('usage', `--as takes TOKEN=text, got "${a}".`);
    restoreAs[a.slice(0, eq)] = a.slice(eq + 1);
  }
  const doc = await PdfDoc.open(readBytes(originalPath));
  const info = doc.info(basename(originalPath));
  const texts = await doc.allText();
  await doc.destroy();
  const target = str(args, 'o') ? resolve(str(args, 'o')!) : annotPathFor(resolve(originalPath));
  const existing = existsSync(target) ? parseAnnotFile(readFileSync(target, 'utf8'), loadOptions()) : undefined;
  if (existing && existing.document.sha256 !== info.sha256) throw new MarginError('pdf-mismatch', `${target} belongs to a different PDF than ${originalPath}.`, { path: target });
  const restored = restoreAnnotations(pseudo, map, { original: { info, texts }, ...(existing ? { existing } : {}), restoreAs });
  writeAtomic(target, serialize(restored));
  const n = pseudo.annotations.length;
  out.result({ annotationFile: target, restored: n, merged: !!existing }, `Restored ${n} annotation${n === 1 ? '' : 's'} into ${target}${existing ? ' (merged by ID with the existing file)' : ''}. Export from ${basename(originalPath)} as usual.`);
  return EXIT_OK;
}
