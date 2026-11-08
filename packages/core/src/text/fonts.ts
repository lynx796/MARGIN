import fontkit from '@cantoo/fontkit';
import type { Font } from '@cantoo/fontkit';
import { MarginError } from '../errors.ts';
import type { FontKey } from '../layout/types.ts';

// Font metrics for comment text (spec §6.2): widths from the font files via fontkit, kerning on,
// ligatures off. Never measured via the DOM. The same bytes are embedded by render-pdf.

export type FontBytes = Record<FontKey, Uint8Array>;

/** Features applied in layout and export: kerning on, ligatures off. */
export const FONT_FEATURES = { liga: false, clig: false, dlig: false, calt: false, kern: true } as const;

export interface Shaped {
  /** Code points of the text, one advance each. */
  advances: number[];
  width: number;
}

export class FontSet {
  readonly bytes: FontBytes;
  private readonly fonts: Record<FontKey, Font>;
  private readonly cache = new Map<string, Shaped>();

  constructor(bytes: FontBytes) {
    this.bytes = bytes;
    const load = (key: FontKey): Font => {
      const b = bytes[key];
      if (!b) throw new MarginError('font-missing', `Font "${key}" was not provided.`);
      const f = fontkit.create(b);
      if (!('layout' in f)) throw new MarginError('font-invalid', `Font "${key}" is a font collection, not a single font.`);
      return f;
    };
    this.fonts = { sans: load('sans'), 'sans-italic': load('sans-italic'), 'sans-bold': load('sans-bold'), 'sans-bolditalic': load('sans-bolditalic'), mono: load('mono') };
  }

  /**
   * Shape `text` at 1 pt: per-code-point advances including kerning. Glyphs map one-to-one to
   * code points because ligatures are off; where a font still merges code points, the merged
   * advance is assigned to the first and zeros to the rest.
   */
  shape1(font: FontKey, text: string): Shaped {
    const key = font + '\u0000' + text;
    let hit = this.cache.get(key);
    if (hit) return hit;
    const f = this.fonts[font];
    const run = f.layout(text, FONT_FEATURES as never);
    const cps = Array.from(text);
    const advances = new Array<number>(cps.length).fill(0);
    // Map glyphs to code point indices via their cluster code points.
    let cp = 0;
    run.glyphs.forEach((g, i) => {
      const adv = (run.positions?.[i]?.xAdvance ?? g.advanceWidth) / f.unitsPerEm;
      if (cp < advances.length) advances[cp] = (advances[cp] ?? 0) + adv;
      cp += Math.max(1, g.codePoints.length);
    });
    hit = { advances, width: advances.reduce((a, b) => a + b, 0) };
    this.cache.set(key, hit);
    return hit;
  }

  shape(font: FontKey, text: string, size: number): Shaped {
    const s = this.shape1(font, text);
    return { advances: s.advances.map((a) => a * size), width: s.width * size };
  }

  width(font: FontKey, text: string, size: number): number {
    return this.shape1(font, text).width * size;
  }

  /** Ascender and descender as fractions of the font size (positive numbers). */
  metrics(font: FontKey): { ascent: number; descent: number } {
    const f = this.fonts[font];
    return { ascent: f.ascent / f.unitsPerEm, descent: -f.descent / f.unitsPerEm };
  }
}
