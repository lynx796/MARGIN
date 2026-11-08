import { FontSet, type FontBytes } from '@margin/core';
import sans from '../../../../fonts/FiraSans-Regular.ttf?url';
import sansItalic from '../../../../fonts/FiraSans-Italic.ttf?url';
import sansBold from '../../../../fonts/FiraSans-SemiBold.ttf?url';
import sansBoldItalic from '../../../../fonts/FiraSans-SemiBoldItalic.ttf?url';
import mono from '../../../../fonts/FiraMono-Regular.ttf?url';

let bytes: Promise<FontBytes> | undefined;

/** Raw font files (embedded into exports, measured by the layout engine). */
export function loadFontBytes(): Promise<FontBytes> {
  bytes ??= (async () => {
    const get = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
    const [a, b, c, d, e] = await Promise.all([sans, sansItalic, sansBold, sansBoldItalic, mono].map(get));
    return { sans: a!, 'sans-italic': b!, 'sans-bold': c!, 'sans-bolditalic': d!, mono: e! };
  })();
  return bytes;
}

export async function loadFonts(): Promise<FontSet> {
  return new FontSet(await loadFontBytes());
}
