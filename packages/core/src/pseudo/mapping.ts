import { quoteForRange, rangeForQuads } from '../anchor/resolve.ts';
import { MarginError } from '../errors.ts';
import type { Annotation, AnnotFile, DocumentInfo } from '../model/types.ts';
import type { PageText } from '../pdf/extract.ts';
import { substituteTerms, tokenText } from './match.ts';
import { restoreText, type TermGroup } from './terms.ts';

// Mapping file and round trip (spec §10.5). `<name>.pseudo.json` links the original and the
// redacted PDF by hash and keeps the term groups; it stays local and is never embedded anywhere.
// Annotations made on the redacted copy go back to the original with the same quads (the page
// geometry is identical); their quotes are taken from the original again.

export const PSEUDO_FORMAT = 'margin-pseudo';
export const PSEUDO_VERSION = 1;

export interface PseudoMap {
  format: typeof PSEUDO_FORMAT;
  version: number;
  originalSha256: string;
  redactedSha256: string;
  groups: TermGroup[];
  [key: string]: unknown;
}

export function createPseudoMap(originalSha256: string, redactedSha256: string, groups: TermGroup[]): PseudoMap {
  return { format: PSEUDO_FORMAT, version: PSEUDO_VERSION, originalSha256, redactedSha256, groups: groups.map((g) => ({ ...g })) };
}

export function serializePseudoMap(map: PseudoMap): string {
  return JSON.stringify(map, null, 2) + '\n';
}

export function parsePseudoMap(text: string): PseudoMap {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new MarginError('pseudo-invalid', `The mapping file is not valid JSON: ${(e as Error).message}`);
  }
  const m = data as Partial<PseudoMap>;
  const hex = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  if (m?.format !== PSEUDO_FORMAT) throw new MarginError('pseudo-invalid', `Not a Margin mapping file (format must be "${PSEUDO_FORMAT}").`, { path: '/format' });
  if (m.version !== PSEUDO_VERSION) throw new MarginError('pseudo-invalid', `Unsupported mapping file version ${String(m.version)}.`, { path: '/version' });
  if (!hex(m.originalSha256)) throw new MarginError('pseudo-invalid', 'originalSha256 must be a sha256 hex string.', { path: '/originalSha256' });
  if (!hex(m.redactedSha256)) throw new MarginError('pseudo-invalid', 'redactedSha256 must be a sha256 hex string.', { path: '/redactedSha256' });
  if (!Array.isArray(m.groups)) throw new MarginError('pseudo-invalid', 'groups must be an array.', { path: '/groups' });
  m.groups.forEach((g, i) => {
    if (typeof g?.token !== 'string' || !Array.isArray(g.variants) || g.variants.some((v) => typeof v !== 'string') || (g.restore !== undefined && typeof g.restore !== 'string')) {
      throw new MarginError('pseudo-invalid', `groups[${i}] needs a token, variants (strings) and optionally restore (string).`, { path: `/groups/${i}` });
    }
  });
  return m as PseudoMap;
}

/** Apply `fn` to every string inside a JSON value. */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  return value;
}

/** Fields that never contain document text. */
const FIXED = new Set(['id', 'category', 'side', 'origin', 'reviewed', 'status', 'created', 'modified']);

function mapAnnotation(a: Annotation, fn: (s: string) => string): Annotation {
  const out = {} as Annotation;
  for (const [k, v] of Object.entries(a)) {
    if (FIXED.has(k)) (out as Record<string, unknown>)[k] = v;
    else if (k === 'anchor') out.anchor = a.anchor.type === 'text' && a.anchor.quote ? { ...a.anchor, quote: mapStrings(a.anchor.quote, fn) } : a.anchor;
    else (out as Record<string, unknown>)[k] = mapStrings(v, fn);
  }
  return out;
}

/**
 * The annotation file for the redacted copy: terms in bodies, quotes, category names and agent
 * metadata become tokens; geometry is unchanged. A grading report reference is dropped.
 */
export function pseudonymizeAnnotations(file: AnnotFile, groups: TermGroup[], redacted: DocumentInfo): AnnotFile {
  const sub = (s: string) => substituteTerms(s, groups);
  const { report: _report, ...rest } = file;
  return {
    ...rest,
    document: { ...redacted },
    categories: file.categories.map((c) => ({ ...c, name: sub(c.name) })),
    annotations: file.annotations.map((a) => mapAnnotation(a, sub)),
  };
}

export interface RestoreOptions {
  /** The original paper: its info and page text (for re-extracting quotes). */
  original: { info: DocumentInfo; texts: PageText[] };
  /** Existing annotation file of the original; restored annotations are merged into it by ID. */
  existing?: AnnotFile;
  /** Replacement text per token, overriding each group's `restore` and first variant. */
  restoreAs?: Record<string, string>;
}

/** Annotations made on the redacted copy, transferred to the original (§10.5). */
export function restoreAnnotations(pseudo: AnnotFile, map: PseudoMap, o: RestoreOptions): AnnotFile {
  if (pseudo.document.sha256 !== map.redactedSha256) {
    throw new MarginError('pseudo-mismatch', 'The annotation file was not made on the pseudonymized PDF of this mapping file (sha256 differs).', { path: '/document/sha256' });
  }
  if (o.original.info.sha256 !== map.originalSha256) {
    throw new MarginError('original-mismatch', 'The original PDF is not the one this mapping file was made from (sha256 differs).');
  }
  for (const t of Object.keys(o.restoreAs ?? {})) {
    if (!map.groups.some((g) => g.token === t)) throw new MarginError('usage', `Unknown token ${t} (the mapping file has ${map.groups.map((g) => g.token).join(', ')}).`);
  }
  const replacements = map.groups.map((g) => [tokenText(g.token), o.restoreAs?.[g.token] ?? restoreText(g)] as const);
  const unsub = (s: string) => replacements.reduce((acc, [token, text]) => acc.split(token).join(text), s);

  const tokens = replacements.map(([token]) => token);
  const hasToken = (v: unknown) => typeof v === 'string' && tokens.some((t) => v.includes(t));
  const restored = pseudo.annotations.map((a) => {
    const r = mapAnnotation(a, unsub);
    const anchor = r.anchor;
    // A quote without tokens is the original's own; one with tokens is taken from the original by its quads.
    const quote = a.anchor.type === 'text' ? a.anchor.quote : undefined;
    if (anchor.type === 'text' && quote && ![quote.exact, quote.prefix, quote.suffix].some(hasToken)) {
      r.anchor = { ...anchor, quote };
    } else if (anchor.type === 'text' && anchor.page !== undefined && anchor.quads?.length) {
      const page = o.original.texts[anchor.page - 1];
      const range = page && rangeForQuads(page, anchor.quads);
      if (page && range) r.anchor = { ...anchor, quote: { ...anchor.quote, ...quoteForRange(page, range[0], range[1]) } };
    }
    return r;
  });

  const base: AnnotFile = o.existing ?? (() => {
    const { report: _report, ...rest } = pseudo;
    return { ...rest, categories: pseudo.categories.map((c) => ({ ...c, name: unsub(c.name) })), annotations: [] };
  })();
  const categories = [...base.categories];
  for (const c of pseudo.categories) if (!categories.some((x) => x.id === c.id)) categories.push({ ...c, name: unsub(c.name) });
  const ids = new Set(restored.map((a) => a.id));
  return {
    ...base,
    document: { ...o.original.info },
    categories,
    annotations: [...base.annotations.filter((a) => !ids.has(a.id)), ...restored],
  };
}
