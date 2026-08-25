import type { Redactor } from "../util/redact.ts";

export const STAGES = [
  "resolve",
  "download",
  "inspect",
  "parse",
  "translate",
  "validate",
  "package",
] as const;

export type Stage = typeof STAGES[number];

export interface ReporterOptions {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  color: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  redactor: Redactor;
}

/**
 * Human, quiet and JSON output modes. In JSON mode stdout carries only NDJSON
 * events, so it stays machine-consumable. No telemetry is ever emitted.
 */
export class Reporter {
  #options: ReporterOptions;
  #stageIndex = 0;

  constructor(options: ReporterOptions) {
    this.#options = options;
  }

  stage(stage: Stage, message: string): void {
    this.#stageIndex++;
    if (this.#options.json) {
      this.#event({ type: "stage", stage, message });
      return;
    }
    if (this.#options.quiet) return;
    const label = this.#dim(`[${this.#stageIndex}/${STAGES.length}]`);
    this.#options.stdout(`${label} ${this.#bold(stage)} ${this.#redact(message)}`);
  }

  detail(message: string): void {
    if (this.#options.json || this.#options.quiet) return;
    this.#options.stdout(`      ${this.#redact(message)}`);
  }

  debug(message: string): void {
    if (!this.#options.verbose) return;
    this.detail(message);
  }

  warn(message: string): void {
    if (this.#options.json) {
      this.#event({ type: "warning", message: this.#redact(message) });
      return;
    }
    this.#options.stderr(`warning: ${this.#redact(message)}`);
  }

  /** Progress within the translate stage. */
  progress(done: number, total: number): void {
    if (this.#options.json) {
      this.#event({ type: "progress", done, total });
      return;
    }
    if (this.#options.quiet) return;
    this.#options.stdout(`      batch ${done}/${total}`);
  }

  event(payload: Record<string, unknown>): void {
    if (!this.#options.json) return;
    this.#event(payload);
  }

  done(payload: Record<string, unknown>): void {
    if (this.#options.json) {
      this.#event({ type: "done", ...payload });
      return;
    }
    if (this.#options.quiet) return;
    this.#options.stdout("");
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === "object") continue;
      this.#options.stdout(`${key}: ${this.#redact(String(value))}`);
    }
  }

  error(message: string, hint?: string, code?: string): void {
    const safeMessage = this.#redact(message);
    const safeHint = hint ? this.#redact(hint) : undefined;
    if (this.#options.json) {
      this.#eventTo(this.#options.stderr, {
        type: "error",
        code,
        message: safeMessage,
        hint: safeHint,
      });
      return;
    }
    this.#options.stderr(`error: ${safeMessage}`);
    if (safeHint) {
      for (const line of safeHint.split("\n")) this.#options.stderr(`  ${line}`);
    }
  }

  #event(payload: Record<string, unknown>): void {
    this.#eventTo(this.#options.stdout, payload);
  }

  #eventTo(sink: (line: string) => void, payload: Record<string, unknown>): void {
    sink(JSON.stringify(this.#options.redactor.value(payload)));
  }

  #redact(text: string): string {
    return this.#options.redactor.text(text);
  }

  #bold(text: string): string {
    return this.#options.color ? `\x1b[1m${text}\x1b[0m` : text;
  }

  #dim(text: string): string {
    return this.#options.color ? `\x1b[2m${text}\x1b[0m` : text;
  }
}
