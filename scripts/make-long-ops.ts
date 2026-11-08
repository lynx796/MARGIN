// Generates fixtures/long/ops.json: three comments per page on the 20-page "long" fixture, quoting
// phrases that are unique in the document, with bodies of varying length and math. Deterministic.
// Run: pnpm tsx scripts/make-long-ops.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeQuote, PageIndex, PdfDoc } from '@margin/core';

const dir = new URL('../fixtures/long/', import.meta.url).pathname;
const doc = await PdfDoc.open(new Uint8Array(readFileSync(dir + 'long.pdf')));
const indexes = (await doc.allText()).map((t) => new PageIndex(t));
const categories = ['remark', 'typo', 'error', 'good', 'remark', 'error'];
const bodies = [
  'Short remark.',
  'This sentence needs a citation; which source do you rely on here?',
  'The estimate \\(\\|u\\|_{L^2} \\le C \\|\\nabla u\\|_{L^2}\\) requires zero boundary values, which you never assume. State the hypothesis.',
  'Typo.',
  '**Good.** Clear and correct.',
  'Unclear: \\[ \\sum_{k=1}^{n} \\binom{n}{k} x^k (1-x)^{n-k} \\] should include \\(k = 0\\). Please check the indices in the whole paragraph.',
];
const ops: unknown[] = [];
let n = 0;
for (const idx of indexes) {
  const lines = idx.page.lines.filter((l) => l.end - l.start > 40);
  // Three target lines spread over the page; if a line has no unique phrase, try the next ones.
  for (const f of [0.15, 0.5, 0.85]) {
    let found = false;
    for (let li = Math.floor(f * (lines.length - 1)); li < lines.length && !found; li++) {
      const line = lines[li]!;
      const text = idx.page.text.slice(line.start, line.end);
      // Runs of three words (punctuation inside the run is fine) that are unique in the document.
      const words = text.split(' ');
      for (let i = Math.floor(words.length / 3); i + 3 <= words.length && !found; i++) {
        const quote = words.slice(i, i + 3).join(' ');
        if (!/^[A-Za-z]/.test(quote) || /-$/.test(quote)) continue;
        if (indexes.flatMap((x) => x.find(normalizeQuote(quote))).length !== 1) continue;
        ops.push({ op: 'add', page: idx.page.page, quote, category: categories[n % categories.length], body: bodies[n % bodies.length] });
        n++;
        found = true;
      }
    }
  }
}
writeFileSync(dir + 'ops.json', '[\n' + ops.map((o) => '  ' + JSON.stringify(o)).join(',\n') + '\n]\n');
console.log(`${ops.length} operations`);
