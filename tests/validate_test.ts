import { assertEquals } from "@std/assert";
import { validateDocument, validateResponseIds, validateUnit } from "../src/translate/validate.ts";
import type { TranslationUnit } from "../src/quests/adapter.ts";

function unit(text: string, over: Partial<TranslationUnit> = {}): TranslationUnit {
  return {
    id: "quest.A.title",
    key: "quest.A.title",
    kind: "title",
    index: -1,
    text,
    protectedTokens: [],
    ...over,
  };
}

Deno.test("a plain translation passes", () => {
  assertEquals(validateUnit(unit("Hello world"), "こんにちは世界").ok, true);
});

Deno.test("an empty source must stay exactly empty", () => {
  assertEquals(validateUnit(unit(""), "").ok, true);
  const bad = validateUnit(unit(""), "何か");
  assertEquals(bad.ok, false);
  assertEquals(bad.problems[0].kind, "empty-source-changed");
});

Deno.test("a whitespace-only source must be returned unchanged", () => {
  assertEquals(validateUnit(unit("   "), "   ").ok, true);
  assertEquals(validateUnit(unit("   "), "テキスト").ok, false);
});

Deno.test("a non-empty source may not become empty", () => {
  const r = validateUnit(unit("Cogwheel"), "");
  assertEquals(r.ok, false);
  assertEquals(r.problems[0].kind, "empty-translation");
});

Deno.test("formatting codes must survive with the same multiset", () => {
  assertEquals(validateUnit(unit("The &bCobblemon&r chapter"), "&bコブルモン&rの章").ok, true);
  const dropped = validateUnit(unit("The &bCobblemon&r chapter"), "コブルモンの章");
  assertEquals(dropped.ok, false);
  assertEquals(dropped.problems[0].kind, "formatting-codes");
  assertEquals(validateUnit(unit("&6a&r"), "&6a&r&r").ok, false, "extra code must fail");
  assertEquals(validateUnit(unit("&6a&r"), "&ra&6").ok, true, "order may change, multiset may not");
});

Deno.test("section-sign codes are handled like ampersand codes", () => {
  assertEquals(validateUnit(unit("§cDanger§r"), "§c危険§r").ok, true);
  assertEquals(validateUnit(unit("§cDanger§r"), "危険").ok, false);
});

Deno.test("an escaped ampersand is a literal, not a formatting code", () => {
  // FTB writes `\&` for a literal ampersand. `\&6` must not count as code &6.
  assertEquals(validateUnit(unit("Bells \\& Whistles"), "ベル \\& ホイッスル").ok, true);
  const lost = validateUnit(unit("Bells \\& Whistles"), "ベル & ホイッスル");
  assertEquals(lost.ok, false);
  assertEquals(lost.problems[0].kind, "escaped-ampersand");
});

Deno.test("printf placeholders must survive", () => {
  assertEquals(validateUnit(unit("You need %s more"), "あと %s 必要").ok, true);
  assertEquals(validateUnit(unit("You need %s more"), "あと必要").ok, false);
  assertEquals(validateUnit(unit("%1$s gave %2$s"), "%2$s が %1$s を渡した").ok, true);
  assertEquals(validateUnit(unit("%1$s gave %2$s"), "%1$s が %1$s を渡した").ok, false);
});

Deno.test("FTB brace placeholders must survive verbatim", () => {
  const src = "{image:mod:item/x width:100 height:100 align:center}";
  assertEquals(validateUnit(unit(src), src).ok, true);
  assertEquals(validateUnit(unit(src), "{image:mod:item/x 幅:100}").ok, false);
});

Deno.test("angle-bracket mod variables must survive", () => {
  assertEquals(validateUnit(unit("Hi <player_name>"), "こんにちは <player_name>").ok, true);
  assertEquals(validateUnit(unit("Hi <player_name>"), "こんにちは <プレイヤー名>").ok, false);
});

Deno.test("a translation identical to a non-trivial source is flagged as untranslated", () => {
  const r = validateUnit(unit("Craft your first cogwheel."), "Craft your first cogwheel.");
  assertEquals(r.ok, false);
  assertEquals(r.problems[0].kind, "unchanged");
});

Deno.test("short technical strings may legitimately come back unchanged", () => {
  // Item names, mod names and pure-placeholder strings are not a failure.
  assertEquals(validateUnit(unit("Create"), "Create").ok, true);
  assertEquals(validateUnit(unit("%s"), "%s").ok, true);
  assertEquals(validateUnit(unit("&6"), "&6").ok, true);
});

Deno.test("a glossary term may be required to appear verbatim", () => {
  const u = unit("The Create mod adds Ponder.");
  const glossary = { Create: "Create", Ponder: "Ponder" };
  assertEquals(validateUnit(u, "Create モッドは Ponder を追加します。", { glossary }).ok, true);
  const bad = validateUnit(u, "クリエイト モッドは ポンダー を追加します。", { glossary });
  assertEquals(bad.ok, false);
  assertEquals(bad.problems[0].kind, "glossary");
});

