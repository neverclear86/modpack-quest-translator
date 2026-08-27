import { assertEquals, assertStringIncludes } from "@std/assert";
import { readZip } from "../src/archive/zip/reader.ts";
import { artifactEntryPaths, buildArtifact, resolveOutputPlan } from "../src/output/package.ts";
import { buildPackMcmeta, DEFAULT_PACK_FORMAT, packFormatFor } from "../src/output/resourcepack.ts";
import { buildReadme } from "../src/output/readme.ts";
import type { ArtifactMeta } from "../src/output/types.ts";
import { Redactor } from "../src/util/redact.ts";

const PAYLOAD = `${
  JSON.stringify({ "quest.intro": "便利なホットキー", "quest.guide": "ガイド" }, null, 2)
}\n`;

const META: ArtifactMeta = {
  artifact: "resource-pack",
  toolVersion: "1.1.2",
  generatedAt: "2026-08-27T00:00:00.000Z",
  sourceUrl: "file:./example.zip",
  packName: "Example Pack",
  packVersion: "5.10.17",
  minecraftVersion: "1.20.1",
  loader: "forge-47.4.0",
  sourceArchiveSha256: "a".repeat(64),
  sourceLocale: "en_us",
  targetLocale: "ja_jp",
  targetLanguage: "Japanese",
  overrideEnglish: false,
  provider: "echo",
  model: "echo",
  fallbackModel: "echo",
  archiveFlavour: "curseforge",
  sourcePath: "assets/examplepack/lang/en_us.json",
  sourceLangJar: { file: "ExampleTweaks_1.0.jar", sha256: "b".repeat(64), entry: "assets/x" },
  resourcePack: {
    namespace: "examplepack",
    packFormat: 15,
    packFormatExact: true,
    langPath: "assets/examplepack/lang/ja_jp.json",
  },
  limitations: {
    scannedQuestFiles: 3,
    referencedKeys: 13,
    missingKeys: ["quest.guide.survival.tesla.description_1"],
    literalLabels: [{ field: "title", text: "WIP", file: "chapters/survival.snbt", count: 1 }],
    unreadableQuestFiles: [],
  },
};

const REPORT = {
  translated: 2,
  cached: 0,
  skipped: 0,
  fallback: 0,
  failed: [],
  batches: 1,
  retries: 0,
  usage: {},
  costUsd: 0,
  modelsUsed: { "batch-0000": "echo" },
};

Deno.test("pack_format follows the pack's Minecraft version", () => {
  assertEquals(packFormatFor("1.20.1"), { packFormat: 15, exact: true });
  assertEquals(packFormatFor("1.20"), { packFormat: 15, exact: true });
  assertEquals(packFormatFor("1.19.4"), { packFormat: 13, exact: true });
  assertEquals(packFormatFor("1.21.1"), { packFormat: 34, exact: true });
});

Deno.test("an unknown Minecraft version falls back to the documented default", () => {
  assertEquals(DEFAULT_PACK_FORMAT, 15);
  assertEquals(packFormatFor(undefined), { packFormat: 15, exact: false });
  assertEquals(packFormatFor("1.99.9"), { packFormat: 15, exact: false });
});

Deno.test("pack.mcmeta is valid JSON with the format and a readable description", () => {
  const text = buildPackMcmeta(META);
  const parsed = JSON.parse(text) as { pack: { pack_format: number; description: string } };
  assertEquals(parsed.pack.pack_format, 15);
  assertStringIncludes(parsed.pack.description, "Example Pack");
  assertStringIncludes(parsed.pack.description, "ja_jp");
  assertEquals(text.endsWith("\n"), true);
});

Deno.test("the resource-pack entry is assets/<namespace>/lang/<target>.json", () => {
  assertEquals(artifactEntryPaths(META, "instance"), ["assets/examplepack/lang/ja_jp.json"]);
});

Deno.test("english-override mode targets assets/<namespace>/lang/en_us.json", () => {
  const meta: ArtifactMeta = {
    ...META,
    overrideEnglish: true,
    resourcePack: { ...META.resourcePack!, langPath: "assets/examplepack/lang/en_us.json" },
  };
  assertEquals(artifactEntryPaths(meta, "instance"), ["assets/examplepack/lang/en_us.json"]);
});

