import type { Problem } from './errors.ts';
import type { Diagnostics } from './layout/engine.ts';
import type { AnnotFile } from './model/types.ts';

// `margin check` (spec §9.1): unresolved anchors, unknown categories, math errors, dangling
// \ref, overflowed pages, and a PDF that does not match the annotation file.

export function checkFile(file: AnnotFile, opts: { pdfSha256?: string; diagnostics?: Diagnostics }): Problem[] {
  const problems: Problem[] = [];
  if (opts.pdfSha256 && opts.pdfSha256 !== file.document.sha256) {
    problems.push({ code: 'pdf-mismatch', severity: 'error', path: '/document/sha256', message: 'The PDF does not match the annotation file (sha256 differs). Run margin resolve to re-anchor by quote.' });
  }
  const categories = new Set(file.categories.map((c) => c.id));
  const index = new Map(file.annotations.map((a, i) => [a.id, i]));
  const path = (id: string, field = '') => `/annotations/${index.get(id)}${field}`;
  for (const a of file.annotations) {
    if (!categories.has(a.category)) {
      problems.push({ code: 'unknown-category', severity: 'error', path: path(a.id, '/category'), message: `${a.id}: unknown category "${a.category}".` });
    }
    if (a.anchor.page !== undefined && a.anchor.page > file.document.pageCount) {
      problems.push({ code: 'page-out-of-range', severity: 'error', path: path(a.id, '/anchor/page'), message: `${a.id}: page ${a.anchor.page} does not exist.` });
    }
    if (a.status === 'unresolved' || a.status === 'ambiguous') {
      const quote = a.anchor.type === 'text' ? a.anchor.quote?.exact : undefined;
      problems.push({ code: `anchor-${a.status}`, severity: 'error', path: path(a.id, '/anchor'), message: `${a.id}: anchor is ${a.status}${quote ? ` ("${quote}")` : ''}.` });
    } else if (a.anchor.type === 'text' && (!a.anchor.quads || a.anchor.page === undefined)) {
      problems.push({ code: 'anchor-unresolved', severity: 'error', path: path(a.id, '/anchor'), message: `${a.id}: anchor has no geometry yet; run margin resolve.` });
    }
  }
  const d = opts.diagnostics;
  if (d) {
    for (const e of d.mathErrors) problems.push({ code: 'math-error', severity: 'error', path: path(e.id, '/body'), message: `${e.id}: TeX error: ${e.message}` });
    for (const r of d.danglingRefs) problems.push({ code: 'dangling-ref', severity: 'error', path: path(r.id, '/body'), message: `${r.id}: \\ref{${r.target}} points to no comment.` });
    for (const o of d.overflow) problems.push({ code: 'overflow', severity: 'warning', path: `/pages/${o.page}`, message: `Page ${o.page}: comments do not fit the margins (${o.ids.join(', ')}).` });
  }
  return problems;
}
