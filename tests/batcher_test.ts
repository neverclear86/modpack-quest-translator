import { assertEquals } from "@std/assert";
import { buildBatches } from "../src/translate/batcher.ts";
import type { TranslationUnit } from "../src/quests/adapter.ts";

function units(
  count: number,
  over: (i: number) => Partial<TranslationUnit> = () => ({}),
): TranslationUnit[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `quest.${i}.title`,
    key: `quest.${i}.title`,
    kind: "title",
    index: -1,
    text: `Text number ${i}`,
    protectedTokens: [],
    ...over(i),
  }));
}

Deno.test("units are grouped up to the item limit", () => {
  const batches = buildBatches(units(10), { maxItems: 4, maxChars: 100_000 });
  assertEquals(batches.map((b) => b.units.length), [4, 4, 2]);
});

Deno.test("units are grouped up to the character budget", () => {
  const long = units(6, () => ({ text: "x".repeat(100) }));
  const batches = buildBatches(long, { maxItems: 100, maxChars: 250 });
  assertEquals(batches.map((b) => b.units.length), [2, 2, 2]);
});

Deno.test("batching is stable and loses nothing", () => {
  const all = units(37);
  const batches = buildBatches(all, { maxItems: 5, maxChars: 10_000 });
  assertEquals(batches.flatMap((b) => b.units.map((u) => u.id)), all.map((u) => u.id));
  const again = buildBatches(all, { maxItems: 5, maxChars: 10_000 });
  assertEquals(JSON.stringify(again), JSON.stringify(batches));
});

Deno.test("batches never mix chapters", () => {
  const mixed = units(6, (i) => ({ chapter: i < 3 ? "Create: Core" : "Exploration" }));
  const batches = buildBatches(mixed, { maxItems: 10, maxChars: 10_000 });
  assertEquals(batches.length, 2);
  assertEquals(batches[0].chapter, "Create: Core");
  assertEquals(batches[1].chapter, "Exploration");
});

Deno.test("a unit larger than the character budget becomes its own long-prose batch", () => {
  const list = [
    ...units(2),
    ...units(
      1,
      () => ({ id: "quest.big.quest_desc", key: "quest.big.quest_desc", text: "y".repeat(5000) }),
    ),
    ...units(2, (i) => ({ id: `quest.tail${i}.title`, key: `quest.tail${i}.title` })),
  ];
  const batches = buildBatches(list, { maxItems: 10, maxChars: 500 });
  const big = batches.find((b) => b.units.some((u) => u.id === "quest.big.quest_desc"))!;
  assertEquals(big.units.length, 1);
  assertEquals(big.longProse, true);
  assertEquals(batches.filter((b) => b.longProse).length, 1);
});

Deno.test("empty input produces no batches", () => {
  assertEquals(buildBatches([], { maxItems: 10, maxChars: 100 }), []);
});

Deno.test("each batch has a stable index and id", () => {
  const batches = buildBatches(units(5), { maxItems: 2, maxChars: 10_000 });
  assertEquals(batches.map((b) => b.index), [0, 1, 2]);
  assertEquals(new Set(batches.map((b) => b.id)).size, 3);
});

Deno.test("units keep their order inside a batch", () => {
  const batches = buildBatches(units(3), { maxItems: 10, maxChars: 10_000 });
  assertEquals(batches[0].units.map((u) => u.id), [
    "quest.0.title",
    "quest.1.title",
    "quest.2.title",
  ]);
});

Deno.test("interleaved chapter units collapse into chapter-grouped batches", () => {
  // SNBT id order interleaves chapters, which is what the real pack looks like.
  const chapters = ["Create: Core", "Exploration", "Aeronautics"];
  const interleaved = units(9, (i) => ({ chapter: chapters[i % 3] }));

  const batches = buildBatches(interleaved, { maxItems: 10, maxChars: 10_000 });

  // One batch per chapter, in first-seen order, not one batch per chapter change.
  assertEquals(batches.map((b) => b.chapter), ["Create: Core", "Exploration", "Aeronautics"]);
  assertEquals(batches.map((b) => b.units.length), [3, 3, 3]);
  // Source order is preserved inside each chapter.
  assertEquals(batches[0].units.map((u) => u.id), [
    "quest.0.title",
    "quest.3.title",
    "quest.6.title",
  ]);
  assertEquals(batches[1].units.map((u) => u.id), [
    "quest.1.title",
    "quest.4.title",
    "quest.7.title",
  ]);
  // Nothing is lost.
  assertEquals(batches.flatMap((b) => b.units).length, 9);
});

Deno.test("chapter groups are still chunked by the item and character limits", () => {
  const interleaved = units(12, (i) => ({ chapter: i % 2 === 0 ? "Alpha" : "Beta" }));
  const batches = buildBatches(interleaved, { maxItems: 4, maxChars: 10_000 });
  assertEquals(batches.map((b) => b.chapter), ["Alpha", "Alpha", "Beta", "Beta"]);
  assertEquals(batches.map((b) => b.units.length), [4, 2, 4, 2]);
});

Deno.test("units without a chapter group together rather than splitting the batch", () => {
  const mixed = units(6, (i) => ({ chapter: i % 2 === 0 ? "Alpha" : undefined }));
  const batches = buildBatches(mixed, { maxItems: 10, maxChars: 10_000 });
  assertEquals(batches.length, 2);
  assertEquals(batches[0].chapter, "Alpha");
  assertEquals(batches[1].chapter, undefined);
  assertEquals(batches[1].units.map((u) => u.id), [
    "quest.1.title",
    "quest.3.title",
    "quest.5.title",
  ]);
});

Deno.test("a long-prose unit is isolated without breaking up its chapter", () => {
  const list = [
    ...units(1, () => ({ id: "a.title", key: "a.title", chapter: "Alpha" })),
    ...units(1, () => ({ id: "b.title", key: "b.title", chapter: "Beta" })),
    ...units(1, () => ({
      id: "a.big.quest_desc",
      key: "a.big.quest_desc",
      chapter: "Alpha",
      text: "y".repeat(5000),
    })),
    ...units(1, () => ({ id: "a2.title", key: "a2.title", chapter: "Alpha" })),
  ];
  const batches = buildBatches(list, { maxItems: 10, maxChars: 500 });
  assertEquals(batches.filter((b) => b.longProse).length, 1);
  const big = batches.find((b) => b.longProse)!;
  assertEquals(big.units.map((u) => u.id), ["a.big.quest_desc"]);
  assertEquals(big.chapter, "Alpha");
  // The rest of Alpha stays together; Beta is untouched.
  const alpha = batches.filter((b) => b.chapter === "Alpha" && !b.longProse);
  assertEquals(alpha.flatMap((b) => b.units.map((u) => u.id)), ["a.title", "a2.title"]);
  assertEquals(batches.filter((b) => b.chapter === "Beta").length, 1);
});
