import type { Annotation, AnnotFile } from './types.ts';

// Canonical serialization (spec §4): stable key order, two-space indentation, annotations sorted by
// (page, y, x). Small objects and arrays of primitives stay on one line so diffs stay readable.
// Serializing is idempotent: serialize(parse(serialize(f))) === serialize(f).

const KEY_ORDER: Record<string, readonly string[]> = {
  root: ['format', 'version', 'document', 'categories', 'settings', 'report', 'annotations'],
  document: ['fileName', 'sha256', 'pageCount', 'pages'],
  page: ['width', 'height'],
  category: ['id', 'name', 'color', 'kind', 'weight'],
  settings: ['marginWidth', 'maxEnlargement', 'fontSize', 'leaderStyle', 'embedOriginal', 'crop'],
  report: ['fileName', 'sha256', 'position'],
  annotation: ['id', 'category', 'anchor', 'body', 'side', 'origin', 'reviewed', 'status', 'created', 'modified'],
  anchor: ['type', 'page', 'quads', 'rect', 'quote'],
  quote: ['exact', 'prefix', 'suffix'],
};

/** Child object kinds by (parent kind, key); arrays map each element. */
const CHILD_KIND: Record<string, Record<string, string>> = {
  root: { document: 'document', categories: 'category', settings: 'settings', report: 'report', annotations: 'annotation' },
  document: { pages: 'page' },
  annotation: { anchor: 'anchor' },
  anchor: { quote: 'quote' },
};

const INLINE_MAX = 100;

export function sortKey(a: Annotation): [number, number, number] {
  const anchor = a.anchor;
  const page = anchor.page ?? Number.POSITIVE_INFINITY;
  const r = anchor.type === 'region' ? anchor.rect : anchor.quads?.[0];
  return [page, r ? r[1] : Number.POSITIVE_INFINITY, r ? r[0] : Number.POSITIVE_INFINITY];
}

export function compareAnnotations(a: Annotation, b: Annotation): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < 3; i++) {
    const d = ka[i]! - kb[i]!;
    if (d !== 0 && !Number.isNaN(d)) return d;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function orderedKeys(obj: Record<string, unknown>, kind: string | undefined): string[] {
  const known = (kind && KEY_ORDER[kind]) || [];
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const first = known.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !known.includes(k)).sort();
  return [...first, ...rest];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== 'object';
}

function inline(value: unknown, kind: string | undefined): string | null {
  if (isPrimitive(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.every((v) => isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive)))) return null;
    return '[' + value.map((v) => inline(v, undefined)).join(', ') + ']';
  }
  if (isPlainObject(value)) {
    const keys = orderedKeys(value, kind);
    if (!keys.every((k) => isPrimitive(value[k]))) return null;
    if (keys.length === 0) return '{}';
    return '{ ' + keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(value[k])}`).join(', ') + ' }';
  }
  return null;
}

function write(value: unknown, kind: string | undefined, indent: string, key?: string): string {
  const one = inline(value, kind);
  if (one !== null && (isPrimitive(value) || indent.length + (key?.length ?? 0) + one.length <= INLINE_MAX)) return one;
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const childKind = kind;
    return '[\n' + value.map((v) => inner + write(v, childKind, inner)).join(',\n') + '\n' + indent + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = orderedKeys(obj, kind);
  if (keys.length === 0) return '{}';
  const lines = keys.map((k) => {
    const ck = kind ? CHILD_KIND[kind]?.[k] : undefined;
    return `${inner}${JSON.stringify(k)}: ${write(obj[k], ck, inner, k)}`;
  });
  return '{\n' + lines.join(',\n') + '\n' + indent + '}';
}

/** Canonical JSON text of an annotation file, with trailing newline. */
export function serialize(file: AnnotFile): string {
  const sorted = { ...file, annotations: [...file.annotations].sort(compareAnnotations) };
  return write(sorted, 'root', '') + '\n';
}
