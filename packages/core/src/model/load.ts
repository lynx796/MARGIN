import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../../../../schema/annot.schema.json';
import { MarginError } from '../errors.ts';
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS, DEFAULT_WEIGHT } from './defaults.ts';
import { cryptoRandomBytes, newId, type RandomBytes } from './ids.ts';
import { FORMAT, FORMAT_VERSION, type Annotation, type AnnotFile, type DocumentInfo } from './types.ts';

// NOTE: Ajv compiles validators with `new Function`, which the web app's CSP forbids. The web
// package (phase 2) must use Ajv's standalone code generation at build time instead.
const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validateSchema = ajv.compile(schema);

export { schema };

export interface LoadOptions {
  /** Current time; defaults to the system clock. Pin it for deterministic output. */
  now?: () => Date;
  random?: RandomBytes;
}

/** ISO 8601 UTC with seconds precision, e.g. `2026-11-12T14:03:11Z`. */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Schema validation; returns structured errors (empty when valid). */
export function validate(data: unknown): MarginError[] {
  if (validateSchema(data)) return [];
  return (validateSchema.errors ?? []).map(
    (e) => new MarginError('schema', `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`, { path: e.instancePath || '/', details: e.params }),
  );
}

/** Forward migrations between format versions (spec §4). Version 1 is the first, so none yet. */
function migrate(data: Record<string, unknown>): Record<string, unknown> {
  const version = data.version;
  if (typeof version === 'number' && version > FORMAT_VERSION) {
    throw new MarginError('version-unsupported', `Annotation file version ${version} is newer than this tool supports (${FORMAT_VERSION}).`, { path: '/version' });
  }
  return data;
}

/**
 * Fill everything a minimal, hand- or agent-written file may omit (spec §9.1): IDs, timestamps,
 * side, origin, body, anchor type, settings and category defaults. Mutates and returns `file`.
 */
export function normalize(file: AnnotFile, options: LoadOptions = {}): AnnotFile {
  const now = isoSeconds((options.now ?? (() => new Date()))());
  const random = options.random ?? cryptoRandomBytes;
  file.categories = (file.categories ?? DEFAULT_CATEGORIES.map((c) => ({ ...c }))).map((c) => ({ ...c, weight: c.weight ?? DEFAULT_WEIGHT }));
  file.settings = { ...DEFAULT_SETTINGS, ...(file.settings ?? {}) };
  const taken = new Set(file.annotations.map((a) => a.id).filter((id): id is string => typeof id === 'string'));
  for (const raw of file.annotations) {
    const a = raw as Partial<Annotation> & { anchor: Annotation['anchor'] };
    if (!a.id) {
      a.id = newId(taken, random);
      taken.add(a.id);
    }
    if (!a.anchor.type) (a.anchor as { type: string }).type = 'text';
    a.body ??= '';
    a.side ??= 'auto';
    a.origin ??= 'human';
    a.created ??= a.modified ?? now;
    a.modified ??= a.created;
  }
  return file;
}

/** Parse, validate, migrate and normalize annotation file text. Throws MarginError on invalid input. */
export function parseAnnotFile(text: string, options: LoadOptions = {}): AnnotFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new MarginError('json-syntax', `Annotation file is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) data = migrate(data as Record<string, unknown>);
  const errors = validate(data);
  if (errors.length > 0) {
    throw new MarginError('schema', `Annotation file does not match the schema (${errors.length} problem${errors.length > 1 ? 's' : ''}): ${errors.map((e) => e.message).join('; ')}`, {
      details: errors.map((e) => e.toJSON()),
    });
  }
  const file = normalize(data as AnnotFile, options);
  const ids = new Set<string>();
  file.annotations.forEach((a, i) => {
    if (ids.has(a.id)) throw new MarginError('duplicate-id', `Duplicate annotation id ${a.id}.`, { path: `/annotations/${i}/id` });
    ids.add(a.id);
  });
  return file;
}

/** A fresh annotation file for a PDF (spec §9.1 `margin init`). */
export function createAnnotFile(document: DocumentInfo): AnnotFile {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    document,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    settings: { ...DEFAULT_SETTINGS },
    annotations: [],
  };
}
