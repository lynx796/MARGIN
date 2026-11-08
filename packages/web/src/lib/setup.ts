import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { setMathModuleLoader } from '@margin/core';

// One-time wiring of the third-party engines to the bundler.

GlobalWorkerOptions.workerSrc = workerUrl;

// MathJax loads glyph-range modules by package specifier; map each to its statically known module so
// the bundler emits them as chunks. Fetched lazily, on first use of math.
const ranges = import.meta.glob('../../node_modules/@mathjax/mathjax-fira-font/mjs/svg/dynamic/*.js');
const byFile = new Map(Object.entries(ranges).map(([path, load]) => [path.slice(path.lastIndexOf('/') + 1), load]));

setMathModuleLoader(async (name) => {
  const load = byFile.get(name.slice(name.lastIndexOf('/') + 1));
  if (!load) throw new Error(`Unknown MathJax module ${name}`);
  return load();
});
