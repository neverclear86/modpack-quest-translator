import { assertEquals } from "@std/assert";
import { glossaryVersion, TranslationCache } from "../src/translate/cache.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-cache-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const KEY = {
  sourceLocale: "en_us",
  targetLocale: "ja_jp",
  provider: "claude-code",
  promptVersion: 3,
  glossaryVersion: "none",
};

Deno.test("a stored translation is found again with the same key fields", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    assertEquals(cache.get("Hello", { model: "haiku" }), undefined);
    cache.set("Hello", "haiku", "こんにちは");
    assertEquals(cache.get("Hello", { model: "haiku" })?.text, "こんにちは");
    assertEquals(cache.get("Hello", { model: "haiku" })?.model, "haiku");
  });
});

Deno.test("changing any key field misses the cache", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Hello", "haiku", "こんにちは");
    await cache.flush();

    for (
      const override of [
        { targetLocale: "ko_kr" },
        { sourceLocale: "de_de" },
        { provider: "echo" },
        { promptVersion: 4 },
        { glossaryVersion: "abc123" },
      ]
    ) {
      const other = await TranslationCache.open(dir, { ...KEY, ...override });
      assertEquals(other.get("Hello", { model: "haiku" }), undefined, JSON.stringify(override));
    }
    const same = await TranslationCache.open(dir, KEY);
    assertEquals(same.get("Hello", { model: "haiku" })?.text, "こんにちは");
  });
});

Deno.test("a different source text misses the cache", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Hello", "haiku", "こんにちは");
    assertEquals(cache.get("Hello there", { model: "haiku" }), undefined);
  });
});

Deno.test("a fallback-model entry is still reused on resume", async () => {
  // Attempt 1 always uses the primary model, so a string rescued by the
  // fallback would never be found again if lookup only checked one namespace.
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Long prose here", "sonnet", "長い文章");
    const hit = cache.get("Long prose here", { model: "haiku", fallbackModel: "sonnet" });
    assertEquals(hit?.text, "長い文章");
    assertEquals(hit?.model, "sonnet");
  });
});

Deno.test("the primary model wins when both namespaces have an entry", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Text", "sonnet", "SONNET");
    cache.set("Text", "haiku", "HAIKU");
    assertEquals(cache.get("Text", { model: "haiku", fallbackModel: "sonnet" })?.text, "HAIKU");
  });
});

Deno.test("entries survive a flush and reopen", async () => {
  await withTempDir(async (dir) => {
    const first = await TranslationCache.open(dir, KEY);
    first.set("Persisted", "haiku", "永続");
    await first.flush();
    const second = await TranslationCache.open(dir, KEY);
    assertEquals(second.get("Persisted", { model: "haiku" })?.text, "永続");
  });
});

Deno.test("a corrupt cache file is discarded rather than failing the run", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("A", "haiku", "あ");
    await cache.flush();
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) await Deno.writeTextFile(`${dir}/${entry.name}`, "{ not json");
    }
    const reopened = await TranslationCache.open(dir, KEY);
    assertEquals(reopened.get("A", { model: "haiku" }), undefined);
    reopened.set("A", "haiku", "あ");
    await reopened.flush();
    assertEquals((await TranslationCache.open(dir, KEY)).get("A", { model: "haiku" })?.text, "あ");
  });
});

Deno.test("flushing is atomic: no temp file is left behind", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("A", "haiku", "あ");
    await cache.flush();
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.some((n) => n.includes(".tmp")), false);
  });
});

Deno.test("a disabled cache never stores or returns anything", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY, { enabled: false });
    cache.set("Hello", "haiku", "こんにちは");
    assertEquals(cache.get("Hello", { model: "haiku" }), undefined);
    await cache.flush();
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.length, 0);
  });
});

Deno.test("stats report hits and stores", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("A", "haiku", "あ");
    cache.get("A", { model: "haiku" });
    cache.get("B", { model: "haiku" });
    assertEquals(cache.stats(), { entries: 1, hits: 1, misses: 1, stores: 1, rejected: 0 });
  });
});

