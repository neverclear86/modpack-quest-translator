import { AppError } from "../errors.ts";
import type { TranslationUnit } from "../quests/adapter.ts";
import { buildBatches } from "./batcher.ts";
import type { TranslationCache } from "./cache.ts";
import {
  type Batch,
  type BatchRequest,
  FatalProviderError,
  type ProviderUsage,
  type TranslationProvider,
} from "./types.ts";
import { validateResponseIds, validateUnit } from "./validate.ts";

export interface TranslateRunOptions {
  provider: TranslationProvider;
  cache: TranslationCache;
  sourceLocale: string;
  targetLocale: string;
  glossary: Record<string, string>;
  model: string;
  fallbackModel: string;
  effort?: string;
  packName?: string;
  batchSize: number;
  batchChars: number;
  concurrency: number;
  retries: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Injected so tests do not wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FailedUnit {
  id: string;
  reason: string;
}

export interface TranslateReport {
  translated: number;
  cached: number;
  skipped: number;
  fallback: number;
  failed: FailedUnit[];
  batches: number;
  retries: number;
  usage: ProviderUsage;
  costUsd: number;
  /** Model actually used, per batch id. */
  modelsUsed: Record<string, string>;
}

export interface TranslateRunResult {
  translations: Map<string, string>;
  report: TranslateReport;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;

/**
 * Drives batching, caching, retry, model fallback and validation. The failure
 * policy is atomic: any unit that cannot be validated fails the whole run, so
 * no installable archive is ever written from partial output. See DESIGN.md §6.5.
 */
export async function translateUnits(
  units: readonly TranslationUnit[],
  options: TranslateRunOptions,
): Promise<TranslateRunResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const translations = new Map<string, string>();
  const report: TranslateReport = {
    translated: 0,
    cached: 0,
    skipped: 0,
    fallback: 0,
    failed: [],
    batches: 0,
    retries: 0,
    usage: {},
    costUsd: 0,
    modelsUsed: {},
  };

  // Whitespace-only strings must come back byte identical; no provider needed.
  const work: TranslationUnit[] = [];
  for (const unit of units) {
    if (unit.text.trim().length === 0) {
      translations.set(unit.id, unit.text);
      report.skipped++;
      continue;
    }
    work.push(unit);
  }

  // The same English string often appears many times. Translate each distinct
  // source once and fan the result back out to every unit that shares it.
  const byText = new Map<string, TranslationUnit[]>();
  for (const unit of work) {
    const group = byText.get(unit.text);
    if (group) group.push(unit);
    else byText.set(unit.text, [unit]);
  }

  const representatives: TranslationUnit[] = [];
  for (const group of byText.values()) {
    const cached = options.cache.get(group[0].text, options.model, options.fallbackModel);
    if (cached) {
      for (const unit of group) {
        translations.set(unit.id, cached.text);
        report.cached++;
      }
      continue;
    }
    representatives.push(group[0]);
  }

  const batches = buildBatches(representatives, {
    maxItems: options.batchSize,
    maxChars: options.batchChars,
  });
  report.batches = batches.length;

  let done = 0;
  const total = batches.length;
  const queue = [...batches];
  const concurrency = Math.max(1, Math.min(options.concurrency, 8));

