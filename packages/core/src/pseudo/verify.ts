import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFObject } from '@cantoo/pdf-lib';
import { normalizeQuote } from '../anchor/normalize.ts';
import { PageIndex } from '../anchor/resolve.ts';
import type { Problem } from '../errors.ts';
import { PdfDoc } from '../pdf/document.ts';
import { matchRanges } from './match.ts';
import { isRegexVariant, variantRegExp, type TermGroup } from './terms.ts';

// Verification (spec §10.4): the redacted PDF is loaded again and checked independently of how it
// was made. Page text must contain no term, also approximately (edit distance as in §9.2); the
// scrubbed locations must be empty; and no term may appear in the raw file or any decoded stream,
// in Latin-1, UTF-8 or UTF-16 form. Every finding is a problem with its location.

const leak = (path: string, message: string): Problem => ({ code: 'term-leak', severity: 'error', path, message });

function asText(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;
}

/** Lower-cased forms in which a literal variant could be stored. */
function spellings(v: string): string[] {
  const lower = v.toLowerCase();
  return [...new Set([lower, lower.normalize('NFC'), lower.normalize('NFD'), normalizeQuote(v).toLowerCase()])].filter((s) => s.length > 0);
}

function encodings(s: string): string[] {
  const utf8 = Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join('');
  const utf16 = Array.from(s, (c) => '\0' + c).join('');
  return [...new Set([s, utf8, utf16])];
}

