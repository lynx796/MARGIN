import { describe, expect, it } from 'vitest';
import type { PageText } from '@margin/core';
import { caretAt, mostlySymbols, rangeBetween, textAnchorFor } from './selection.ts';

// Two lines "ab cd" / "ef", 10 pt per character, lines 12 pt high.
function page(): PageText {
  const text = 'ab cd\nef';
  const boxes: PageText['boxes'] = [];
  const lineOf: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const line = i < 6 ? 0 : 1;
    const col = line === 0 ? i : i - 6;
    boxes.push(text[i] === '\n' ? [50, 0, 50, 12] : [col * 10, line * 20, col * 10 + 10, line * 20 + 12]);
    lineOf.push(line);
  }
  return {
    page: 1,
    text,
    boxes,
    lineOf,
    lines: [
      { start: 0, end: 5, box: [0, 0, 50, 12], baseline: 9, fontSize: 10 },
      { start: 6, end: 8, box: [0, 20, 20, 32], baseline: 29, fontSize: 10 },
    ],
  };
}

describe('selection', () => {
  it('finds the caret nearest a point', () => {
    const t = page();
    expect(caretAt(t, 4, 5)).toBe(0);
    expect(caretAt(t, 16, 5)).toBe(2);
    expect(caretAt(t, 999, 5)).toBe(5);
    expect(caretAt(t, 12, 28)).toBe(7);
    // Between lines: nearest line wins.
    expect(caretAt(t, 4, 17)).toBe(6);
  });

  it('trims whitespace and returns null for empty selections', () => {
    const t = page();
    expect(rangeBetween(t, 2, 8)).toEqual([3, 8]);
    expect(rangeBetween(t, 8, 3)).toEqual([3, 8]);
    expect(rangeBetween(t, 2, 3)).toBeNull();
    expect(rangeBetween(t, 4, 4)).toBeNull();
  });

  it('builds a text anchor with one quad per line and a quote', () => {
    const t = page();
    const a = textAnchorFor(t, 3, 8);
    expect(a.page).toBe(1);
    expect(a.quads).toHaveLength(2);
    expect(a.quote?.exact).toBe('cd ef');
  });

  it('detects mostly non-alphanumeric selections', () => {
    expect(mostlySymbols('∑ ≥ ∫ 1')).toBe(true);
    expect(mostlySymbols('the map f')).toBe(false);
  });
});
