import type { TranslationUnit } from "../quests/adapter.ts";

/** The JSON shape sent to a provider. Matches REQUIREMENTS.md exactly. */
export interface BatchRequest {
  sourceLocale: string;
  targetLocale: string;
  context: { pack?: string; chapter?: string };
  glossary: Record<string, string>;
  items: {
    id: string;
    kind: string;
    text: string;
    protectedTokens: string[];
  }[];
}

export interface BatchResponse {
  items: { id: string; text: string }[];
  /** The model that actually produced this batch. */
  model: string;
  usage?: ProviderUsage;
  costUsd?: number;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface TranslateOptions {
  model: string;
  effort?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra instruction appended when retrying a batch that failed validation. */
  repairNote?: string;
}

export interface PreflightReport {
  ok: boolean;
  /** Human-readable provider identity, e.g. "claude 2.1.241". */
  version?: string;
  /** Safe auth summary. Must never contain an email, org id or token. */
  auth?: string;
  problem?: string;
  hint?: string;
}

/**
 * The stable seam. Parsing, validation, caching and packaging depend on this
 * and never on any provider's own types. See DESIGN.md §6.1.
 */
export interface TranslationProvider {
  readonly id: string;
  preflight(): Promise<PreflightReport>;
  translateBatch(request: BatchRequest, options: TranslateOptions): Promise<BatchResponse>;
}

/** Raised by a provider when the failure is worth retrying. */
export class TransientProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientProviderError";
  }
}

/** Raised by a provider when retrying cannot help. */
export class FatalProviderError extends Error {
  readonly hint?: string;
  constructor(message: string, options?: { cause?: unknown; hint?: string }) {
    super(message, options);
    this.name = "FatalProviderError";
    this.hint = options?.hint;
  }
}

export interface Batch {
  readonly id: string;
  readonly index: number;
  readonly units: TranslationUnit[];
  readonly chapter?: string;
  /** True when the batch holds a single string too long for a normal batch. */
  readonly longProse: boolean;
}
