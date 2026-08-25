import type {
  BatchRequest,
  BatchResponse,
  PreflightReport,
  TranslateOptions,
  TranslationProvider,
} from "../types.ts";

/**
 * A deterministic in-process provider that costs nothing and needs nothing
 * installed. It exists so the whole pipeline -- discovery, batching, cache,
 * validation, packaging -- can be exercised offline, in tests and via
 * `--provider echo`. Its output is deliberately built to pass the same
 * validation a real provider's output must.
 */
export class EchoProvider implements TranslationProvider {
  readonly id = "echo";

  preflight(): Promise<PreflightReport> {
    return Promise.resolve({
      ok: true,
      version: "echo (built in)",
      auth: "not required",
    });
  }

  translateBatch(request: BatchRequest, options: TranslateOptions): Promise<BatchResponse> {
    return Promise.resolve({
      items: request.items.map((item) => ({
        id: item.id,
        // Whitespace-only strings must come back byte identical.
        text: item.text.trim().length === 0
          ? item.text
          : `[${request.targetLocale}] ${item.text}`,
      })),
      model: options.model,
    });
  }
}