Deno.test("glossaryVersion is stable, order independent and none when empty", () => {
  assertEquals(glossaryVersion({}), "none");
  assertEquals(glossaryVersion(undefined), "none");
  const a = glossaryVersion({ Create: "Create", Ponder: "Ponder" });
  const b = glossaryVersion({ Ponder: "Ponder", Create: "Create" });
  assertEquals(a, b);
  assertEquals(a === glossaryVersion({ Create: "クリエイト" }), false);
});

Deno.test("the cache never stores anything that looks like a credential", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Hello", "haiku", "こんにちは");
    await cache.flush();
    for await (const entry of Deno.readDir(dir)) {
      const text = await Deno.readTextFile(`${dir}/${entry.name}`);
      assertEquals(text.includes("sk-ant"), false);
      assertEquals(/@[a-z0-9.-]+\.[a-z]{2,}/i.test(text), false);
    }
  });
});

Deno.test("an entry stored while a flush is in flight is not lost", async () => {
  // Regression: flush() cleared its dirty flag *after* awaiting the write, so a
  // set() that landed during the write was marked clean and never persisted.
  // Under --concurrency > 1 this silently dropped cache entries, which showed up
  // as a string being re-translated on a resume that should have been a full hit.
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("First", "haiku", "1");
    const inFlight = cache.flush();
    cache.set("Second", "haiku", "2");
    await inFlight;
    await cache.flush();

    const reopened = await TranslationCache.open(dir, KEY);
    assertEquals(reopened.get("First", { model: "haiku" })?.text, "1");
    assertEquals(reopened.get("Second", { model: "haiku" })?.text, "2");
  });
});

Deno.test("concurrent flushes never drop an entry", async () => {
  // Two orchestrator workers flush after their own batch. Interleaved renames
  // must not let an earlier, smaller snapshot land last.
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    const flushes: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      cache.set(`Source ${i}`, "haiku", `翻訳 ${i}`);
      flushes.push(cache.flush());
    }
    await Promise.all(flushes);
    await cache.flush();

    const reopened = await TranslationCache.open(dir, KEY);
    for (let i = 0; i < 25; i++) {
      assertEquals(
        reopened.get(`Source ${i}`, { model: "haiku" })?.text,
        `翻訳 ${i}`,
        `entry ${i} was lost`,
      );
    }
  });
});

Deno.test("an entry the caller rejects is a miss, not a hit", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("You need %s more", "haiku", "あと必要");
    assertEquals(
      cache.get("You need %s more", { model: "haiku", accept: () => false }),
      undefined,
    );
    const stats = cache.stats();
    assertEquals(stats.hits, 0);
    assertEquals(stats.misses, 1);
    assertEquals(stats.rejected, 1);
  });
});

Deno.test("a rejected entry is dropped so it is never offered again", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Hello", "haiku", "corrupt");
    assertEquals(cache.get("Hello", { model: "haiku", accept: () => false }), undefined);
    // Even a caller that would now accept anything must not see it.
    assertEquals(cache.get("Hello", { model: "haiku", accept: () => true }), undefined);
    await cache.flush();
    const reopened = await TranslationCache.open(dir, KEY);
    assertEquals(reopened.get("Hello", { model: "haiku" }), undefined);
  });
});

Deno.test("the fallback namespace is revalidated too", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Long prose", "sonnet", "壊れた");
    assertEquals(
      cache.get("Long prose", { model: "haiku", fallbackModel: "sonnet", accept: () => false }),
      undefined,
    );
    assertEquals(
      cache.get("Long prose", { model: "haiku", fallbackModel: "sonnet" }),
      undefined,
      "the rejected fallback entry survived",
    );
  });
});

Deno.test("an accepted entry is still a hit and is not disturbed", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Hello", "haiku", "こんにちは");
    const seen: string[] = [];
    const hit = cache.get("Hello", {
      model: "haiku",
      accept: (entry) => {
        seen.push(entry.text);
        return true;
      },
    });
    assertEquals(hit?.text, "こんにちは");
    assertEquals(seen, ["こんにちは"]);
    assertEquals(cache.stats().hits, 1);
    assertEquals(cache.stats().rejected, 0);
  });
});
