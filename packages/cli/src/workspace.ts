import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  FontSet,
  MarginError,
  parseAnnotFile,
  PdfDoc,
  seededRandomBytes,
  serialize,
  type AnnotFile,
  type FontBytes,
  type LoadOptions,
} from '@margin/core';

// File-system side of the CLI: locating the PDF and its annotation file, loading fonts, atomic writes.

const FONTS_DIR = new URL('../../../fonts/', import.meta.url).pathname;

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Clock and ID randomness. MARGIN_NOW (ISO timestamp) and MARGIN_SEED (integer) pin them for
 * reproducible runs and tests.
 */
export function loadOptions(): LoadOptions {
  const opts: LoadOptions = {};
  if (process.env.MARGIN_NOW) {
    const d = new Date(process.env.MARGIN_NOW);
    opts.now = () => d;
  }
  if (process.env.MARGIN_SEED) opts.random = seededRandomBytes(Number(process.env.MARGIN_SEED));
  return opts;
}

let fonts: FontSet | undefined;

export function loadFonts(): FontSet {
  if (!fonts) {
    const read = (name: string) => new Uint8Array(readFileSync(join(FONTS_DIR, `${name}.ttf`)));
    const bytes: FontBytes = {
      sans: read('FiraSans-Regular'),
      'sans-italic': read('FiraSans-Italic'),
      'sans-bold': read('FiraSans-SemiBold'),
      'sans-bolditalic': read('FiraSans-SemiBoldItalic'),
      mono: read('FiraMono-Regular'),
    };
    fonts = new FontSet(bytes);
  }
  return fonts;
}

/** `paper.pdf` → `paper.annot.json` next to it. */
export function annotPathFor(pdfPath: string): string {
  return join(dirname(pdfPath), basename(pdfPath).replace(/\.pdf$/i, '') + '.annot.json');
}

export function readBytes(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (e) {
    throw new MarginError('io', `Cannot read ${path}: ${(e as Error).message}`, { path });
  }
}

/** Write via a temporary file and rename, so readers never see a half-written file. */
export function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    throw new MarginError('io', `Cannot write ${path}: ${(e as Error).message}`, { path });
  }
}

export interface Workspace {
  annotPath: string;
  file: AnnotFile;
  pdfPath: string;
  /** Loaded on demand. */
  pdf(): Promise<PdfDoc>;
  /** Problems noticed while loading (e.g. hash mismatch), as warnings. */
  warnings: MarginError[];
  save(): void;
}

/**
 * Locate the annotation file: `--annot`, else next to the given PDF, else the only `*.annot.json`
 * in the current directory.
 */
export function locate(pdfArg: string | undefined, annotArg: string | undefined): { annotPath: string; pdfPath?: string } {
  if (annotArg) return { annotPath: resolve(annotArg), ...(pdfArg ? { pdfPath: resolve(pdfArg) } : {}) };
  if (pdfArg) {
    if (pdfArg.endsWith('.annot.json')) return { annotPath: resolve(pdfArg) };
    return { annotPath: annotPathFor(resolve(pdfArg)), pdfPath: resolve(pdfArg) };
  }
  const found = readdirSync('.').filter((f) => f.endsWith('.annot.json') && !f.startsWith('.'));
  if (found.length === 1) return { annotPath: resolve(found[0]!) };
  throw new MarginError(
    'no-annotation-file',
    found.length === 0
      ? 'No annotation file found. Pass the PDF (margin <command> paper.pdf …), --annot <file>, or run margin init paper.pdf.'
      : `Several annotation files here (${found.join(', ')}); pass the PDF or --annot <file>.`,
  );
}

export function openWorkspace(pdfArg: string | undefined, annotArg: string | undefined): Workspace {
  const loc = locate(pdfArg, annotArg);
  if (!existsSync(loc.annotPath)) {
    throw new MarginError('no-annotation-file', `${loc.annotPath} does not exist. Run margin init <pdf> first.`, { path: loc.annotPath });
  }
  const text = readFileSync(loc.annotPath, 'utf8');
  const file = parseAnnotFile(text, loadOptions());
  const pdfPath = loc.pdfPath ?? join(dirname(loc.annotPath), file.document.fileName);
  const warnings: MarginError[] = [];
  let doc: Promise<PdfDoc> | undefined;
  return {
    annotPath: loc.annotPath,
    file,
    pdfPath,
    warnings,
    pdf() {
      doc ??= (async () => {
        const d = await PdfDoc.open(readBytes(pdfPath));
        if (d.sha256 !== file.document.sha256) {
          warnings.push(new MarginError('pdf-mismatch', `${basename(pdfPath)} does not match the annotation file (sha256 differs); anchors may be off. Run margin resolve to re-anchor by quote.`, { path: '/document/sha256' }));
        }
        return d;
      })();
      return doc;
    },
    save() {
      writeAtomic(loc.annotPath, serialize(file));
    },
  };
}
