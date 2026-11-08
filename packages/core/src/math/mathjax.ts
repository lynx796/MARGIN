import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor, type LiteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import '@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js';
import '@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js';
import { MathJaxFiraFont } from '@mathjax/mathjax-fira-font/js/svg.js';
import { compose, IDENTITY, parseTransform, rectPath, transformPath, type Affine } from './svgpath.ts';

// Math rendering (spec §6.2): MathJax 4 renders TeX to SVG with the mathjax-fira font. Results are
// flattened to plain paths in units of 1/1000 em (y down, baseline at y = 0), so they scale to any
// font size and render identically on screen and in the PDF. Rendering is async because MathJax
// loads glyph ranges lazily; layout is sync and reads only the cache (`prepareMath` first).

export interface MathBox {
  /** Box metrics in em. */
  width: number;
  height: number;
  depth: number;
  /** Absolute path data, 1/1000 em units. */
  paths: string[];
  /** TeX error message; the box is then empty and the source is shown instead (§6.2). */
  error?: string;
}

interface LiteNode {
  kind: string;
}

let engine: { adaptor: LiteAdaptor; doc: ReturnType<typeof mathjax.document> } | undefined;
let ready: Promise<void> | undefined;

function getEngine() {
  if (!engine) {
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    // Glyph ranges load through dynamic import; bundlers must make these modules resolvable.
    mathjax.asyncLoad = (name: string) => import(/* @vite-ignore */ name);
    const tex = new TeX({
      packages: ['base', 'ams', 'newcommand', 'boldsymbol', 'mathtools', 'textmacros'],
      formatError: (_jax: unknown, err: Error) => {
        throw err;
      },
    });
    const svg = new SVG({ fontData: MathJaxFiraFont, fontCache: 'none', linebreaks: { inline: false } } as never);
    const doc = mathjax.document('', { InputJax: tex, OutputJax: svg });
    engine = { adaptor, doc };
  }
  return engine;
}

const cache = new Map<string, MathBox>();

function key(tex: string, display: boolean): string {
  return (display ? 'D:' : 'I:') + tex;
}

async function render(tex: string, display: boolean): Promise<MathBox> {
  const { adaptor, doc } = getEngine();
  let node: LiteNode;
  try {
    node = (await mathjax.handleRetriesFor(() => doc.convert(tex, { display, em: 16, ex: 8, containerWidth: 100000 }))) as LiteNode;
  } catch (e) {
    return { width: 0, height: 0, depth: 0, paths: [], error: (e as Error).message };
  }
  const a = adaptor as unknown as {
    kind(n: LiteNode): string;
    childNodes(n: LiteNode): LiteNode[];
    getAttribute(n: LiteNode, name: string): string | null;
  };
  const find = (n: LiteNode): LiteNode | undefined => {
    if (a.kind(n) === 'svg') return n;
    for (const c of a.childNodes(n)) {
      const f = find(c);
      if (f) return f;
    }
    return undefined;
  };
  const svg = find(node);
  if (!svg) return { width: 0, height: 0, depth: 0, paths: [], error: 'MathJax produced no SVG' };
  const vb = (a.getAttribute(svg, 'viewBox') ?? '0 0 0 0').split(/\s+/).map(Number);
  const [minX = 0, minY = 0, w = 0, h = 0] = vb;
  const paths: string[] = [];
  const root: Affine = [1, 0, 0, 1, -minX, 0];
  const walk = (n: LiteNode, m: Affine) => {
    const kind = a.kind(n);
    if (kind === '#text' || kind === '#comment') return;
    let here = compose(m, parseTransform(a.getAttribute(n, 'transform')));
    if (kind === 'svg' && n !== svg) {
      here = compose(here, [1, 0, 0, 1, Number(a.getAttribute(n, 'x') ?? 0), Number(a.getAttribute(n, 'y') ?? 0)]);
    }
    if (kind === 'path') {
      const d = a.getAttribute(n, 'd');
      if (d) paths.push(transformPath(d, here));
    } else if (kind === 'rect') {
      const num = (k: string) => Number(a.getAttribute(n, k) ?? 0);
      paths.push(rectPath(num('x'), num('y'), num('width'), num('height'), here));
    } else if (kind === 'line') {
      const num = (k: string) => Number(a.getAttribute(n, k) ?? 0);
      const sw = Number(a.getAttribute(n, 'stroke-width') ?? 50) / 2;
      const [x1, y1, x2, y2] = [num('x1'), num('y1'), num('x2'), num('y2')];
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const [nx, ny] = [(-(y2 - y1) / len) * sw, ((x2 - x1) / len) * sw];
      paths.push(transformPath(`M${x1 + nx} ${y1 + ny}L${x2 + nx} ${y2 + ny}L${x2 - nx} ${y2 - ny}L${x1 - nx} ${y1 - ny}Z`, here));
    }
    for (const c of a.childNodes(n)) walk(c, here);
  };
  walk(svg, root);
  return { width: w / 1000, height: -minY / 1000, depth: (h + minY) / 1000, paths };
}

/** Render all given TeX sources into the cache. Safe to call repeatedly. */
export async function prepareMath(items: Iterable<{ tex: string; display: boolean }>): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const { doc } = getEngine();
      // Load every dynamic glyph range up front so that results never depend on render order.
      const font = (doc.outputJax as unknown as { font: { loadDynamicFiles(): Promise<void> } }).font;
      await font.loadDynamicFiles();
    })();
  }
  await ready;
  for (const { tex, display } of items) {
    const k = key(tex, display);
    if (!cache.has(k)) cache.set(k, await render(tex, display));
  }
}

/** A prepared math box; throws if `prepareMath` was not called for it. */
export function getMath(tex: string, display: boolean): MathBox {
  const box = cache.get(key(tex, display));
  if (!box) throw new Error(`Math not prepared: ${tex}`);
  return box;
}
