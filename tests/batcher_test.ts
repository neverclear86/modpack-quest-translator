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
