import { describe, expect, it } from 'vitest';
import { createAnnotFile } from '../model/load.ts';
import { pseudonymizeAnnotations } from './mapping.ts';
import { parseTerms } from './terms.ts';

describe('pseudonymizeAnnotations', () => {
  const groups = parseTerms('AUTHOR_1: Anna Müller | Müller');
  const doc = { fileName: 'Müller.pdf', sha256: 'a'.repeat(64), pageCount: 1, pages: [{ width: 595, height: 842 }] };
  const redacted = { ...doc, fileName: 'AUTHOR_1.pseudo.pdf', sha256: 'b'.repeat(64) };

  it('substitutes terms everywhere text can hide, including unknown and x-* fields', () => {
    const file = createAnnotFile(doc);
    file['x-agent'] = { notes: ['Müller writes well'] };
    file.report = { fileName: 'report-Müller.pdf', sha256: 'c'.repeat(64), position: 'before' };
    file.annotations.push({
      id: 'k3f9qd',
      category: file.categories[0]!.id,
      body: 'Anna Müller: see p. 2',
      anchor: { type: 'text', page: 1, quote: { exact: 'by Anna Müller' } },
      side: 'auto',
      origin: 'agent',
      'x-why': 'Müller',
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-01T00:00:00Z',
    });
    const out = pseudonymizeAnnotations(file, groups, redacted);
    const text = JSON.stringify(out);
    expect(text).not.toContain('Müller');
    expect(out['x-agent']).toEqual({ notes: ['[AUTHOR_1] writes well'] });
    expect(out.report).toBeUndefined();
    expect(out.document).toEqual(redacted);
    expect(out.annotations[0]!.body).toBe('[AUTHOR_1]: see p. 2');
    expect(out.format).toBe(file.format);
    expect(out.settings).toEqual(file.settings);
  });
});
