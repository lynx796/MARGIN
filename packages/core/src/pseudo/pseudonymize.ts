import { MarginError } from '../errors.ts';
import { sha256Hex } from '../hash.ts';
import type { AnnotFile } from '../model/types.ts';
import { PdfDoc } from '../pdf/document.ts';
import type { PageText } from '../pdf/extract.ts';
import type { FontSet } from '../text/fonts.ts';
import { createPseudoMap, pseudonymizeAnnotations, type PseudoMap } from './mapping.ts';
import { substituteTerms, type TermMatch } from './match.ts';
import { redactPdf } from './redact.ts';
import type { TermGroup } from './terms.ts';
import { verifyRedaction } from './verify.ts';

// Pseudonymization end to end (spec §10), shared by `margin pseudonymize` and the web app:
// redact, verify (aborting on any finding), and derive the mapping and annotation files.

export interface PseudonymizeInput {
  pdfBytes: Uint8Array;
  fileName: string;
  groups: TermGroup[];
  fonts: FontSet;
  /** The original's annotation file, if any: copied with tokens substituted. */
  annotations?: AnnotFile;
  random?: (n: number) => Uint8Array;
}

export interface PseudonymizeOutput {
  bytes: Uint8Array;
  /** Token-substituted input name with `.pseudo.pdf`. */
  fileName: string;
  map: PseudoMap;
  annotations?: AnnotFile;
  matches: TermMatch[];
  scrubbed: string[];
}

/** `Müller-thesis.pdf` → `AUTHOR_1-thesis.pseudo.pdf` (tokens without brackets: they are shell glob characters). */
export function pseudoFileName(fileName: string, groups: TermGroup[]): string {
  const base = fileName.replace(/\.pdf$/i, '');
  return substituteTerms(base, groups, (t) => t) + '.pseudo.pdf';
}

export async function pseudonymize(o: PseudonymizeInput): Promise<PseudonymizeOutput> {
  if (o.groups.length === 0) throw new MarginError('terms-invalid', 'No term groups given.');
  const doc = await PdfDoc.open(o.pdfBytes);
  let texts: PageText[];
  try {
    texts = await doc.allText();
  } finally {
    await doc.destroy();
  }
  const result = await redactPdf({ pdfBytes: o.pdfBytes, texts, groups: o.groups, fonts: o.fonts, ...(o.random ? { random: o.random } : {}) });
  const problems = await verifyRedaction(result.bytes, o.groups);
  if (problems.length) {
    throw new MarginError('redaction-failed', `Verification failed; nothing was written. ${problems[0]!.message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`, { path: problems[0]!.path, details: problems });
  }
  const fileName = pseudoFileName(o.fileName, o.groups);
  const redacted = await PdfDoc.open(result.bytes);
  const info = redacted.info(fileName);
  await redacted.destroy();
  const map = createPseudoMap(await sha256Hex(o.pdfBytes), info.sha256, o.groups);
  return {
    bytes: result.bytes,
    fileName,
    map,
    ...(o.annotations ? { annotations: pseudonymizeAnnotations(o.annotations, o.groups, info) } : {}),
    matches: result.matches,
    scrubbed: result.scrubbed,
  };
}

export interface TermSuggestion {
  kind: 'title-block' | 'email' | 'student-id' | 'after-keyword';
  text: string;
  page: number;
}

/** OT1 typesets accents as separate glyphs before the letter ("M¨uller"); compose them ("Müller"). */
const ACCENTS: Record<string, string> = { '¨': '̈', '´': '́', '`': '̀', 'ˆ': '̂', '˜': '̃', '¯': '̄', '˘': '̆', '˙': '̇', '˚': '̊', '˝': '̋', 'ˇ': '̌', '¸': '̧', '˛': '̨' };
export function composeAccents(s: string): string {
  return s.replace(/([¨´`ˆ˜¯˘˙˚˝ˇ¸˛])(\p{L})/gu, (_, a: string, l: string) => l + ACCENTS[a]!).normalize('NFC');
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** ETH Legi (12-345-678) and plain 6–9 digit matriculation numbers. */
const STUDENT_ID = /\b\d{2}-\d{3}-\d{3}\b|\b\d{6,9}\b/g;
/** Up to four capitalized words or initials after a keyword, on the same line. */
const KEYWORD = /\b(?:by|[Aa]uthors?|[Nn]ame|[Vv]on|[Ss]tudent(?:in)?)[ \t]*:?[ \t]+((?:\p{Lu}\.|\p{Lu}[\p{L}'’-]+)(?:[ \t]+(?:\p{Lu}\.|\p{Lu}[\p{L}'’-]+)){0,3})/gu;
const HEADING = /^(?:\d+(?:\.\d+)*\s+\p{L}|(?:Abstract|Zusammenfassung|Introduction|Einleitung|Contents|Inhalt)\b)/u;

/**
 * Candidates for term groups (§10.1), never applied without confirmation: the title block of
 * page 1 (after the title, up to the first heading or full body line), e-mail addresses,
 * student-ID patterns and capitalized words after "by", "Author", "Name".
 */
export function suggestTerms(texts: PageText[]): TermSuggestion[] {
  const out: TermSuggestion[] = [];
  const add = (s: TermSuggestion) => {
    const text = composeAccents(s.text).replace(/\s+/g, ' ').trim();
    if (text.length > 1 && !out.some((o) => o.kind === s.kind && o.text === text)) out.push({ ...s, text });
  };
  const first = texts[0];
  if (first && first.lines.length) {
    // Body size: the font size covering the most text on the page.
    const weight = new Map<number, number>();
    for (const l of first.lines) weight.set(l.fontSize, (weight.get(l.fontSize) ?? 0) + l.end - l.start);
    const body = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
    for (const [i, l] of first.lines.entries()) {
      const t = first.text.slice(l.start, l.end);
      if (i > 0 && (HEADING.test(t) || (Math.abs(l.fontSize - body) < 0.3 && t.length > 50))) break;
      if (i > 0) for (const part of t.split(/[∗*†‡§¶]|\s{2,}|\s+(?:and|und)\s+|,\s*/)) add({ kind: 'title-block', text: part, page: 1 });
    }
  }
  for (const p of texts) {
    const text = composeAccents(p.text).replace(/(\p{L})-\n(\p{L})/gu, '$1$2');
    for (const m of text.matchAll(EMAIL)) add({ kind: 'email', text: m[0], page: p.page });
    for (const m of text.matchAll(STUDENT_ID)) add({ kind: 'student-id', text: m[0], page: p.page });
    for (const m of text.matchAll(KEYWORD)) add({ kind: 'after-keyword', text: m[1]!, page: p.page });
  }
  return out;
}
