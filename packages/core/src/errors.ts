/** Structured error (spec §3): agents act on `code` and `path`, humans read `message`. */
export class MarginError extends Error {
  readonly code: string;
  readonly path: string | undefined;
  readonly details: unknown;

  constructor(code: string, message: string, options: { path?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'MarginError';
    this.code = code;
    this.path = options.path;
    this.details = options.details;
  }

  toJSON(): { code: string; message: string; path?: string; details?: unknown } {
    const out: { code: string; message: string; path?: string; details?: unknown } = { code: this.code, message: this.message };
    if (this.path !== undefined) out.path = this.path;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/** A non-fatal finding, e.g. from `margin check`. */
export interface Problem {
  code: string;
  message: string;
  path?: string;
  severity: 'error' | 'warning';
}
