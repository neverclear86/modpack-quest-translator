/** Documented, stable exit codes. See DESIGN.md §8 and INSTALLER_DESIGN.md §4.1. */
export const EXIT_CODES = {
  E_INTERNAL: 1,
  E_INVALID_INPUT: 2,
  E_UNSUPPORTED_PACK: 3,
  E_DOWNLOAD: 4,
  E_NO_QUEST_LOCALIZATION: 5,
  E_TRANSLATION: 6,
  E_VALIDATION: 7,
  E_WRITE: 8,
  E_PREFLIGHT: 9,
  // Installer-only, from 10 up, so the translator's table never shifts.
  E_BUNDLE: 10,
  E_INSTANCE: 11,
  E_TARGET_MODIFIED: 12,
  E_BACKUP: 13,
  E_NOT_INSTALLED: 14,
  /** Script installer only: the file in the instance is not the one the translation was made from. */
  E_SOURCE_MISMATCH: 15,
  E_CANCELLED: 130,
} as const;

export type ErrorCode = keyof typeof EXIT_CODES;

export interface AppErrorOptions {
  /** Actionable next step shown to the user under the error message. */
  hint?: string;
  cause?: unknown;
  /** Extra structured fields surfaced in `--json` mode. */
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function exitCodeFor(error: unknown): number {
  return error instanceof AppError ? error.exitCode : EXIT_CODES.E_INTERNAL;
}

export function isAppError(error: unknown, code?: ErrorCode): error is AppError {
  return error instanceof AppError && (code === undefined || error.code === code);
}
