import { assertEquals, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { ftbQuestsLangAdapter } from "../src/quests/ftbquests_lang.ts";
import { buildChapterIndex } from "../src/quests/chapter_index.ts";

const LANG = [
  "{",
  '\tchapter.AAAA.title: "Create: Core"',
  '\tquest.BBBB.title: "Cogwheel"',
  '\tquest.BBBB.quest_desc: ["Craft your first cogwheel."]',
  "\tquest.CCCC.quest_desc: [",
  '\t\t"Line one."',
  '\t\t""',
  '\t\t"Line &6three&r."',
  "\t]",
  '\tquest.DDDD.title: ""',
  "}",
  "",
].join("\n");

Deno.test("extract yields one unit per translatable string, in document order", () => {
  const doc = ftbQuestsLangAdapter.extract(LANG);
  assertEquals(doc.units.map((u) => u.id), [
    "chapter.AAAA.title",
    "quest.BBBB.title",
    "quest.BBBB.quest_desc#0",
    "quest.CCCC.quest_desc#0",
    "quest.CCCC.quest_desc#1",
    "quest.CCCC.quest_desc#2",
    "quest.DDDD.title",
  ]);
  assertEquals(doc.units[0].text, "Create: Core");
  assertEquals(doc.units[4].text, "");
});

Deno.test("units carry their key, kind and array index", () => {
  const doc = ftbQuestsLangAdapter.extract(LANG);
  const u = doc.units.find((x) => x.id === "quest.CCCC.quest_desc#2")!;
  assertEquals(u.key, "quest.CCCC.quest_desc");
  assertEquals(u.kind, "quest_desc");
  assertEquals(u.index, 2);
  assertEquals(u.objectId, "CCCC");
  const t = doc.units.find((x) => x.id === "quest.BBBB.title")!;
  assertEquals(t.kind, "title");
  assertEquals(t.index, -1);
});

Deno.test("protected tokens are detected for the provider prompt", () => {
  const doc = ftbQuestsLangAdapter.extract(LANG);
  const u = doc.units.find((x) => x.id === "quest.CCCC.quest_desc#2")!;
  assertEquals(u.protectedTokens, ["&6", "&r"]);
  const plain = doc.units.find((x) => x.id === "quest.BBBB.title")!;
  assertEquals(plain.protectedTokens, []);
});

Deno.test("apply rewrites values by id and preserves everything else exactly", () => {
  const doc = ftbQuestsLangAdapter.extract(LANG);
  const translations = new Map(doc.units.map((u) => [u.id, u.text === "" ? "" : `JA:${u.text}`]));
  const out = ftbQuestsLangAdapter.apply(LANG, translations);
  assertEquals(out.includes('chapter.AAAA.title: "JA:Create: Core"'), true);
  assertEquals(out.includes('quest.BBBB.quest_desc: ["JA:Craft your first cogwheel."]'), true);
  assertEquals(out.includes('\t\t""'), true, "empty array element must stay empty");
  assertEquals(out.includes('quest.DDDD.title: ""'), true);
  // Structure is untouched: same line count, same multi-line array shape.
  assertEquals(out.split("\n").length, LANG.split("\n").length);
});

Deno.test("apply refuses to run when a unit is missing a translation", () => {
  const doc = ftbQuestsLangAdapter.extract(LANG);
  const partial = new Map(doc.units.slice(1).map((u) => [u.id, u.text]));
  const err = assertThrows(() => ftbQuestsLangAdapter.apply(LANG, partial), AppError) as AppError;
  assertEquals(err.code, "E_VALIDATION");
});

Deno.test("apply rejects translations for ids that are not in the document", () => {
  const doc = ftbQuestsLangAdapter.extract(LANG);
  const extra = new Map(doc.units.map((u) => [u.id, u.text]));
  extra.set("quest.NOPE.title", "ghost");
  assertThrows(() => ftbQuestsLangAdapter.apply(LANG, extra), AppError);
});

Deno.test("apply preserves CRLF and array layout from the source", () => {
  const crlf = LANG.replace(/\n/g, "\r\n");
  const doc = ftbQuestsLangAdapter.extract(crlf);
  const map = new Map(doc.units.map((u) => [u.id, u.text]));
  assertEquals(ftbQuestsLangAdapter.apply(crlf, map), crlf);
});

Deno.test("detect accepts a modern lang file and rejects other documents", () => {
  assertEquals(ftbQuestsLangAdapter.detect(LANG).supported, true);
  const inline = '{\n\tquests: [\n\t\t{\n\t\t\tid: "AAAA"\n\t\t\ttitle: "x"\n\t\t}\n\t]\n}\n';
  const result = ftbQuestsLangAdapter.detect(inline);
  assertEquals(result.supported, false);
  assertEquals(typeof result.reason, "string");
});

Deno.test("detect rejects a lang file with no translatable strings", () => {
  assertEquals(ftbQuestsLangAdapter.detect("{ }").supported, false);
});

Deno.test("non-string, non-array values are left alone rather than translated", () => {
  const src = '{\n\tquest.A.title: "Hi"\n\tsome_flag: true\n\tsome_number: 12\n}\n';
  const doc = ftbQuestsLangAdapter.extract(src);
  assertEquals(doc.units.map((u) => u.id), ["quest.A.title"]);
  const out = ftbQuestsLangAdapter.apply(src, new Map([["quest.A.title", "こんにちは"]]));
  assertEquals(out.includes("some_flag: true"), true);
  assertEquals(out.includes("some_number: 12"), true);
});

Deno.test("chapter index maps quest, task and reward ids to chapter titles", () => {
  const chapter = [
    "{",
    '\tid: "CH01"',
    '\tfilename: "core"',
    "\tquests: [",
    "\t\t{",
    '\t\t\tid: "BBBB"',
    "\t\t\ttasks: [{",
    '\t\t\t\tid: "T111"',
    '\t\t\t\ttype: "checkmark"',
    "\t\t\t}]",
    "\t\t\trewards: [{",
    '\t\t\t\tid: "R222"',
    '\t\t\t\ttype: "xp"',
    "\t\t\t}]",
    "\t\t}",
    "\t]",
    "}",
    "",
  ].join("\n");
  const index = buildChapterIndex([{ path: "chapters/core.snbt", text: chapter }], {
    "chapter.CH01.title": "Create: Core",
  });
  assertEquals(index.get("BBBB"), "Create: Core");
  assertEquals(index.get("T111"), "Create: Core");
  assertEquals(index.get("R222"), "Create: Core");
  assertEquals(index.get("UNKNOWN"), undefined);
});

Deno.test("chapter index falls back to the filename when no title is known", () => {
  const chapter = '{\n\tid: "CH02"\n\tfilename: "storage"\n\tquests: [{\n\t\tid: "QQQQ"\n\t}]\n}\n';
  const index = buildChapterIndex([{ path: "chapters/storage.snbt", text: chapter }], {});
  assertEquals(index.get("QQQQ"), "storage");
});

Deno.test("an unparseable chapter file degrades context instead of failing the run", () => {
  const index = buildChapterIndex([{ path: "chapters/broken.snbt", text: "{ not valid" }], {});
  assertEquals(index.size, 0);
});
