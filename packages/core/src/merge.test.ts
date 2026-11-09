import { describe, expect, it } from 'vitest';
import { createAnnotFile } from './model/load.ts';
import type { Annotation, AnnotFile } from './model/types.ts';
import { describeMerge, mergeExternal } from './merge.ts';

const ann = (id: string, body: string, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  category: 'error',
  anchor: { type: 'text', page: 1, quote: { exact: id } },
  body,
  side: 'auto',
  origin: 'human',
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
  ...extra,
});

const file = (...annotations: Annotation[]): AnnotFile => ({
  ...createAnnotFile({ fileName: 'p.pdf', sha256: 'x'.repeat(64), pageCount: 1, pages: [{ width: 100, height: 100 }] }),
  annotations,
});

describe('mergeExternal', () => {
  const base = file(ann('a', 'one'), ann('b', 'two'));

  it('takes disk-only changes: additions, edits, removals', () => {
    const disk = file(ann('a', 'one!'), ann('c', 'new', { origin: 'agent' }));
    const r = mergeExternal(base, base, disk);
    expect(r.file.annotations.map((a) => [a.id, a.body])).toEqual([['a', 'one!'], ['c', 'new']]);
    expect(r.conflicts).toEqual([]);
    expect(r.summary).toEqual({ added: ['c'], edited: ['a'], removed: ['b'] });
    expect(describeMerge(r.summary)).toBe('+1 comment, 1 edited, 1 removed');
  });

  it('keeps local-only changes, including additions the disk does not have yet', () => {
    const local = file(ann('a', 'mine'), ann('b', 'two'), ann('z', 'local add'));
    const r = mergeExternal(base, local, base);
    expect(r.changed).toBe(false);
    expect(r.file).toBe(local);
  });

  it('merges disjoint local and disk changes without conflict', () => {
    const local = file(ann('a', 'mine'), ann('b', 'two'));
    const disk = file(ann('a', 'one'), ann('b', 'theirs'));
    const r = mergeExternal(base, local, disk);
    expect(r.file.annotations.map((a) => a.body)).toEqual(['mine', 'theirs']);
    expect(r.conflicts).toEqual([]);
  });

  it('lets the disk win when both changed one annotation and keeps the local version', () => {
    const local = file(ann('a', 'mine'), ann('b', 'two'));
    const disk = file(ann('a', 'theirs'), ann('b', 'two'));
    const r = mergeExternal(base, local, disk);
    expect(r.file.annotations[0]!.body).toBe('theirs');
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ id: 'a', local: { body: 'mine' }, disk: { body: 'theirs' } });
  });

  it('reports a local edit against a disk deletion, and the reverse', () => {
    const r = mergeExternal(base, file(ann('a', 'mine'), ann('b', 'two')), file(ann('b', 'two')));
    expect(r.file.annotations.map((a) => a.id)).toEqual(['b']);
    expect(r.conflicts).toEqual([{ id: 'a', local: expect.objectContaining({ body: 'mine' }), disk: null }]);
    const r2 = mergeExternal(base, file(ann('b', 'two')), file(ann('a', 'theirs'), ann('b', 'two')));
    expect(r2.file.annotations.map((a) => a.body)).toEqual(['theirs', 'two']);
    expect(r2.conflicts).toEqual([{ id: 'a', local: null, disk: expect.objectContaining({ body: 'theirs' }) }]);
  });

  it('is no conflict when both sides made the same change', () => {
    const same = file(ann('a', 'same'), ann('b', 'two'));
    expect(mergeExternal(base, same, same).conflicts).toEqual([]);
  });

  it('takes categories and settings from the disk when it changed them', () => {
    const disk = file(...base.annotations);
    disk.settings = { ...disk.settings, fontSize: 11 };
    expect(mergeExternal(base, base, disk).file.settings.fontSize).toBe(11);
    const local = file(...base.annotations);
    local.settings = { ...local.settings, marginWidth: 120 };
    const r = mergeExternal(base, local, base);
    expect(r.file.settings.marginWidth).toBe(120);
  });

  it('preserves unknown fields', () => {
    const disk = file(ann('a', 'one', { 'x-agent': { run: 7 } }), ann('b', 'two'));
    const r = mergeExternal(base, base, disk);
    expect(r.file.annotations[0]!['x-agent']).toEqual({ run: 7 });
  });
});