/** Occurrences of literal terms (whole words) and regexes in a Latin-1 view of bytes. */
function rawHits(latin1: string, groups: TermGroup[]): string[] {
  const hay = latin1.toLowerCase();
  const out: string[] = [];
  for (const g of groups) {
    for (const v of g.variants) {
      if (isRegexVariant(v)) {
        const m = latin1.match(variantRegExp(v));
        if (m) out.push(`${g.token} (${JSON.stringify(m[0])})`);
        continue;
      }
      for (const form of spellings(v).flatMap(encodings)) {
        for (let at = hay.indexOf(form); at >= 0; at = hay.indexOf(form, at + 1)) {
          const before = hay[at - 1] ?? ' ';
          const after = hay[at + form.length] ?? ' ';
          if (!/[a-z0-9À-ɏ]/.test(before) && !/[a-z0-9À-ɏ]/.test(after)) {
            out.push(`${g.token} (${JSON.stringify(v)})`);
            break;
          }
        }
      }
    }
  }
  return [...new Set(out)];
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export async function verifyRedaction(bytes: Uint8Array, groups: TermGroup[]): Promise<Problem[]> {
  const problems: Problem[] = [];

  // 1. Page text: exact (whole-word) matches, then approximate ones of the literal variants.
  const doc = await PdfDoc.open(bytes);
  try {
    for (const page of await doc.allText()) {
      for (const r of matchRanges(page.text, groups)) {
        problems.push(leak(`/pages/${page.page}`, `Page ${page.page}: "${page.text.slice(r.start, r.end)}" (${r.token}) is still in the text.`));
      }
      const lowered = page.text.toLowerCase();
      if (lowered.length !== page.text.length) continue;
      const index = new PageIndex({ ...page, text: lowered });
      for (const g of groups) {
        for (const v of g.variants.filter((x) => !isRegexVariant(x))) {
          for (const m of index.findFuzzy(normalizeQuote(v).toLowerCase())) {
            problems.push(leak(`/pages/${page.page}`, `Page ${page.page}: "${page.text.slice(m.start, m.end)}" is close to ${g.token} ("${v}").`));
          }
        }
      }
    }
  } finally {
    await doc.destroy();
  }

  // 2. Scrubbed locations.
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = pdf.context;
  const info = ctx.lookup(ctx.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const [k, v] of info.entries()) {
      if (k.decodeText() !== 'Title') problems.push(leak(`/Info/${k.decodeText()}`, `Document info still has ${k.decodeText()}.`));
      else if (matchRanges(asText(ctx.lookup(v)) ?? '', groups).length) problems.push(leak('/Info/Title', 'The title still contains a term.'));
    }
  }
  const catalog = pdf.catalog;
  for (const k of ['Metadata', 'AcroForm', 'OpenAction', 'AA', 'StructTreeRoot', 'PieceInfo']) {
    if (catalog.has(PDFName.of(k))) problems.push(leak(`/Root/${k}`, `The catalog still has /${k}.`));
  }
  const names = catalog.lookup(PDFName.of('Names'));
  if (names instanceof PDFDict) {
    for (const [k] of names.entries()) if (k.decodeText() !== 'Dests') problems.push(leak(`/Root/Names/${k.decodeText()}`, `The name dictionary still has /${k.decodeText()}.`));
  }
  pdf.getPages().forEach((page, i) => {
    for (const k of ['Annots', 'Thumb', 'AA']) if (page.node.has(PDFName.of(k))) problems.push(leak(`/pages/${i + 1}/${k}`, `Page ${i + 1} still has /${k}.`));
  });
  const outlineTitles: string[] = [];
  const seen = new Set<PDFObject>();
  const walk = (o: PDFObject | undefined) => {
    let item = o instanceof PDFRef ? ctx.lookup(o) : o;
    while (item instanceof PDFDict && !seen.has(item)) {
      seen.add(item);
      outlineTitles.push(asText(item.lookup(PDFName.of('Title'))) ?? '');
      walk(item.get(PDFName.of('First')));
      item = ctx.lookup(item.get(PDFName.of('Next')));
    }
  };
  const outlines = catalog.lookup(PDFName.of('Outlines'));
  if (outlines instanceof PDFDict) walk(outlines.get(PDFName.of('First')));
  for (const t of outlineTitles) if (matchRanges(t, groups).length) problems.push(leak('/Root/Outlines', `Outline entry "${t}" still contains a term.`));

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : undefined;
    for (const [k] of d?.entries() ?? []) {
      if (k.decodeText().startsWith('PTEX.')) problems.push(leak(`object ${ref.tag}`, `Object ${ref.tag} still has /${k.decodeText()}.`));
    }
    if (d && d.lookup(PDFName.of('Type')) === PDFName.of('EmbeddedFile')) problems.push(leak(`object ${ref.tag}`, 'An embedded file is still present.'));
  }

  // 3. Raw bytes and every decodable stream (zlib etc.), as the leak test of §12.2 does.
  for (const hit of rawHits(latin1(bytes), groups)) problems.push(leak('file', `The raw file contains ${hit}.`));
  // Font programs carry their designers' notices (including e-mail addresses), never document text.
  const fontPrograms = new Set<string>();
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.lookup(PDFName.of('Type')) === PDFName.of('FontDescriptor')) {
      for (const k of ['FontFile', 'FontFile2', 'FontFile3']) {
        const r = obj.get(PDFName.of(k));
        if (r instanceof PDFRef) fontPrograms.add(r.tag);
      }
    }
  }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || fontPrograms.has(ref.tag)) continue;
    let decoded: Uint8Array;
    try {
      decoded = decodePDFRawStream(obj).decode();
    } catch {
      continue; // image codecs pdf-lib cannot decode (DCT, JBIG2): no text inside
    }
    for (const hit of rawHits(latin1(decoded), groups)) problems.push(leak(`object ${ref.tag}`, `Stream ${ref.tag} contains ${hit}.`));
  }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFArray || obj instanceof PDFDict) {
      const strings: string[] = [];
      const collect = (o: PDFObject) => {
        const t = asText(o);
        if (t !== undefined) strings.push(t);
        else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) collect(o.get(i));
        else if (o instanceof PDFDict) for (const [, v] of o.entries()) collect(v);
      };
      collect(obj);
      for (const s of strings) if (matchRanges(s, groups).length) problems.push(leak(`object ${ref.tag}`, `Object ${ref.tag} contains the string "${s}".`));
    }
  }
  return problems;
}