Deno.test("response ids must match the request exactly", () => {
  const requested = ["a", "b", "c"];
  assertEquals(validateResponseIds(requested, [{ id: "a" }, { id: "b" }, { id: "c" }]).ok, true);
  const missing = validateResponseIds(requested, [{ id: "a" }, { id: "b" }]);
  assertEquals(missing.ok, false);
  assertEquals(missing.missing, ["c"]);
  const unknown = validateResponseIds(requested, [
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "z" },
  ]);
  assertEquals(unknown.ok, false);
  assertEquals(unknown.unknown, ["z"]);
  const dup = validateResponseIds(requested, [{ id: "a" }, { id: "a" }, { id: "b" }, { id: "c" }]);
  assertEquals(dup.ok, false);
  assertEquals(dup.duplicates, ["a"]);
});

Deno.test("document validation requires an identical key set", () => {
  const src = '{\n\ta.b.title: "One"\n\ta.c.title: "Two"\n}\n';
  assertEquals(validateDocument(src, '{\n\ta.b.title: "1"\n\ta.c.title: "2"\n}\n').ok, true);
  const dropped = validateDocument(src, '{\n\ta.b.title: "1"\n}\n');
  assertEquals(dropped.ok, false);
  assertEquals(dropped.problems.some((p) => p.kind === "missing-key"), true);
  const added = validateDocument(
    src,
    '{\n\ta.b.title: "1"\n\ta.c.title: "2"\n\ta.d.title: "3"\n}\n',
  );
  assertEquals(added.ok, false);
  assertEquals(added.problems.some((p) => p.kind === "extra-key"), true);
});

Deno.test("document validation requires compatible value shapes", () => {
  const src = '{\n\ta.b.quest_desc: ["one", "two"]\n}\n';
  assertEquals(validateDocument(src, '{\n\ta.b.quest_desc: ["一", "二"]\n}\n').ok, true);
  const wrongLength = validateDocument(src, '{\n\ta.b.quest_desc: ["一"]\n}\n');
  assertEquals(wrongLength.ok, false);
  assertEquals(wrongLength.problems[0].kind, "array-length");
  const wrongType = validateDocument(src, '{\n\ta.b.quest_desc: "一二"\n}\n');
  assertEquals(wrongType.ok, false);
  assertEquals(wrongType.problems[0].kind, "value-type");
});

Deno.test("document validation rejects output that does not parse", () => {
  const r = validateDocument('{\n\ta.b.title: "One"\n}\n', "{ this is not snbt");
  assertEquals(r.ok, false);
  assertEquals(r.problems[0].kind, "parse");
});

Deno.test("a placeholder that changes its width or precision is rejected", () => {
  // %02d -> %2d silently drops the zero padding, so the clock reads "9:5".
  const u = unit("Countdown %02d:%02d");
  assertEquals(validateUnit(u, "カウントダウン %02d:%02d").ok, true);
  const widened = validateUnit(u, "カウントダウン %2d:%02d");
  assertEquals(widened.ok, false);
  assertEquals(widened.problems[0].kind, "placeholders");

  const precise = unit("%1$.2f SU");
  assertEquals(validateUnit(precise, "%1$.2f SU").ok, true);
  const rounded = validateUnit(precise, "%1$.0f SU");
  assertEquals(rounded.ok, false);
  assertEquals(rounded.problems[0].kind, "placeholders");
});

Deno.test("relative and C-style conversions must survive", () => {
  assertEquals(validateUnit(unit("%s (%<s) is ready"), "%s (%<s) の準備ができました").ok, true);
  assertEquals(validateUnit(unit("%s (%<s) is ready"), "%s (%s) の準備ができました").ok, false);
  assertEquals(validateUnit(unit("Holds %u buckets"), "%u バケツを保持します").ok, true);
  assertEquals(validateUnit(unit("Holds %u buckets"), "バケツを保持します").ok, false);
  assertEquals(validateUnit(unit("Stack of %i items"), "%i 個のアイテムの束").ok, true);
});

Deno.test("a literal %% may not become a bare percent sign", () => {
  const u = unit("Efficiency is now 100%% of the maximum");
  assertEquals(validateUnit(u, "効率は最大の 100%% になりました").ok, true);
  const collapsed = validateUnit(u, "効率は最大の 100% になりました");
  assertEquals(collapsed.ok, false);
  assertEquals(collapsed.problems[0].kind, "placeholders");
});

Deno.test("an ordinary percentage in prose is not treated as a placeholder", () => {
  // A false positive here would fail a perfectly good translation.
  assertEquals(
    validateUnit(unit("Deals 50% more damage to mobs"), "モブへのダメージが50%増加").ok,
    true,
  );
  assertEquals(validateUnit(unit("A 5% chance to drop"), "ドロップ率は5パーセントです").ok, true);
});

Deno.test("the unchanged check uses the same placeholder detector", () => {
  // A string that is nothing but markup has no prose to translate, so coming
  // back byte-identical is correct rather than a validation failure.
  assertEquals(validateUnit(unit("%02d:%02d:%02d"), "%02d:%02d:%02d").ok, true);
  assertEquals(validateUnit(unit("&6%1$.2f&r %%"), "&6%1$.2f&r %%").ok, true);
  // Real prose of the same length must still be flagged.
  const prose = validateUnit(unit("Place the cogwheel"), "Place the cogwheel");
  assertEquals(prose.ok, false);
  assertEquals(prose.problems[0].kind, "unchanged");
});
