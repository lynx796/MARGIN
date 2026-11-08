import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import {
  applyOps,
  checkFile,
  computeNumbers,
  createAnnotFile,
  documentGeometry,
  layoutDocument,
  MarginError,
  pageIndexes,
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
  values: Record<string, string | boolean | undefined>;
}

function str(args: Args, name: string): string | undefined {
  const v = args.values[name];
  return typeof v === 'string' ? v : undefined;
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
  const numbers = computeNumbers(ws.file);
  const rows = ws.file.annotations
    .filter((a) => (page === undefined || a.anchor.page === page) && (category === undefined || a.category === category))
    .sort((a, b) => (numbers[a.id] ?? Infinity) - (numbers[b.id] ?? Infinity) || (a.anchor.page ?? 0) - (b.anchor.page ?? 0) || (a.id < b.id ? -1 : 1))
    .map((a) => ({
      number: numbers[a.id] ?? null,
      id: a.id,
      category: a.category,
      page: a.anchor.page ?? null,
      quote: quoteOf(a),
      body: a.body,
      origin: a.origin,
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
  const errors = problems.filter((p) => p.severity === 'error');
  const text = problems.length ? problems.map((p) => `${p.severity}[${p.code}]: ${p.message}`).join('\n') : `OK: ${ws.file.annotations.length} annotations, no problems.`;
  out.result({ problems }, text);
  return errors.length ? EXIT_PROBLEMS : EXIT_OK;
}

// ── export / render ───────────────────────────────────────────────────────────────────────────

async function exportBytes(ws: Workspace): Promise<{ bytes: Uint8Array; layout: LayoutResult }> {
  const { doc, layout, geometry } = await withLayout(ws);
  const bytes = await renderPdf({ pdfBytes: doc.bytes, file: ws.file, layout, geometry, fonts: loadFonts(), producer: `Margin ${VERSION}` });
  return { bytes, layout };
}

export async function cmdExport(args: Args, out: Output): Promise<number> {
  const ws = openWorkspace(args.positionals[0], str(args, 'annot'));
  const { bytes, layout } = await exportBytes(ws);
  ws.warnings.forEach((w) => out.warn(w));
  const target = str(args, 'o') ?? join(dirname(ws.pdfPath), basename(ws.pdfPath).replace(/\.pdf$/i, '') + '.annotated.pdf');
  writeAtomic(target, bytes);
  for (const o of layout.diagnostics.overflow) out.warn({ code: 'overflow', severity: 'warning', message: `Page ${o.page}: comments do not fit the margins (${o.ids.join(', ')}).` });
  out.result({ output: resolve(target), bytes: bytes.length, pages: layout.pages.length }, `Wrote ${target}.`);
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
