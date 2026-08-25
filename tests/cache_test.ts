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
    assertEquals(cache.get("Hello", "haiku"), undefined);
    cache.set("Hello", "haiku", "こんにちは");
    assertEquals(cache.get("Hello", "haiku")?.text, "こんにちは");
    assertEquals(cache.get("Hello", "haiku")?.model, "haiku");
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
      assertEquals(other.get("Hello", "haiku"), undefined, JSON.stringify(override));
    }
    const same = await TranslationCache.open(dir, KEY);
    assertEquals(same.get("Hello", "haiku")?.text, "こんにちは");
  });
});

Deno.test("a different source text misses the cache", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Hello", "haiku", "こんにちは");
    assertEquals(cache.get("Hello there", "haiku"), undefined);
  });
});

Deno.test("a fallback-model entry is still reused on resume", async () => {
  // Attempt 1 always uses the primary model, so a string rescued by the
  // fallback would never be found again if lookup only checked one namespace.
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Long prose here", "sonnet", "長い文章");
    const hit = cache.get("Long prose here", "haiku", "sonnet");
    assertEquals(hit?.text, "長い文章");
    assertEquals(hit?.model, "sonnet");
  });
});

Deno.test("the primary model wins when both namespaces have an entry", async () => {
  await withTempDir(async (dir) => {
    const cache = await TranslationCache.open(dir, KEY);
    cache.set("Text", "sonnet", "SONNET");
    cache.set("Text", "haiku", "HAIKU");
    assertEquals(cache.get("Text", "haiku", "sonnet")?.text, "HAIKU");
  });
});

Deno.test("entries survive a flush and reopen", async () => {
  await withTempDir(async (dir) => {
    const first = await TranslationCache.open(dir, KEY);
    first.set("Persisted", "haiku", "永続");
    await first.flush();
    const second = await TranslationCache.open(dir, KEY);
    assertEquals(second.get("Persisted", "haiku")?.text, "永続");
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
    assertEquals(reopened.get("A", "haiku"), undefined);
    reopened.set("A", "haiku", "あ");
    await reopened.flush();
    assertEquals((await TranslationCache.open(dir, KEY)).get("A", "haiku")?.text, "あ");
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
    assertEquals(cache.get("Hello", "haiku"), undefined);
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
    cache.get("A", "haiku");
    cache.get("B", "haiku");
    assertEquals(cache.stats(), { entries: 1, hits: 1, misses: 1, stores: 1 });
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
