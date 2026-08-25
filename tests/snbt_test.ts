import { assertEquals, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { parseSnbt, serializeSnbt, type SnbtCompound } from "../src/quests/snbt/mod.ts";

function roundTrip(text: string): string {
  return serializeSnbt(parseSnbt(text));
}

Deno.test("parses the FTB Quests lang dialect: unquoted dotted keys, newline separators", () => {
  const src =
    '{\n\tchapter.032B1396E6C49A89.title: "Create: Core"\n\tquest.0000000000000002.title: "Cogwheel"\n}\n';
  const root = parseSnbt(src);
  assertEquals(root.type, "compound");
  assertEquals(root.members.map((m) => m.key), [
    "chapter.032B1396E6C49A89.title",
    "quest.0000000000000002.title",
  ]);
  assertEquals(root.members[0].value, { type: "string", value: "Create: Core" });
});

Deno.test("round-trips a single-line array exactly", () => {
  const src = '{\n\tquest.0000000000000002.quest_desc: ["Craft your first cogwheel."]\n}\n';
  assertEquals(roundTrip(src), src);
});

Deno.test("round-trips a multi-line array exactly", () => {
  const src =
    '{\n\tquest.A.quest_desc: [\n\t\t"Line one."\n\t\t""\n\t\t"Line &6three&r."\n\t]\n}\n';
  assertEquals(roundTrip(src), src);
});

Deno.test("preserves the literal backslash-ampersand escape FTB writes", () => {
  const src = '{\n\tchapter.X.title: "Create: Bells \\\\& Whistles"\n}\n';
  const root = parseSnbt(src);
  assertEquals(root.members[0].value, { type: "string", value: "Create: Bells \\& Whistles" });
  assertEquals(roundTrip(src), src);
});

Deno.test("preserves formatting codes, image placeholders and unicode", () => {
  const src =
    '{\n\ta.b.quest_desc: [\n\t\t"The &bCobblemon&r chapter"\n\t\t"{image:mod:item/x width:100 height:100 align:center}"\n\t\t"Pokémon を捕まえる"\n\t]\n}\n';
  assertEquals(roundTrip(src), src);
});

Deno.test("handles all string escape sequences", () => {
  const root = parseSnbt('{\n\tk: "a\\"b\\\\c\\nd\\te\\u00e9f\\/g"\n}\n');
  assertEquals(root.members[0].value, { type: "string", value: 'a"b\\c\nd\te\u00e9f/g' });
});

Deno.test("serializes escapes back into the minimal canonical form", () => {
  const src = '{\n\tk: "quote \\" backslash \\\\ newline \\n tab \\t"\n}\n';
  assertEquals(roundTrip(src), src);
});

Deno.test("single-quoted strings are parsed and normalised to double quotes", () => {
  const root = parseSnbt("{\n\tk: 'it\\'s'\n}\n");
  assertEquals(root.members[0].value, { type: "string", value: "it's" });
  assertEquals(serializeSnbt(root), '{\n\tk: "it\'s"\n}\n');
});

Deno.test("quoted keys round-trip and stay quoted", () => {
  const src = '{\n\t"key with space": "v"\n}\n';
  assertEquals(roundTrip(src), src);
});

Deno.test("parses chapter-file constructs: nested compounds, typed numbers, booleans", () => {
  const src = [
    "{",
    "\tdefault_hide_dependency_lines: false",
    '\tfilename: "rubius_main"',
    "\torder_index: 0",
    "\tquest_links: [ ]",
    "\tquests: [",
    "\t\t{",
    '\t\t\tid: "0000000000002329"',
    "\t\t\ttable_id: 264534277666289367L",
    "\t\t\tx: 0.0d",
    "\t\t\ty: -1.5f",
    "\t\t\tcount: 3b",
    "\t\t\tshort_val: 12s",
    "\t\t}",
    "\t]",
    "}",
    "",
  ].join("\n");
  const root = parseSnbt(src);
  assertEquals(root.members[0].value, { type: "boolean", value: false });
  assertEquals(roundTrip(src), src);
});

Deno.test("preserves the [{...}] hugging style FTB writes for single-compound arrays", () => {
  // Real chapter files write `tasks: [{` ... `}]` with the brackets hugging the
  // compound rather than each on its own line.
  const src = [
    "{",
    "\ta: [{",
    '\t\tid: "104CF098E2B9D97B"',
    '\t\ttype: "checkmark"',
    "\t}]",
    "}",
    "",
  ].join("\n");
  assertEquals(roundTrip(src), src);
});

Deno.test("a block array keeps its own line for each element", () => {
  const src = '{\n\ta: [\n\t\t{\n\t\t\tk: "v"\n\t\t}\n\t]\n}\n';
  assertEquals(roundTrip(src), src);
});

Deno.test("parses typed arrays", () => {
  const src = "{\n\ta: [I;1, 2, 3]\n\tb: [B;1b, 2b]\n\tc: [L;1L]\n}\n";
  const root = parseSnbt(src);
  assertEquals(root.members[0].value.type, "typedArray");
  assertEquals(roundTrip(src), src);
});

Deno.test("comma separators are accepted as well as newlines", () => {
  const root = parseSnbt('{a: "1", b: "2", c: "3"}');
  assertEquals(root.members.map((m) => m.key), ["a", "b", "c"]);
});

Deno.test("a trailing comma is tolerated", () => {
  const root = parseSnbt('{a: "1", b: "2",}');
  assertEquals(root.members.length, 2);
});

Deno.test("empty compounds and arrays round-trip", () => {
  assertEquals(roundTrip("{\n\ta: { }\n\tb: [ ]\n}\n"), "{\n\ta: { }\n\tb: [ ]\n}\n");
  assertEquals(roundTrip("{ }"), "{ }");
});

Deno.test("member order is preserved rather than sorted", () => {
  const root = parseSnbt('{\n\tz: "1"\n\ta: "2"\n\tm: "3"\n}\n');
  assertEquals(root.members.map((m) => m.key), ["z", "a", "m"]);
});

Deno.test("CRLF input is accepted", () => {
  const root = parseSnbt('{\r\n\ta: "1"\r\n\tb: "2"\r\n}\r\n');
  assertEquals(root.members.map((m) => m.key), ["a", "b"]);
});

Deno.test("CRLF line endings survive a round trip", () => {
  // Real FTB Quests lang files ship with CRLF; rewriting them as LF would make
  // every line of the file a spurious diff against the pack's own output.
  const src =
    '{\r\n\tchapter.A.title: "Create: Core"\r\n\tquest.B.quest_desc: [\r\n\t\t"one"\r\n\t\t"two"\r\n\t]\r\n}\r\n';
  assertEquals(roundTrip(src), src);
});

Deno.test("line ending detection reports what the source used", () => {
  assertEquals(parseSnbt('{\r\n\ta: "1"\r\n}\r\n').lineEnding, "\r\n");
  assertEquals(parseSnbt('{\n\ta: "1"\n}\n').lineEnding, "\n");
});

Deno.test("malformed documents raise E_VALIDATION with a line and column", () => {
  const err = assertThrows(() => parseSnbt('{\n\ta: "unterminated\n}\n'), AppError) as AppError;
  assertEquals(err.code, "E_VALIDATION");
  assertEquals(typeof err.details?.line, "number");

  assertThrows(() => parseSnbt("not a compound"), AppError);
  assertThrows(() => parseSnbt("{"), AppError);
  assertThrows(() => parseSnbt('{a: "1"} trailing'), AppError);
  assertThrows(() => parseSnbt("{a:}"), AppError);
  assertThrows(() => parseSnbt('{: "1"}'), AppError);
});

Deno.test("duplicate keys are rejected: silently dropping one would lose a quest string", () => {
  const err = assertThrows(() => parseSnbt('{\n\ta: "1"\n\ta: "2"\n}\n'), AppError) as AppError;
  assertEquals(err.code, "E_VALIDATION");
});

Deno.test("nesting depth is bounded", () => {
  const deep = "{a:".repeat(300) + "{}" + "}".repeat(300);
  assertThrows(() => parseSnbt(deep), AppError);
});

Deno.test("a file without a trailing newline round-trips without gaining one", () => {
  assertEquals(roundTrip('{\n\ta: "1"\n}'), '{\n\ta: "1"\n}');
});

Deno.test("compound helpers read and rewrite values by key", () => {
  const root: SnbtCompound = parseSnbt('{\n\ta: "1"\n\tb: ["x"]\n}\n');
  assertEquals(root.members.find((m) => m.key === "a")?.value.type, "string");
  assertEquals(root.members.find((m) => m.key === "b")?.value.type, "array");
});

Deno.test("fixtures modelled on a real pack round-trip byte for byte", async () => {
  for (const name of ["lang_en_us.snbt", "chapter_rubius_main.snbt"]) {
    const src = await Deno.readTextFile(new URL(`./fixtures/snbt/${name}`, import.meta.url));
    assertEquals(
      roundTrip(src),
      src,
      `${name} did not round-trip; the serializer is not the parser's inverse`,
    );
  }
});
