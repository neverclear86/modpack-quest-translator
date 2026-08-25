import type { TranslateReport } from "../../src/translate/orchestrator.ts";

/**
 * The report a finished translation run writes.
 *
 * Typed, and deliberately never cast on the way into `buildOverlay`. The
 * packager reads `failed` as the *list* of strings that could not be translated
 * and validated, so a test that fabricates `failed: 0` will happily agree with
 * a packager that refuses every overlay this tool has ever produced.
 */
export function finishedRun(overrides: Partial<TranslateReport> = {}): TranslateReport {
  return {
    translated: 1,
    cached: 0,
    skipped: 0,
    fallback: 0,
    failed: [],
    batches: 1,
    retries: 0,
    modelsUsed: { "batch-1": "haiku" },
    usage: {},
    costUsd: 0,
    ...overrides,
  };
}
