import { PageIndex, resolveAnnotation, type Candidate } from './anchor/resolve.ts';
import { MarginError } from './errors.ts';
import { cryptoRandomBytes, newId, type RandomBytes } from './model/ids.ts';
import { isoSeconds } from './model/load.ts';
import type { Anchor, Annotation, AnnotFile, Origin, Rect, Side, TextQuote } from './model/types.ts';

// Annotation operations (spec §9.1): add, edit and rm, applied as one atomic batch. Every
// operation of the UI maps to one of these, so the CLI and the web app share the same rules.

export interface AddOp {
  op: 'add';
  category: string;
  body?: string;
  page?: number;
  /** Quote text, or a full TextQuote with prefix/suffix. */
  quote?: string | TextQuote;
  prefix?: string;
  suffix?: string;
  quads?: Rect[];
  /** Region anchor rectangle (requires page). */
  region?: Rect;
  side?: Side;
  origin?: Origin;
  /** Optional explicit ID. */
  id?: string;
  [key: `x-${string}`]: unknown;
}

export interface EditOp {
  op: 'edit';
  id: string;
  body?: string;
  category?: string;
  side?: Side;
  origin?: Origin;
  reviewed?: boolean;
}

export interface RmOp {
  op: 'rm';
  id: string;
}

export type Op = AddOp | EditOp | RmOp;

export interface OpResult {
  op: Op['op'];
  id: string;
}

export interface ApplyContext {
  /** Page text indexes of the PDF; needed for add ops. */
  indexes: PageIndex[];
  pageCount: number;
  now?: () => Date;
  random?: RandomBytes;
}

export interface OpProblem {
  /** Index of the operation in the batch. */
  index: number;
  code: string;
  message: string;
  candidates?: Candidate[];
}

const SIDES = new Set(['auto', 'left', 'right']);
const ORIGINS = new Set(['human', 'agent']);

function isRect(r: unknown): r is Rect {
  return Array.isArray(r) && r.length === 4 && r.every((v) => typeof v === 'number' && Number.isFinite(v)) && r[0] <= r[2] && r[1] <= r[3];
}

/**
 * Apply operations to a copy of `file`. All operations are validated first; if any fails, nothing
 * is applied and a MarginError with code `ops-invalid` lists every problem in `details`.
 */
