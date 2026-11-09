import { parseArgs } from 'node:util';
import { MarginError } from '@margin/core';
import { cmdAdd, cmdAgentGuide, cmdApply, cmdCheck, cmdEdit, cmdExport, cmdInit, cmdList, cmdRead, cmdRender, cmdResolve, cmdRm, cmdSchema, cmdServe, type Args } from './commands.ts';
import { EXIT_ERROR, EXIT_OK, Output } from './output.ts';
import { VERSION } from './workspace.ts';

const HELP = `margin ${VERSION} — grade compiled LaTeX papers with typeset margin comments

Usage: margin <command> [paper.pdf] [options]

Commands:
  init <paper.pdf>              Create paper.annot.json with default categories and the PDF hash
  read [paper.pdf] [--pages 3-5]
                                Page text as Markdown, line-numbered, with comments inline as
                                ⟦#4 error k3f9qd: …⟧ after their anchor
  list [--page N] [--category C]
                                Comments with number, ID, category, page, quote and body
  add --category C --quote "…" [--page N] [--prefix …] [--suffix …] [--body "…"] [--side S]
  add --category C --region x0,y0,x1,y1 --page N [--body "…"]
                                Add a comment; prints its ID. Fails on missing or ambiguous quotes.
  edit <id> [--body …] [--category …] [--side auto|left|right] [--reviewed]
  rm <id>                       Delete a comment
  apply <ops.json>              Apply add/edit/rm operations atomically
  resolve                       Fill missing quads from quotes and quotes from quads
  check                         Schema, anchors, math errors, dangling \\ref, overflow
  render [paper.pdf] -o <dir> [--pages N] [--dpi 150]
                                PNG per annotated page plus layout.json, for visual checks
  export [paper.pdf] [-o file]  Flattened PDF (default paper.annotated.pdf)
  serve [--dir D] [--port 7311] [--allow-origin URL]
                                Local bridge: serves the web app and the PDFs and annotation files
                                of D on 127.0.0.1; changes made by this CLI appear live in the app
  schema                        Print the annotation file JSON Schema
  agent-guide                   Print a concise usage guide written for AI agents

Common options:
  --annot <file>   Annotation file (default: <pdf>.annot.json, or the only *.annot.json here)
  --json           Machine-readable output; errors as {"ok": false, "error": {code, message, path}}
  -h, --help       Show this help

Exit codes: 0 ok, 1 validation problems found, 2 usage or I/O error.
Environment: MARGIN_NOW (ISO time) and MARGIN_SEED (integer) pin timestamps and new IDs.
`;

const COMMANDS: Record<string, (args: Args, out: Output) => Promise<number>> = {
  init: cmdInit,
  read: cmdRead,
  list: cmdList,
  add: cmdAdd,
  edit: cmdEdit,
  rm: cmdRm,
  apply: cmdApply,
  resolve: cmdResolve,
  check: cmdCheck,
  render: cmdRender,
  export: cmdExport,
  schema: cmdSchema,
  'agent-guide': cmdAgentGuide,
  serve: cmdServe,
};

export async function run(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const out = new Output(json);
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        annot: { type: 'string' },
        pages: { type: 'string' },
        page: { type: 'string' },
        category: { type: 'string' },
        quote: { type: 'string' },
        prefix: { type: 'string' },
        suffix: { type: 'string' },
        region: { type: 'string' },
        body: { type: 'string' },
        side: { type: 'string' },
        origin: { type: 'string' },
        reviewed: { type: 'boolean' },
        unreviewed: { type: 'boolean' },
        dir: { type: 'string' },
        port: { type: 'string' },
        'allow-origin': { type: 'string' },
        'app-dir': { type: 'string' },
        force: { type: 'boolean' },
        dpi: { type: 'string' },
        o: { type: 'string', short: 'o' },
      },
    });
    if (values.version) {
      process.stdout.write(`${VERSION}\n`);
      return EXIT_OK;
    }
    const [command, ...rest] = positionals;
    if (!command || values.help) {
      process.stdout.write(HELP);
      return command || values.help ? EXIT_OK : EXIT_ERROR;
    }
    const fn = COMMANDS[command];
    if (!fn) throw new MarginError('usage', `Unknown command "${command}". Run margin --help.`);
    return await fn({ positionals: rest, values }, out);
  } catch (e) {
    if (e instanceof Error && 'code' in e && typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS')) {
      return out.error(new MarginError('usage', `${e.message}. Run margin --help.`));
    }
    return out.error(e);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bin/margin.js') || process.argv[1]?.endsWith('main.ts')) {
  process.exitCode = await run(process.argv.slice(2));
}