Deno.test("the archive holds exactly pack.mcmeta, the lang file and the safe sidecars", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: PAYLOAD,
      meta: META,
      report: REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  assertEquals(zip.files().map((f) => f.path).sort(), [
    "README.md",
    "assets/examplepack/lang/ja_jp.json",
    "pack.mcmeta",
    "translation-manifest.json",
    "translation-report.json",
  ]);
  assertEquals(await zip.readText("assets/examplepack/lang/ja_jp.json"), PAYLOAD);
  assertEquals(zip.has("config/ftbquests/quests/lang/ja_jp.snbt"), false);
});

Deno.test("the resource pack carries no source english, jar or modpack content", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: PAYLOAD,
      meta: META,
      report: REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  for (const entry of zip.files()) {
    assertEquals(entry.path.endsWith(".jar"), false, entry.path);
    assertEquals(entry.path.endsWith(".class"), false, entry.path);
    assertEquals(entry.path.endsWith("en_us.json"), false, entry.path);
  }
  assertEquals(zip.has("assets/examplepack/lang/en_us.json"), false);
});

Deno.test("the manifest records the namespace, pack format and jar provenance", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: PAYLOAD,
      meta: META,
      report: REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  const manifest = JSON.parse(await zip.readText("translation-manifest.json"));
  assertEquals(manifest.artifact, "resource-pack");
  assertEquals(manifest.resourcePack.namespace, "examplepack");
  assertEquals(manifest.resourcePack.packFormat, 15);
  assertEquals(manifest.sourceLangJar.file, "ExampleTweaks_1.0.jar");
  assertEquals(manifest.limitations.missingKeys.length, 1);
});

Deno.test("the report carries the limitations rather than guessing at them", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: PAYLOAD,
      meta: META,
      report: REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  const report = JSON.parse(await zip.readText("translation-report.json"));
  assertEquals(report.limitations.missingKeys, ["quest.guide.survival.tesla.description_1"]);
  assertEquals(report.limitations.literalLabels[0].text, "WIP");
  assertEquals(report.limitations.referencedKeys, 13);
});

Deno.test("the README explains resource packs, not instance overlays", () => {
  const readme = buildReadme(META, "instance");
  assertStringIncludes(readme, "resourcepacks");
  assertStringIncludes(readme, "Resource Packs");
  assertStringIncludes(readme, "リソースパック");
  // Both languages state the two limitations, without inventing translations.
  assertStringIncludes(readme, "quest.guide.survival.tesla.description_1");
  assertStringIncludes(readme, "WIP");
  assertEquals(readme.includes("config/ftbquests/quests/lang"), false);
});

Deno.test("the README warns when the pack format was not derived from a known version", () => {
  const guessed: ArtifactMeta = {
    ...META,
    minecraftVersion: undefined,
    resourcePack: { ...META.resourcePack!, packFormatExact: false },
  };
  assertStringIncludes(buildReadme(guessed, "instance"), "could not be derived");
});

Deno.test("english-override mode is documented as a client-side fallback override", () => {
  const meta: ArtifactMeta = {
    ...META,
    overrideEnglish: true,
    resourcePack: { ...META.resourcePack!, langPath: "assets/examplepack/lang/en_us.json" },
  };
  const readme = buildReadme(meta, "instance");
  assertStringIncludes(readme, "en_us.json");
  // The honest consequence: en_us is Minecraft's fallback, so every language
  // that lacks these keys shows the translation too.
  assertStringIncludes(readme, "fallback");
  // And the honest reassurance: a resource pack is local to the client.
  assertStringIncludes(readme, "only the client that enables it");
});

Deno.test("a directory output names the archive as a resource pack", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqt-rp-" });
  try {
    const plan = await resolveOutputPlan(dir, META);
    assertEquals(plan.archivePath, `${dir}/example-pack-5.10.17-ja_jp-resourcepack.zip`);
    assertEquals(plan.rawPayloadPath, `${dir}/example-pack-5.10.17-ja_jp-resourcepack.ja_jp.json`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