export function applyOps(file: AnnotFile, ops: Op[], ctx: ApplyContext): { file: AnnotFile; results: OpResult[] } {
  const next = structuredClone(file);
  const now = isoSeconds((ctx.now ?? (() => new Date()))());
  const random = ctx.random ?? cryptoRandomBytes;
  const categories = new Map(next.categories.map((c) => [c.id, c]));
  const taken = new Set(next.annotations.map((a) => a.id));
  const problems: OpProblem[] = [];
  const results: OpResult[] = [];
  const fail = (index: number, code: string, message: string, candidates?: Candidate[]) => {
    problems.push({ index, code, message, ...(candidates ? { candidates } : {}) });
  };

  ops.forEach((op, index) => {
    if (!op || typeof op !== 'object' || !('op' in op)) return fail(index, 'op-invalid', 'Operation must be an object with an "op" field.');
    if (op.op === 'add') {
      if (!categories.has(op.category)) return fail(index, 'unknown-category', `Unknown category "${op.category}". Known: ${[...categories.keys()].join(', ')}.`);
      if (op.side !== undefined && !SIDES.has(op.side)) return fail(index, 'op-invalid', `side must be auto, left or right.`);
      if (op.origin !== undefined && !ORIGINS.has(op.origin)) return fail(index, 'op-invalid', `origin must be human or agent.`);
      if (op.page !== undefined && (!Number.isInteger(op.page) || op.page < 1 || op.page > ctx.pageCount)) {
        return fail(index, 'page-out-of-range', `Page ${op.page} does not exist (document has ${ctx.pageCount} pages).`);
      }
      if (op.id !== undefined && taken.has(op.id)) return fail(index, 'duplicate-id', `Annotation ${op.id} already exists.`);
      let anchor: Anchor;
      if (op.region) {
        if (!isRect(op.region)) return fail(index, 'op-invalid', 'region must be [x0, y0, x1, y1] with x0 ≤ x1 and y0 ≤ y1.');
        if (op.page === undefined) return fail(index, 'op-invalid', 'A region anchor needs a page.');
        anchor = { type: 'region', page: op.page, rect: op.region };
      } else {
        const quote: TextQuote | undefined =
          typeof op.quote === 'string' ? { exact: op.quote, ...(op.prefix ? { prefix: op.prefix } : {}), ...(op.suffix ? { suffix: op.suffix } : {}) } : op.quote;
        if (!quote?.exact && !op.quads) return fail(index, 'op-invalid', 'An add needs a quote, quads with a page, or a region with a page.');
        if (op.quads && (!op.quads.every(isRect) || op.page === undefined)) return fail(index, 'op-invalid', 'quads must be [x0, y0, x1, y1] rectangles and need a page.');
        anchor = { type: 'text', ...(op.page !== undefined ? { page: op.page } : {}), ...(op.quads ? { quads: op.quads } : {}), ...(quote ? { quote } : {}) };
      }
      const id = op.id ?? newId(taken, random);
      const extra = Object.fromEntries(Object.entries(op).filter(([k]) => k.startsWith('x-')));
      const kind = categories.get(op.category)!.kind;
      const a: Annotation = {
        id,
        category: op.category,
        anchor,
        body: kind === 'highlight' ? '' : (op.body ?? ''),
        side: op.side ?? 'auto',
        origin: op.origin ?? 'agent',
        created: now,
        modified: now,
        ...extra,
      };
      const r = resolveAnnotation(a, ctx.indexes, ctx.pageCount);
      if (r.status === 'unresolved') return fail(index, 'quote-unresolved', `Quote not found${op.page ? ` on page ${op.page}` : ''}: "${anchor.type === 'text' ? anchor.quote?.exact : ''}".`);
      if (r.status === 'ambiguous') {
        return fail(index, 'quote-ambiguous', `Quote occurs ${r.candidates.length} times; add --page, --prefix or --suffix, or quote more text.`, r.candidates);
      }
      taken.add(id);
      next.annotations.push(a);
      results.push({ op: 'add', id });
      return;
    }
    if (op.op === 'edit' || op.op === 'rm') {
      const a = next.annotations.find((x) => x.id === op.id);
      if (!a) return fail(index, 'unknown-id', `No annotation with id ${op.id}.`);
      if (op.op === 'rm') {
        next.annotations = next.annotations.filter((x) => x.id !== op.id);
        taken.delete(op.id);
        results.push({ op: 'rm', id: op.id });
        return;
      }
      if (op.category !== undefined && !categories.has(op.category)) return fail(index, 'unknown-category', `Unknown category "${op.category}".`);
      if (op.side !== undefined && !SIDES.has(op.side)) return fail(index, 'op-invalid', `side must be auto, left or right.`);
      if (op.origin !== undefined && !ORIGINS.has(op.origin)) return fail(index, 'op-invalid', `origin must be human or agent.`);
      if (op.body !== undefined) a.body = op.body;
      if (op.category !== undefined) a.category = op.category;
      if (op.side !== undefined) a.side = op.side;
      if (op.origin !== undefined) a.origin = op.origin;
      if (op.reviewed !== undefined) a.reviewed = op.reviewed;
      if (categories.get(a.category)?.kind === 'highlight') a.body = '';
      a.modified = now;
      results.push({ op: 'edit', id: op.id });
      return;
    }
    fail(index, 'op-invalid', `Unknown op "${(op as { op: unknown }).op}"; expected add, edit or rm.`);
  });

  if (problems.length > 0) {
    const first = problems[0]!;
    const message =
      ops.length === 1 ? first.message : `${problems.length} of ${ops.length} operations are invalid; nothing was applied. First: #${first.index}: ${first.message}`;
    throw new MarginError(ops.length === 1 ? first.code : 'ops-invalid', message, { details: problems });
  }
  return { file: next, results };
}
