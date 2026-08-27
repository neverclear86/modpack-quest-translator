import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { minecraftLangJsonAdapter as adapter } from "../src/quests/lang_json.ts";
import { ftbQuestsLangAdapter } from "../src/quests/ftbquests_lang.ts";
import { selectAdapter } from "../src/quests/registry.ts";
import { validateDocumentWith } from "../src/translate/validate.ts";
import { englishLang, langJson, REFERENCED_KEYS } from "./helpers/lang_pack.ts";

const SOURCE = langJson();
/** Everything the fixture chapters reference that the jar actually defines. */
const PRESENT = REFERENCED_KEYS.filter((k) => k in englishLang());
const CONTEXT = { keys: PRESENT };

Deno.test("the JSON adapter detects a flat Minecraft lang file", () => {
  assertEquals(adapter.detect(SOURCE).supported, true);
  assertEquals(adapter.payloadExtension, "json");
});

Deno.test("the JSON adapter declines SNBT and non-object JSON", () => {
  assertEquals(adapter.detect('{\n\tquest.A.title: "x"\n}').supported, false);
  assertEquals(adapter.detect("[1,2,3]").supported, false);
  assertEquals(adapter.detect("not json at all").supported, false);
});

Deno.test("the SNBT adapter still wins for an SNBT lang file", () => {
  // Regression: registering a second adapter must not change mode selection for
  // the existing quest-lang path.
  const snbt = '{\n\tquest.0000000000002329.title: "Welcome"\n}\n';
  assertEquals(selectAdapter(snbt).adapter?.id, ftbQuestsLangAdapter.id);
  assertEquals(ftbQuestsLangAdapter.payloadExtension, "snbt");
});

Deno.test("extraction is filtered to the referenced keys only", () => {
  const document = adapter.extract(SOURCE, CONTEXT);
  const keys = document.units.map((u) => u.key);
  assertEquals(keys.includes("unused.key.not.referenced"), false);
  assertEquals(keys.includes("item.examplepack.plant_fiber"), false);
  assertEquals(new Set(keys), new Set(PRESENT));
  assertEquals(document.keyCount, PRESENT.length);
});

Deno.test("extraction without a key filter would take the whole file", () => {
  // The adapter is general: the filter is the caller's policy, not a hard rule.
  assertEquals(adapter.extract(SOURCE).units.length, Object.keys(englishLang()).length);
});

Deno.test("units carry a scalar identity and a useful kind", () => {
  const units = adapter.extract(SOURCE, CONTEXT).units;
  const title = units.find((u) => u.key === "quest.guide.survival.fiber.title")!;
  assertEquals(title.id, "quest.guide.survival.fiber.title");
  assertEquals(title.index, -1);
  assertEquals(title.kind, "title");
  const description = units.find((u) => u.key === "quest.intro.hotkeys.description_1")!;
  // `description_1` is a description, not a kind of its own.
  assertEquals(description.kind, "description");
});

Deno.test("protected tokens are detected the same way as in SNBT mode", () => {
  const units = adapter.extract(SOURCE, CONTEXT).units;
  const subtitle = units.find((u) => u.key === "quest.intro.hotkeys.subtitle")!;
  assertEquals(subtitle.protectedTokens, ["&6", "&r"]);
  const percent = units.find((u) => u.key === "quest.intro.hotkeys.description_2")!;
  assertEquals(percent.protectedTokens, ["%s"]);
});

Deno.test("apply writes only the extracted keys, as pretty JSON with a trailing newline", () => {
  const units = adapter.extract(SOURCE, CONTEXT).units;
  const translations = new Map(units.map((u) => [u.id, u.text === "" ? "" : `[ja] ${u.text}`]));
  const output = adapter.apply(SOURCE, translations, CONTEXT);

  const parsed = JSON.parse(output) as Record<string, string>;
  assertEquals(new Set(Object.keys(parsed)), new Set(PRESENT));
  assertEquals(parsed["quest.guide.survival.fiber.title"], "[ja] Fiber on Demand");
  assertEquals(parsed["quest.guide.survival.fiber.description_2"], "");
  assertEquals(output.endsWith("\n"), true);
  assertStringIncludes(output, '\n  "quest.main"');
  // Nothing from the untranslated remainder of the source file leaks through.
  assertEquals(output.includes("must never reach"), false);
});

Deno.test("apply is deterministic and keeps the source file's key order", () => {
  const units = adapter.extract(SOURCE, CONTEXT).units;
  const translations = new Map(units.map((u) => [u.id, u.text]));
  const first = adapter.apply(SOURCE, translations, CONTEXT);
  assertEquals(adapter.apply(SOURCE, translations, CONTEXT), first);
  const order = Object.keys(JSON.parse(first));
  const sourceOrder = Object.keys(englishLang()).filter((k) => PRESENT.includes(k));
  assertEquals(order, sourceOrder);
});

Deno.test("apply refuses a missing or an unknown translation id", () => {
  const units = adapter.extract(SOURCE, CONTEXT).units;
  const short = new Map(units.slice(1).map((u) => [u.id, u.text]));
  assertThrows(() => adapter.apply(SOURCE, short, CONTEXT), AppError, "No translation");

  const extra = new Map(units.map((u) => [u.id, u.text]));
  extra.set("never.requested.key", "x");
  assertThrows(() => adapter.apply(SOURCE, extra, CONTEXT), AppError, "not in the source");
});

Deno.test("a referenced key whose value is not a string is refused", () => {
  const source = JSON.stringify({ "quest.a.title": ["an", "array"], "quest.b.title": "fine" });
  assertThrows(
    () => adapter.extract(source, { keys: ["quest.a.title", "quest.b.title"] }),
    AppError,
    "quest.a.title",
  );
});

Deno.test("an unreferenced non-string value is ignored rather than fatal", () => {
  const source = JSON.stringify({ "meta.debug": { nested: true }, "quest.b.title": "fine" });
  const document = adapter.extract(source, { keys: ["quest.b.title"] });
  assertEquals(document.units.map((u) => u.key), ["quest.b.title"]);
});

Deno.test("document validation compares the filtered key set and value shapes", () => {
  const units = adapter.extract(SOURCE, CONTEXT).units;
  const translations = new Map(units.map((u) => [u.id, u.text === "" ? "" : `[ja] ${u.text}`]));
  const output = adapter.apply(SOURCE, translations, CONTEXT);
  assertEquals(validateDocumentWith(adapter, SOURCE, output, CONTEXT).ok, true);

  const dropped = JSON.parse(output) as Record<string, string>;
  delete dropped["quest.main"];
  const result = validateDocumentWith(adapter, SOURCE, JSON.stringify(dropped), CONTEXT);
  assertEquals(result.ok, false);
  assertEquals(result.problems[0].kind, "missing-key");
});

Deno.test("document validation refuses output that is not JSON", () => {
  const result = validateDocumentWith(adapter, SOURCE, "{ not json", CONTEXT);
  assertEquals(result.ok, false);
  assertEquals(result.problems[0].kind, "parse");
});
