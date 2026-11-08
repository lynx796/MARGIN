// Comment markup (spec §6.1): a deliberately small grammar.
//
//   \( … \)     inline math            **…**  bold        `…`  monospace
//   \[ … \]     display math           *…*    italic      \ref{id}  cross-reference
//   newline     line break             blank line  new paragraph
//   \\  \*  \`  escapes
//
// Anything else is literal text. Unclosed delimiters are literal too, so every input parses.

export interface Style {
  bold: boolean;
  italic: boolean;
  mono: boolean;
}

export type Inline =
  | { kind: 'text'; text: string; style: Style }
  | { kind: 'math'; tex: string }
  | { kind: 'ref'; id: string; style: Style };

export type Block =
  | { kind: 'line'; items: Inline[] }
  | { kind: 'display'; tex: string };

/** A paragraph is a list of blocks: lines (separated by hard breaks) and display math. */
export type Paragraph = Block[];

const PLAIN: Style = { bold: false, italic: false, mono: false };

function findUnescaped(s: string, needle: string, from: number): number {
  for (let i = from; i <= s.length - needle.length; i++) {
    if (s[i] === '\\' && needle !== '\\)' && needle !== '\\]') {
      i++;
      continue;
    }
    if (s.startsWith(needle, i)) return i;
  }
  return -1;
}

/** Parse one paragraph's source (no blank lines inside) into blocks. */
function parseParagraph(src: string): Paragraph {
  const blocks: Block[] = [];
  let items: Inline[] = [];
  let style: Style = { ...PLAIN };
  let buf = '';

  const flushText = () => {
    if (buf) items.push({ kind: 'text', text: buf, style: { ...style } });
    buf = '';
  };
  const endLine = (force: boolean) => {
    flushText();
    if (items.length > 0 || force) blocks.push({ kind: 'line', items });
    items = [];
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const rest = src.slice(i);
    if (c === '\n') {
      endLine(true);
      i++;
      continue;
    }
    if (c === '\\') {
      const next = src[i + 1];
      if (next === '(' || next === '[') {
        const close = next === '(' ? '\\)' : '\\]';
        const end = src.indexOf(close, i + 2);
        if (end >= 0) {
          const tex = src.slice(i + 2, end);
          if (next === '(') {
            flushText();
            items.push({ kind: 'math', tex });
          } else {
            endLine(false);
            blocks.push({ kind: 'display', tex: tex.trim() });
          }
          i = end + 2;
          // A newline right after display math does not add an empty line.
          if (next === '[' && src[i] === '\n') i++;
          continue;
        }
      }
      const ref = /^\\ref\{([^{}\s]*)\}/.exec(rest);
      if (ref) {
        flushText();
        items.push({ kind: 'ref', id: ref[1]!, style: { ...style } });
        i += ref[0].length;
        continue;
      }
      if (next === '\\' || next === '*' || next === '`') {
        buf += next;
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '`' && !style.mono) {
      const end = findUnescaped(src, '`', i + 1);
      if (end > i + 1 && !src.slice(i + 1, end).includes('\n')) {
        flushText();
        const text = src.slice(i + 1, end).replace(/\\([\\*`])/g, '$1');
        items.push({ kind: 'text', text, style: { ...style, mono: true } });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith('**')) {
      if (style.bold || findUnescaped(src, '**', i + 2) > i + 2) {
        flushText();
        style = { ...style, bold: !style.bold };
        i += 2;
        continue;
      }
    } else if (c === '*') {
      const close = findSingleStar(src, i + 1);
      if (style.italic || close > i + 1) {
        flushText();
        style = { ...style, italic: !style.italic };
        i++;
        continue;
      }
    }
    buf += c;
    i++;
  }
  endLine(false);
  return blocks;
}

/** Next `*` that is not part of `**` and not escaped. */
function findSingleStar(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '*') {
      if (s[i + 1] === '*') {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** Parse a comment body into paragraphs. */
export function parseMarkup(body: string): Paragraph[] {
  const normalized = body.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/\n{2,}/)
    .map(parseParagraph)
    .filter((p) => p.length > 0);
}

/** All TeX sources in a body, for prefetching math (inline and display). */
export function mathSources(body: string): { tex: string; display: boolean }[] {
  const out: { tex: string; display: boolean }[] = [];
  for (const para of parseMarkup(body)) {
    for (const block of para) {
      if (block.kind === 'display') out.push({ tex: block.tex, display: true });
      else for (const item of block.items) if (item.kind === 'math') out.push({ tex: item.tex, display: false });
    }
  }
  return out;
}

/** IDs referenced via \ref{…}. */
export function refIds(body: string): string[] {
  return [...body.matchAll(/\\ref\{([^{}\s]*)\}/g)].map((m) => m[1]!);
}
