import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createAnnotFile, newId, parseAnnotFile, seededRandomBytes, serialize, ID_PATTERN, type AnnotFile } from './index.ts';

const doc = { fileName: 'paper.pdf', sha256: 'a'.repeat(64), pageCount: 2, pages: [{ width: 595.28, height: 841.89 }, { width: 595.28, height: 841.89 }] };
const pinned = { now: () => new Date('2026-11-12T14:03:11.123Z'), random: seededRandomBytes(42) };

function minimal(): string {
  const f = createAnnotFile(doc) as AnnotFile & { annotations: unknown[] };
  f.annotations.push({ category: 'error', body: 'b', anchor: { page: 2, quote: { exact: 'is continuous on' } }, 'x-agent': { run: 7 } });
  f.annotations.push({ id: 'k3f9qd', category: 'typo', body: '', anchor: { type: 'text', page: 1, quads: [[72.1, 410.2, 301.7, 421]] }, created: '2026-11-01T00:00:00Z' });
  return JSON.stringify(f);
}

describe('model', () => {
  it('generates 6-char base32 ids that avoid collisions', () => {
    const random = seededRandomBytes(1);
    const taken = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = newId(taken, random);
      expect(id).toMatch(ID_PATTERN);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });

  it('fills ids, timestamps and defaults on load', () => {
    const f = parseAnnotFile(minimal(), pinned);
    const added = f.annotations.find((a) => a.category === 'error')!;
    expect(added.id).toMatch(ID_PATTERN);
    expect(added.created).toBe('2026-11-12T14:03:11Z');
    expect(added.side).toBe('auto');
    expect(added.origin).toBe('human');
    expect(added.anchor.type).toBe('text');
    expect(f.settings.leaderStyle).toBe('full');
    const kept = f.annotations.find((a) => a.id === 'k3f9qd')!;
    expect(kept.modified).toBe('2026-11-01T00:00:00Z');
  });

  it('serializes canonically, sorted by page/y/x, preserving unknown fields', () => {
    const text = serialize(parseAnnotFile(minimal(), pinned));
    const again = serialize(parseAnnotFile(text, pinned));
    expect(again).toBe(text);
    expect(text.indexOf('k3f9qd')).toBeLessThan(text.indexOf('is continuous on'));
    expect(text).toContain('"x-agent": { "run": 7 }');
    expect(text).toContain('"quads": [[72.1, 410.2, 301.7, 421]]');
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('rejects invalid files with structured errors', () => {
    expect(() => parseAnnotFile('{')).toThrowError(expect.objectContaining({ code: 'json-syntax' }));
    const bad = JSON.parse(minimal());
    bad.annotations[0].anchor = { page: 1 };
    bad.annotations[1].side = 'middle';
    try {
      parseAnnotFile(JSON.stringify(bad));
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe('schema');
      const paths = ((e as { details: { path: string }[] }).details).map((d) => d.path);
      expect(paths).toContain('/annotations/1/side');
    }
  });

  it('rejects duplicate ids', () => {
    const f = JSON.parse(minimal());
    f.annotations[0].id = 'k3f9qd';
    expect(() => parseAnnotFile(JSON.stringify(f))).toThrowError(expect.objectContaining({ code: 'duplicate-id' }));
  });

  it('round-trips arbitrary extra metadata byte-identically', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }).map((s) => 'x-' + s), fc.jsonValue()), (extra) => {
        const f = JSON.parse(minimal());
        Object.assign(f.annotations[1], extra);
        const once = serialize(parseAnnotFile(JSON.stringify(f), pinned));
        expect(serialize(parseAnnotFile(once, pinned))).toBe(once);
      }),
      { numRuns: 100 },
    );
  });
});
