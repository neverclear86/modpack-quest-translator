import { assertEquals } from "@std/assert";
import { EchoProvider } from "../src/translate/providers/echo.ts";
import { validateUnit } from "../src/translate/validate.ts";

const options = { model: "echo" };

Deno.test("echo preflight always succeeds and needs nothing installed", async () => {
  const report = await new EchoProvider().preflight();
  assertEquals(report.ok, true);
});

Deno.test("echo marks text with the target locale and is deterministic", async () => {
  const provider = new EchoProvider();
  const request = {
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    context: {},
    glossary: {},
    items: [{ id: "a", kind: "title", text: "Hello world", protectedTokens: [] }],
  };
  const first = await provider.translateBatch(request, options);
  const second = await provider.translateBatch(request, options);
  assertEquals(first.items, second.items);
  assertEquals(first.items[0].id, "a");
  assertEquals(first.items[0].text.includes("Hello world"), true);
  assertEquals(first.items[0].text.includes("ja_jp"), true);
});

Deno.test("echo output passes the real validator", async () => {
  // The offline end-to-end path is only meaningful if echo output survives the
  // same validation a real provider's output must.
  const texts = [
    "Craft your first cogwheel.",
    "The &bCobblemon&r chapter will guide you.",
    "You need %s more of %1$s.",
    "{image:mod:item/x width:100 height:100 align:center}",
    "Bells \\& Whistles",
    "",
    "   ",
  ];
  const provider = new EchoProvider();
  const response = await provider.translateBatch({
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    context: {},
    glossary: { Create: "Create" },
    items: texts.map((text, i) => ({ id: `i${i}`, kind: "title", text, protectedTokens: [] })),
  }, options);

  for (const [i, text] of texts.entries()) {
    const unit = {
      id: `i${i}`,
      key: `i${i}`,
      kind: "title",
      index: -1,
      text,
      protectedTokens: [],
    };
    const result = validateUnit(unit, response.items[i].text, { glossary: { Create: "Create" } });
    assertEquals(result.ok, true, `${JSON.stringify(text)}: ${JSON.stringify(result.problems)}`);
  }
});

Deno.test("echo keeps empty and whitespace-only strings byte identical", async () => {
  const provider = new EchoProvider();
  const response = await provider.translateBatch({
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    context: {},
    glossary: {},
    items: [
      { id: "a", kind: "title", text: "", protectedTokens: [] },
      { id: "b", kind: "title", text: "  ", protectedTokens: [] },
    ],
  }, options);
  assertEquals(response.items[0].text, "");
  assertEquals(response.items[1].text, "  ");
});
