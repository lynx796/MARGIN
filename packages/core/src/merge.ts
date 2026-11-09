import type { Annotation, AnnotFile } from './model/types.ts';

// Merging an externally changed annotation file into the one being edited (spec §9.3). Three
// versions take part: `base`, the file as last synchronized with the disk; `local`, what the user
// has now; `disk`, what the disk has now. Annotations are merged one by one by ID.

/** An annotation changed both locally and on disk: the disk version won, the local one is kept here. */
export interface Conflict {
  id: string;
  /** The local version that lost; null if it had been deleted locally. */
  local: Annotation | null;
  /** The disk version that won; null if it was deleted on disk. */
  disk: Annotation | null;
}

export interface MergeSummary {
  added: string[];
  edited: string[];
  removed: string[];
}

export interface MergeResult {
  file: AnnotFile;
  conflicts: Conflict[];
  /** What the disk changed in the local file, for the undo step's label. */
  summary: MergeSummary;
  /** False if the merge left the local file as it was. */
  changed: boolean;
}

/** JSON with sorted keys, so structurally equal values compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/**
 * Three-way merge by annotation ID. A side that changed alone wins; if both changed, the disk wins
 * and the local version is reported as a conflict, unless both ended up identical. Everything that
 * is not an annotation (categories, settings, document, unknown fields) is taken from the disk if
 * the disk changed it, else from local.
 */
export function mergeExternal(base: AnnotFile, local: AnnotFile, disk: AnnotFile): MergeResult {
  const byId = (f: AnnotFile) => new Map(f.annotations.map((a) => [a.id, a]));
  const b = byId(base);
  const l = byId(local);
  const d = byId(disk);
  const conflicts: Conflict[] = [];
  const summary: MergeSummary = { added: [], edited: [], removed: [] };
  const merged: Annotation[] = [];

  const pick = (id: string): Annotation | undefined => {
    const bv = b.get(id);
    const lv = l.get(id);
    const dv = d.get(id);
    const localChanged = !sameValue(bv, lv);
    const diskChanged = !sameValue(bv, dv);
    if (diskChanged && localChanged && !sameValue(lv, dv)) conflicts.push({ id, local: lv ?? null, disk: dv ?? null });
    const winner = diskChanged ? dv : lv;
    if (diskChanged && !sameValue(winner, lv)) {
      (winner === undefined ? summary.removed : lv === undefined ? summary.added : summary.edited).push(id);
    }
    return winner;
  };

  for (const a of disk.annotations) {
    const w = pick(a.id);
    if (w) merged.push(w);
  }
  // Annotations the disk does not have: locally added, or removed on disk.
  for (const a of local.annotations) {
    if (d.has(a.id)) continue;
    const w = pick(a.id);
    if (w) merged.push(w);
  }

  const rest = (key: keyof AnnotFile | string): unknown => {
    const same = sameValue((base as Record<string, unknown>)[key], (disk as Record<string, unknown>)[key]);
    return same ? (local as Record<string, unknown>)[key] : (disk as Record<string, unknown>)[key];
  };
  const keys = new Set([...Object.keys(local), ...Object.keys(disk)]);
  keys.delete('annotations');
  const file = { annotations: merged } as Record<string, unknown>;
  for (const k of keys) {
    const v = rest(k);
    if (v !== undefined) file[k] = v;
  }
  const result = file as unknown as AnnotFile;
  const changed = !sameValue(result, local);
  return { file: changed ? result : local, conflicts, summary, changed };
}

/** One-line description of a merge, e.g. "agent: +3 comments, 1 edited". */
export function describeMerge(s: MergeSummary): string {
  const parts = [
    s.added.length ? `+${s.added.length} comment${s.added.length > 1 ? 's' : ''}` : '',
    s.edited.length ? `${s.edited.length} edited` : '',
    s.removed.length ? `${s.removed.length} removed` : '',
  ].filter(Boolean);
  return parts.join(', ') || 'no changes';
}