  const worker = async (): Promise<void> => {
    for (;;) {
      const batch = queue.shift();
      if (!batch) return;
      throwIfCancelled(options.signal);

      const outcome = await runBatch(batch, options, report, sleep);
      for (const [id, text] of outcome) {
        const source = batch.units.find((u) => u.id === id)!;
        for (const unit of byText.get(source.text) ?? [source]) {
          translations.set(unit.id, text);
          report.translated++;
        }
      }
      // Durable after every batch, so Ctrl+C never loses more than one batch.
      await options.cache.flush();
      done++;
      options.onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  throwIfCancelled(options.signal);

  if (report.failed.length > 0) {
    throw new AppError(
      "E_TRANSLATION",
      `${report.failed.length} string(s) could not be translated and validated: ` +
        report.failed.slice(0, 5).map((f) => `${f.id} (${f.reason})`).join("; "),
      {
        hint: "No archive was written. The cache keeps the strings that did succeed, " +
          "so re-running resumes rather than starting over.",
        details: { failed: report.failed.length },
      },
    );
  }

  return { translations, report };
}

async function runBatch(
  batch: Batch,
  options: TranslateRunOptions,
  report: TranslateReport,
  sleep: (ms: number) => Promise<void>,
): Promise<Map<string, string>> {
  // Long prose goes straight to the stronger model rather than paying for a
  // Haiku attempt that is expected to fail.
  const plan = batch.longProse
    ? [options.fallbackModel, options.fallbackModel]
    : [options.model, options.model, options.fallbackModel];

  let repairNote: string | undefined;
  let lastReason = "unknown";

  for (let attempt = 0; attempt < plan.length; attempt++) {
    const model = plan[attempt];
    const request = buildRequest(batch, options);

    let response;
    try {
      response = await withRetry(
        () =>
          options.provider.translateBatch(request, {
            model,
            effort: options.effort,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            repairNote,
          }),
        options,
        report,
        sleep,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof FatalProviderError) {
        throw new AppError("E_TRANSLATION", error.message, {
          cause: error,
          hint: error.hint ?? "The translation provider reported an unrecoverable error.",
        });
      }
      // The transient retry budget is already spent. Escalating to a stronger
      // model cannot fix an outage or a rate limit, and would just burn the
      // user's quota, so the batch fails here rather than trying the next
      // model. Model escalation is reserved for validation failures below.
      lastReason = describe(error);
      break;
    }

    const ids = validateResponseIds(request.items.map((i) => i.id), response.items);
    if (!ids.ok) {
      lastReason = idProblem(ids);
      repairNote = `The previous response was rejected: ${lastReason}. ` +
        `Return exactly one entry for every requested id.`;
      continue;
    }

    const problems: string[] = [];
    const accepted = new Map<string, string>();
    for (const item of response.items) {
      const unit = batch.units.find((u) => u.id === item.id)!;
      const result = validateUnit(unit, item.text, { glossary: options.glossary });
      if (!result.ok) {
        problems.push(`${item.id}: ${result.problems.map((p) => p.message).join("; ")}`);
        continue;
      }
      accepted.set(item.id, item.text);
    }

    if (problems.length > 0) {
      lastReason = problems[0];
      repairNote = `The previous response failed validation:\n${problems.slice(0, 10).join("\n")}`;
      continue;
    }

    accumulate(report, response.usage, response.costUsd);
    report.modelsUsed[batch.id] = response.model;
    if (model !== options.model && !batch.longProse) report.fallback += batch.units.length;

    for (const [id, text] of accepted) {
      const unit = batch.units.find((u) => u.id === id)!;
      options.cache.set(unit.text, response.model, text);
    }
    return accepted;
  }

  for (const unit of batch.units) report.failed.push({ id: unit.id, reason: lastReason });
  return new Map();
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: TranslateRunOptions,
  report: TranslateReport,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    throwIfCancelled(options.signal);
    try {
      return await operation();
    } catch (error) {
      // Retrying an authentication or bad-model failure just wastes the user's
      // quota, so those propagate immediately.
      if (error instanceof FatalProviderError) throw error;
      lastError = error;
      if (attempt === options.retries) break;
      report.retries++;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      await sleep(delay);
    }
  }
  throw lastError;
}

function buildRequest(batch: Batch, options: TranslateRunOptions): BatchRequest {
  return {
    sourceLocale: options.sourceLocale,
    targetLocale: options.targetLocale,
    context: { pack: options.packName, chapter: batch.chapter },
    glossary: options.glossary,
    items: batch.units.map((unit) => ({
      id: unit.id,
      kind: unit.kind,
      text: unit.text,
      protectedTokens: unit.protectedTokens,
    })),
  };
}

function accumulate(report: TranslateReport, usage?: ProviderUsage, costUsd?: number): void {
  if (usage) {
    report.usage.inputTokens = (report.usage.inputTokens ?? 0) + (usage.inputTokens ?? 0);
    report.usage.outputTokens = (report.usage.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    report.usage.cacheReadInputTokens = (report.usage.cacheReadInputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0);
    report.usage.cacheCreationInputTokens = (report.usage.cacheCreationInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0);
  }
  if (costUsd !== undefined) {
    // Float addition drifts; round to the cent-thousandth the CLI reports.
    report.costUsd = Number((report.costUsd + costUsd).toFixed(6));
  }
}

function idProblem(ids: ReturnType<typeof validateResponseIds>): string {
  const parts: string[] = [];
  if (ids.missing.length > 0) parts.push(`missing ids ${ids.missing.slice(0, 5).join(", ")}`);
  if (ids.unknown.length > 0) parts.push(`unknown ids ${ids.unknown.slice(0, 5).join(", ")}`);
  if (ids.duplicates.length > 0) {
    parts.push(`duplicate ids ${ids.duplicates.slice(0, 5).join(", ")}`);
  }
  return parts.join("; ");
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError("E_CANCELLED", "Cancelled", {
      hint: "The cache was flushed after the last completed batch, so re-running resumes.",
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
