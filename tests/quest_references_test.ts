import { assertEquals } from "@std/assert";
import { referencedKeysIn, scanQuestReferences } from "../src/quests/references.ts";
import {
  CHAPTER_GROUPS_SNBT,
  INTRO_SNBT,
  REFERENCED_KEYS,
  SURVIVAL_SNBT,
} from "./helpers/lang_pack.ts";

const FILES = [
  { path: "overrides/config/ftbquests/quests/chapter_groups.snbt", text: CHAPTER_GROUPS_SNBT },
  { path: "overrides/config/ftbquests/quests/chapters/intro.snbt", text: INTRO_SNBT },
  { path: "overrides/config/ftbquests/quests/chapters/survival.snbt", text: SURVIVAL_SNBT },
];

Deno.test("a whole-value placeholder is a translation-key reference", () => {
  assertEquals(referencedKeysIn("{quest.intro.hotkeys.title}"), ["quest.intro.hotkeys.title"]);
});

Deno.test("a placeholder embedded in a longer string is still a reference", () => {
  // Real packs contain exactly this: a key with a stray trailing space.
  assertEquals(referencedKeysIn("{quest.combat.tesla.description_1} "), [
    "quest.combat.tesla.description_1",
  ]);
});

Deno.test("FTB markup blocks are not translation keys", () => {
  for (
    const markup of [
      "{image:mod:item/x width:100 height:100 align:center}",
      "{player}",
      "{item:minecraft:apple}",
      "{ }",
      "%s and %1$s",
    ]
  ) {
    assertEquals(referencedKeysIn(markup), [], markup);
  }
});

Deno.test("scanning the fixture chapters finds every referenced key once, in order", () => {
  const scan = scanQuestReferences(FILES);
  assertEquals(scan.keys, REFERENCED_KEYS);
  assertEquals(scan.unparsed, []);
  assertEquals(scan.files.length, 3);
});

Deno.test("a key referenced twice is reported once", () => {
  // `quest.guide` is the survival chapter title and a chapter-group title.
  const scan = scanQuestReferences(FILES);
  assertEquals(scan.keys.filter((k) => k === "quest.guide").length, 1);
});

Deno.test("literal user-visible labels are reported, markup and empties are not", () => {
  const scan = scanQuestReferences(FILES);
  const texts = scan.literals.map((l) => l.text).sort();
  assertEquals(texts, ["Any #minecraft:wool", "WIP"]);
  const wip = scan.literals.find((l) => l.text === "WIP")!;
  assertEquals(wip.field, "title");
  assertEquals(wip.file, "overrides/config/ftbquests/quests/chapters/survival.snbt");
});

Deno.test("each key remembers the file that referenced it, and that file's title", () => {
  const scan = scanQuestReferences(FILES);
  assertEquals(
    scan.fileByKey.get("quest.intro.hotkeys.title"),
    "overrides/config/ftbquests/quests/chapters/intro.snbt",
  );
  assertEquals(
    scan.titleByFile.get("overrides/config/ftbquests/quests/chapters/intro.snbt"),
    "{quest.intro}",
  );
  // A file with no title member falls back to its own name.
  assertEquals(
    scan.titleByFile.get("overrides/config/ftbquests/quests/chapter_groups.snbt"),
    "chapter_groups",
  );
});

Deno.test("a quest file that does not parse is reported rather than silently dropped", () => {
  const scan = scanQuestReferences([
    ...FILES,
    { path: "overrides/config/ftbquests/quests/chapters/broken.snbt", text: "{ oops" },
  ]);
  assertEquals(scan.unparsed, ["overrides/config/ftbquests/quests/chapters/broken.snbt"]);
  // The readable files still contributed.
  assertEquals(scan.keys, REFERENCED_KEYS);
});

Deno.test("a quest file that could not be read at all counts as unparsed too", () => {
  // Regression: a ZIP entry that failed to inflate never reached the scanner,
  // so the scan reported full coverage of a set of files it had not seen.
  const unreadable = "overrides/config/ftbquests/quests/chapters/damaged.snbt";
  const scan = scanQuestReferences(FILES, [unreadable]);
  assertEquals(scan.unparsed, [unreadable]);
  assertEquals(scan.files.includes(unreadable), false);
  assertEquals(scan.files.length, 3);
});
