import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { discoverQuestSource } from "../src/archive/discover.ts";
import { readZip } from "../src/archive/zip/reader.ts";
import { writeZip } from "../src/archive/zip/writer.ts";

const LANG = '{\n\tquest.AAAA.title: "Hello"\n}\n';

async function archiveOf(files: Record<string, string>) {
  return await readZip(
    await writeZip(Object.entries(files).map(([path, text]) => ({ path, text }))),
  );
}

Deno.test("finds a lang file at the instance root of a plain overlay zip", async () => {
  const zip = await archiveOf({ "config/ftbquests/quests/lang/en_us.snbt": LANG });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.root, "");
  assertEquals(found.path, "config/ftbquests/quests/lang/en_us.snbt");
  assertEquals(found.flavour, "plain");
  assertEquals(found.text, LANG);
});

Deno.test("finds a lang file under a CurseForge overrides directory", async () => {
  const zip = await archiveOf({
    "manifest.json": JSON.stringify({ name: "ACA", version: "1.0", overrides: "overrides" }),
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.root, "overrides/");
  assertEquals(found.flavour, "curseforge");
});

Deno.test("finds a lang file inside a Modrinth mrpack", async () => {
  const zip = await archiveOf({
    "modrinth.index.json": JSON.stringify({ name: "Pack", versionId: "1.0", files: [] }),
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.flavour, "modrinth");
  assertEquals(found.root, "overrides/");
});

Deno.test("overrides wins over server-overrides when both are present", async () => {
  const zip = await archiveOf({
    "modrinth.index.json": "{}",
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
    "server-overrides/config/ftbquests/quests/lang/en_us.snbt":
      '{\n\tquest.BBBB.title: "Server"\n}\n',
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.root, "overrides/");
  assertEquals(found.alternates.length, 1);
});

Deno.test("server-overrides is used when it is the only source", async () => {
  const zip = await archiveOf({
    "modrinth.index.json": "{}",
    "server-overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.root, "server-overrides/");
});

Deno.test("lang file name matching is case insensitive", async () => {
  const zip = await archiveOf({ "config/ftbquests/quests/lang/EN_US.SNBT": LANG });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.path, "config/ftbquests/quests/lang/EN_US.SNBT");
});

Deno.test("a non-default source locale can be requested", async () => {
  const zip = await archiveOf({ "config/ftbquests/quests/lang/de_de.snbt": LANG });
  const found = await discoverQuestSource(zip, { sourceLocale: "de_de" });
  assertEquals(found.path, "config/ftbquests/quests/lang/de_de.snbt");
});

Deno.test("chapter files are collected for translation context", async () => {
  const chapter = '{\n\tid: "CH01"\n\tfilename: "core"\n\tquests: [{\n\t\tid: "AAAA"\n\t}]\n}\n';
  const zip = await archiveOf({
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
    "overrides/config/ftbquests/quests/chapters/core.snbt": chapter,
    "overrides/config/ftbquests/quests/reward_tables/x.snbt": "{ }",
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.chapterFiles.map((c) => c.path), [
    "overrides/config/ftbquests/quests/chapters/core.snbt",
  ]);
});

Deno.test("a pack with no FTB Quests data at all fails with E_NO_QUEST_LOCALIZATION", async () => {
  const zip = await archiveOf({ "manifest.json": "{}", "overrides/config/other.json": "{}" });
  const err = await assertRejects(
    () => discoverQuestSource(zip, { sourceLocale: "en_us" }),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_NO_QUEST_LOCALIZATION");
});

Deno.test("a pack with old inline quests reports what it did find", async () => {
  // Never silently produce an empty translation: say what is actually there.
  const zip = await archiveOf({
    "manifest.json": "{}",
    "overrides/config/ftbquests/quests/chapters/core.snbt": '{\n\tid: "CH01"\n}\n',
    "overrides/config/ftbquests/quests/data.snbt": "{ }",
  });
  const err = await assertRejects(
    () => discoverQuestSource(zip, { sourceLocale: "en_us" }),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_NO_QUEST_LOCALIZATION");
  assertStringIncludes(String(err.hint), "chapters/core.snbt");
});

Deno.test("a lang file that is not a modern flat map is reported as unsupported", async () => {
  const zip = await archiveOf({
    "config/ftbquests/quests/lang/en_us.snbt": '{\n\tquests: [{\n\t\tid: "A"\n\t}]\n}\n',
  });
  const err = await assertRejects(
    () => discoverQuestSource(zip, { sourceLocale: "en_us" }),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_NO_QUEST_LOCALIZATION");
});

Deno.test("pack metadata is read from a CurseForge manifest", async () => {
  const zip = await archiveOf({
    "manifest.json": JSON.stringify({
      name: "All of Create Aeronautics",
      version: "1.4.2",
      minecraft: { version: "1.20.1", modLoaders: [{ id: "forge-47.2.0", primary: true }] },
    }),
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.packInfo.name, "All of Create Aeronautics");
  assertEquals(found.packInfo.version, "1.4.2");
  assertEquals(found.packInfo.minecraftVersion, "1.20.1");
  assertEquals(found.packInfo.loader, "forge-47.2.0");
});

Deno.test("pack metadata is read from a Modrinth index", async () => {
  const zip = await archiveOf({
    "modrinth.index.json": JSON.stringify({
      name: "Rubius Cobblemon",
      versionId: "0.9",
      dependencies: { minecraft: "1.21.1", neoforge: "21.1.228" },
    }),
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.packInfo.name, "Rubius Cobblemon");
  assertEquals(found.packInfo.version, "0.9");
  assertEquals(found.packInfo.minecraftVersion, "1.21.1");
  assertEquals(found.packInfo.loader, "neoforge 21.1.228");
});

Deno.test("a malformed manifest does not fail discovery", async () => {
  const zip = await archiveOf({
    "manifest.json": "{ not json",
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.packInfo.name, undefined);
  assertEquals(found.flavour, "curseforge");
});

Deno.test("the FTB Quests mod version is detected from a Modrinth index", async () => {
  const zip = await archiveOf({
    "modrinth.index.json": JSON.stringify({
      name: "Pack",
      versionId: "1.0",
      files: [
        { path: "mods/sodium-0.6.0.jar", downloads: [] },
        { path: "mods/ftb-quests-neoforge-2101.1.10.jar", downloads: [] },
      ],
    }),
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.questModVersion, "2101.1.10");
  assertEquals(found.questModFile, "ftb-quests-neoforge-2101.1.10.jar");
});

Deno.test("the FTB Quests mod version is detected from a jar shipped in overrides", async () => {
  const zip = await archiveOf({
    "manifest.json": "{}",
    "overrides/mods/ftbquests-forge-1902.4.15-build.279.jar": "jar",
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.questModVersion, "1902.4.15-build.279");
});

Deno.test("an undetectable FTB Quests version is reported as unknown, not guessed", async () => {
  const zip = await archiveOf({
    "manifest.json": JSON.stringify({ name: "P", files: [{ projectID: 1, fileID: 2 }] }),
    "overrides/config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.questModVersion, undefined);
});

Deno.test("a non-quest mod whose name merely contains quests is not matched", async () => {
  const zip = await archiveOf({
    "modrinth.index.json": JSON.stringify({
      files: [{ path: "mods/betterquesting-3.5.jar", downloads: [] }],
    }),
    "config/ftbquests/quests/lang/en_us.snbt": LANG,
  });
  const found = await discoverQuestSource(zip, { sourceLocale: "en_us" });
  assertEquals(found.questModVersion, undefined);
});
