import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generate } from '../../../../scripts/build-validator.ts';

describe('generated validator', () => {
  it('is up to date with schema/annot.schema.json (run pnpm validator:build)', () => {
    const committed = readFileSync(new URL('./validator.generated.js', import.meta.url), 'utf8');
    expect(committed).toBe(generate());
  });

  it('contains no runtime code generation', () => {
    const code = readFileSync(new URL('./validator.generated.js', import.meta.url), 'utf8');
    expect(code).not.toMatch(/new Function|\beval\(|require\(/);
  });
});
