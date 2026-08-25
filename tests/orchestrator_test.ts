import { assertEquals, assertRejects } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { translateUnits } from "../src/translate/orchestrator.ts";
import { TranslationCache } from "../src/translate/cache.ts";
import {
  type BatchRequest,
  type BatchResponse,
  FatalProviderError,
  TransientProviderError,
  type TranslateOptions,
  type TranslationProvider,
} from "../src/translate/types.ts";
import type { TranslationUnit } from "../src/quests/adapter.ts";

function units(texts: string[]): TranslationUnit[] {
  return texts.map((text, i) => ({
    id: `quest.${i}.title`,
    key: `quest.${i}.title`,
    kind: "title",
    index: -1,
    text,
    protectedTokens: [],
  }));
}

type Handler = (request: BatchRequest, options: TranslateOptions, call: number) => BatchResponse;

class FakeProvider implements TranslationProvider {
  readonly id = "fake";
  calls: { request: BatchRequest; options: TranslateOptions }[] = [];
  #handler: Handler;

  constructor(handler: Handler) {
    this.#handler = handler;
  }

  preflight() {
    return Promise.resolve({ ok: true });
  }

  translateBatch(request: BatchRequest, options: TranslateOptions): Promise<BatchResponse> {
    const call = this.calls.length;
    this.calls.push({ request, options });
    try {
      return Promise.resolve(this.#handler(request, options, call));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

function echo(prefix = "JA:"): FakeProvider {
  return new FakeProvider((request, options) => ({
    items: request.items.map((i) => ({ id: i.id, text: i.text === "" ? "" : prefix + i.text })),
    model: options.model,
  }));
}

async function withCache(fn: (cache: TranslationCache, dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "mqt-orch-" });
  try {
    await fn(
      await TranslationCache.open(dir, {
        sourceLocale: "en_us",
        targetLocale: "ja_jp",
        provider: "fake",
        promptVersion: 1,
        glossaryVersion: "none",
      }),
      dir,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const BASE = {
  sourceLocale: "en_us",
  targetLocale: "ja_jp",
  glossary: {},
  model: "haiku",
  fallbackModel: "sonnet",
  effort: "low",
  batchSize: 2,
  batchChars: 10_000,
  concurrency: 1,
  retries: 3,
  sleep: () => Promise.resolve(),
};

Deno.test("all units are translated and joined by id", async () => {
  await withCache(async (cache) => {
    const provider = echo();
    const result = await translateUnits(units(["One long source string", "Another long one"]), {
      ...BASE,
      provider,
      cache,
    });
    assertEquals(result.translations.get("quest.0.title"), "JA:One long source string");
    assertEquals(result.translations.get("quest.1.title"), "JA:Another long one");
    assertEquals(result.report.translated, 2);
    assertEquals(result.report.failed.length, 0);
  });
});

Deno.test("cached units are not sent to the provider", async () => {
  await withCache(async (cache) => {
    cache.set("One long source string", "haiku", "CACHED");
    const provider = echo();
    const result = await translateUnits(units(["One long source string", "Another long one"]), {
      ...BASE,
      provider,
      cache,
    });
    assertEquals(result.translations.get("quest.0.title"), "CACHED");
    assertEquals(result.report.cached, 1);
    assertEquals(result.report.translated, 1);
    const sent = provider.calls.flatMap((c) => c.request.items.map((i) => i.text));
    assertEquals(sent, ["Another long one"]);
  });
});

Deno.test("a batch fully served from cache never calls the provider at all", async () => {
  await withCache(async (cache) => {
    cache.set("One long source string", "haiku", "A");
    cache.set("Another long one", "haiku", "B");
    const provider = echo();
    const result = await translateUnits(units(["One long source string", "Another long one"]), {
      ...BASE,
      provider,
      cache,
    });
    assertEquals(provider.calls.length, 0);
    assertEquals(result.report.cached, 2);
  });
});

Deno.test("transient failures are retried with bounded exponential backoff", async () => {
  await withCache(async (cache) => {
    const delays: number[] = [];
    let attempts = 0;
    const provider = new FakeProvider((request, options) => {
      attempts++;
      if (attempts < 3) throw new TransientProviderError("rate limit exceeded");
      return { items: request.items.map((i) => ({ id: i.id, text: "OK" })), model: options.model };
    });
    const result = await translateUnits(units(["A long enough source string"]), {
      ...BASE,
      provider,
      cache,
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    assertEquals(attempts, 3);
    assertEquals(result.translations.get("quest.0.title"), "OK");
    assertEquals(delays.length, 2);
    assertEquals(delays[1] > delays[0], true, "backoff must grow");
  });
});

Deno.test("retries are bounded and the run then fails atomically", async () => {
  await withCache(async (cache) => {
    let attempts = 0;
    const provider = new FakeProvider(() => {
      attempts++;
      throw new TransientProviderError("overloaded");
    });
    const err = await assertRejects(
      () => translateUnits(units(["A long enough source string"]), { ...BASE, provider, cache }),
      AppError,
    ) as AppError;
    assertEquals(err.code, "E_TRANSLATION");
    // A down provider must cost one retry budget total, not one per model in
    // the escalation plan: a stronger model cannot fix an outage.
    assertEquals(attempts, BASE.retries + 1, `attempts ${attempts} must be bounded`);
  });
});

Deno.test("a fatal provider error is not retried", async () => {
  await withCache(async (cache) => {
    let attempts = 0;
    const provider = new FakeProvider(() => {
      attempts++;
      throw new FatalProviderError("Invalid API key");
    });
    await assertRejects(
      () => translateUnits(units(["A long enough source string"]), { ...BASE, provider, cache }),
      AppError,
    );
    assertEquals(attempts, 1);
  });
});

Deno.test("a batch that fails validation falls back to the stronger model", async () => {
  await withCache(async (cache) => {
    const provider = new FakeProvider((request, options, call) => {
      // Haiku drops the formatting code; sonnet gets it right.
      if (options.model === "haiku") {
        return { items: request.items.map((i) => ({ id: i.id, text: "壊れた" })), model: "haiku" };
      }
      void call;
      return {
        items: request.items.map((i) => ({ id: i.id, text: "&6直った&r" })),
        model: options.model,
      };
    });
    const list = units(["&6Go to the mine&r"]);
    list[0] = { ...list[0], protectedTokens: ["&6", "&r"] };
    const result = await translateUnits(list, { ...BASE, provider, cache });
    assertEquals(result.translations.get("quest.0.title"), "&6直った&r");
    assertEquals(result.report.fallback, 1);
    assertEquals(provider.calls.map((c) => c.options.model), ["haiku", "haiku", "sonnet"]);
  });
});

Deno.test("the repaired retry carries a note explaining what failed", async () => {
  await withCache(async (cache) => {
    const provider = new FakeProvider((request, options) => ({
      items: request.items.map((i) => ({
        id: i.id,
        text: options.model === "sonnet" ? "&6ok&r" : "bad",
      })),
      model: options.model,
    }));
    const list = units(["&6Go to the mine&r"]);
    list[0] = { ...list[0], protectedTokens: ["&6", "&r"] };
    await translateUnits(list, { ...BASE, provider, cache });
    assertEquals(typeof provider.calls[1].options.repairNote, "string");
    assertEquals(provider.calls[1].options.repairNote!.includes("&6"), true);
  });
});

Deno.test("a long-prose batch goes straight to the fallback model", async () => {
  await withCache(async (cache) => {
    const provider = echo();
    await translateUnits(units(["z".repeat(200)]), {
      ...BASE,
      provider,
      cache,
      batchChars: 50,
    });
    assertEquals(provider.calls[0].options.model, "sonnet");
  });
});

Deno.test("a response with missing ids fails validation and is retried", async () => {
  await withCache(async (cache) => {
    const provider = new FakeProvider((request, options, call) => {
      if (call === 0) return { items: [{ id: request.items[0].id, text: "半分" }], model: "haiku" };
      return {
        items: request.items.map((i) => ({ id: i.id, text: `OK${i.id}` })),
        model: options.model,
      };
    });
    const result = await translateUnits(units(["First long string", "Second long string"]), {
      ...BASE,
      provider,
      cache,
      batchSize: 2,
    });
    assertEquals(provider.calls.length >= 2, true);
    assertEquals(result.report.failed.length, 0);
    assertEquals(result.translations.size, 2);
  });
});

Deno.test("a response with unknown or duplicate ids is rejected", async () => {
  await withCache(async (cache) => {
    const provider = new FakeProvider(() => ({
      items: [{ id: "quest.ghost.title", text: "x" }],
      model: "haiku",
    }));
    await assertRejects(
      () => translateUnits(units(["A long enough source string"]), { ...BASE, provider, cache }),
      AppError,
    );
  });
});

Deno.test("successful translations are written to the cache and flushed per batch", async () => {
  await withCache(async (cache, dir) => {
    await translateUnits(units(["First long string", "Second long string"]), {
      ...BASE,
      provider: echo(),
      cache,
      batchSize: 1,
    });
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.length, 1);
    assertEquals(cache.get("First long string", "haiku")?.text, "JA:First long string");
  });
});

Deno.test("empty source strings are handled without calling the provider", async () => {
  await withCache(async (cache) => {
    const provider = echo();
    const result = await translateUnits(units(["", "   "]), { ...BASE, provider, cache });
    assertEquals(provider.calls.length, 0);
    assertEquals(result.translations.get("quest.0.title"), "");
    assertEquals(result.translations.get("quest.1.title"), "   ");
    assertEquals(result.report.skipped, 2);
  });
});

Deno.test("identical source strings are translated once and reused", async () => {
  await withCache(async (cache) => {
    const provider = echo();
    const list = units(["Repeated source string", "Repeated source string", "Different one here"]);
    const result = await translateUnits(list, { ...BASE, provider, cache, batchSize: 10 });
    const sent = provider.calls.flatMap((c) => c.request.items.map((i) => i.text));
    assertEquals(sent.filter((t) => t === "Repeated source string").length, 1);
    assertEquals(
      result.translations.get("quest.0.title"),
      result.translations.get("quest.1.title"),
    );
  });
});

Deno.test("progress is reported for each batch", async () => {
  await withCache(async (cache) => {
    const events: string[] = [];
    await translateUnits(units(["First long string", "Second long string"]), {
      ...BASE,
      provider: echo(),
      cache,
      batchSize: 1,
      onProgress: (done, total) => events.push(`${done}/${total}`),
    });
    assertEquals(events, ["1/2", "2/2"]);
  });
});

Deno.test("cancellation stops the run promptly with E_CANCELLED", async () => {
  await withCache(async (cache) => {
    const controller = new AbortController();
    const provider = new FakeProvider((request, options) => {
      controller.abort();
      return { items: request.items.map((i) => ({ id: i.id, text: "x" })), model: options.model };
    });
    const err = await assertRejects(
      () =>
        translateUnits(units(["First long string", "Second long string", "Third long string"]), {
          ...BASE,
          provider,
          cache,
          batchSize: 1,
          signal: controller.signal,
        }),
      AppError,
    ) as AppError;
    assertEquals(err.code, "E_CANCELLED");
  });
});

Deno.test("usage and cost are accumulated for the report", async () => {
  await withCache(async (cache) => {
    const provider = new FakeProvider((request, options) => ({
      items: request.items.map((i) => ({ id: i.id, text: "JA" + i.text })),
      model: options.model,
      usage: { inputTokens: 100, outputTokens: 50 },
      costUsd: 0.001,
    }));
    const result = await translateUnits(units(["First long string", "Second long string"]), {
      ...BASE,
      provider,
      cache,
      batchSize: 1,
    });
    assertEquals(result.report.usage.inputTokens, 200);
    assertEquals(result.report.usage.outputTokens, 100);
    assertEquals(result.report.costUsd, 0.002);
  });
});

Deno.test("chapter context reaches the provider request", async () => {
  await withCache(async (cache) => {
    const provider = echo();
    const list = units(["A long enough source string"]);
    list[0] = { ...list[0], chapter: "Create: Core" };
    await translateUnits(list, { ...BASE, provider, cache, packName: "Test Pack" });
    assertEquals(provider.calls[0].request.context.chapter, "Create: Core");
    assertEquals(provider.calls[0].request.context.pack, "Test Pack");
  });
});
