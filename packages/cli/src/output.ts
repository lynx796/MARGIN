import { MarginError, type Problem } from '@margin/core';

// Output conventions (spec §9.1): `--json` for machine-readable output, structured errors, exit
// codes 0 (ok), 1 (validation problems found), 2 (usage or I/O error).

export const EXIT_OK = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_ERROR = 2;

export class Output {
  constructor(readonly json: boolean) {}

  /** Print a result: `data` as JSON with --json, otherwise `text`. */
  result(data: Record<string, unknown>, text: string): void {
    if (this.json) process.stdout.write(JSON.stringify({ ok: true, ...data }, null, 2) + '\n');
    else if (text) process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  }

  warn(w: MarginError | Problem): void {
    if (!this.json) process.stderr.write(`warning[${w.code}]: ${w.message}\n`);
  }

  error(e: unknown): number {
    const err = e instanceof MarginError ? e : new MarginError('internal', e instanceof Error ? e.message : String(e));
    if (this.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: err.toJSON() }, null, 2) + '\n');
    } else {
      process.stderr.write(`error[${err.code}]: ${err.message}\n`);
      if (Array.isArray(err.details)) {
        type Detail = { message?: string; index?: number; candidates?: { page: number; context: string }[] };
        const details = err.details as Detail[];
        for (const d of details) {
          if (details.length > 1 && d.message) process.stderr.write(`  #${d.index ?? '?'}: ${d.message}\n`);
          for (const c of d.candidates ?? []) process.stderr.write(`    candidate on page ${c.page}: ${c.context}\n`);
          if (details.length === 1 && !d.candidates && d.message && d.message !== err.message) process.stderr.write(`  - ${d.message}\n`);
        }
      }
      if (err.code === 'internal' && e instanceof Error && process.env.MARGIN_DEBUG) process.stderr.write(`${e.stack}\n`);
    }
    return USAGE_CODES.has(err.code) || err.code === 'io' || err.code === 'internal' ? EXIT_ERROR : EXIT_PROBLEMS;
  }
}

/** Error codes that mean the command was used wrongly (exit 2) rather than a validation problem. */
export const USAGE_CODES = new Set(['usage', 'no-annotation-file', 'exists', 'pdf-invalid', 'no-latex', 'report-missing', 'not-exported', 'original-needed']);
