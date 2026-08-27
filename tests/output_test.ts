import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { readZip } from "../src/archive/zip/reader.ts";
import { buildArtifact, resolveOutputPlan } from "../src/output/package.ts";
import { Redactor } from "../src/util/redact.ts";

const TRANSLATED = '{\n\tquest.A.title: "歯車"\n}\n';

const BASE_META = {
  artifact: "snbt-overlay" as const,
  toolVersion: "1.0.0",
  generatedAt: "2026-08-25T00:00:00.000Z",
  sourceUrl: "https://modrinth.com/modpack/rubius-cobblemon",
  packName: "Rubius Cobblemon",
  packVersion: "0.9",
  minecraftVersion: "1.21.1",
  loader: "neoforge",
  sourceArchiveSha256: "a".repeat(64),
  sourceLocale: "en_us",
  targetLocale: "ja_jp",
  targetLanguage: "Japanese",
  overrideEnglish: false,
  provider: "echo",
  model: "echo",
  fallbackModel: "echo",
  archiveFlavour: "modrinth" as const,
  sourcePath: "overrides/config/ftbquests/quests/lang/en_us.snbt",
};

const BASE_REPORT = {
  translated: 1,
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

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "mqt-out-" });
}

Deno.test("target-locale mode writes lang/ja_jp.snbt at the instance root", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: BASE_META,
      report: BASE_REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  assertEquals(zip.has("config/ftbquests/quests/lang/ja_jp.snbt"), true);
  assertEquals(await zip.readText("config/ftbquests/quests/lang/ja_jp.snbt"), TRANSLATED);
});

Deno.test("english-override mode writes lang/en_us.snbt instead", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: { ...BASE_META, overrideEnglish: true },
      report: BASE_REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  assertEquals(zip.has("config/ftbquests/quests/lang/en_us.snbt"), true);
  assertEquals(zip.has("config/ftbquests/quests/lang/ja_jp.snbt"), false);
});

Deno.test("overrides layout wraps the path and both layout emits each once", async () => {
  const overrides = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: BASE_META,
      report: BASE_REPORT,
      layout: "overrides",
      redactor: new Redactor(),
    }),
  );
  assertEquals(overrides.has("overrides/config/ftbquests/quests/lang/ja_jp.snbt"), true);
  assertEquals(overrides.has("config/ftbquests/quests/lang/ja_jp.snbt"), false);

  const both = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: BASE_META,
      report: BASE_REPORT,
      layout: "both",
      redactor: new Redactor(),
    }),
  );
  assertEquals(both.has("config/ftbquests/quests/lang/ja_jp.snbt"), true);
  assertEquals(both.has("overrides/config/ftbquests/quests/lang/ja_jp.snbt"), true);
});

Deno.test("the archive carries a manifest, a report and a bilingual README", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: BASE_META,
      report: BASE_REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  const manifest = JSON.parse(await zip.readText("translation-manifest.json"));
  assertEquals(manifest.sourceUrl, BASE_META.sourceUrl);
  assertEquals(manifest.pack.name, "Rubius Cobblemon");
  assertEquals(manifest.pack.version, "0.9");
  assertEquals(manifest.sourceArchiveSha256, "a".repeat(64));
  assertEquals(manifest.targetLocale, "ja_jp");
  assertEquals(manifest.overrideEnglish, false);
  assertEquals(manifest.provider, "echo");
  assertEquals(manifest.toolVersion, "1.0.0");
  assertEquals(typeof manifest.keyCounts, "object");

  const report = JSON.parse(await zip.readText("translation-report.json"));
  assertEquals(report.translated, 1);

  const readme = await zip.readText("README.md");
  assertStringIncludes(readme, "## English");
  assertStringIncludes(readme, "## 日本語");
});

Deno.test("the README states exactly how to install for the chosen layout", async () => {
  const instance = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: BASE_META,
      report: BASE_REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  const text = await instance.readText("README.md");
  assertStringIncludes(text, "instance root");
  assertStringIncludes(text, "config/ftbquests/quests/lang/ja_jp.snbt");
  assertStringIncludes(text, "インスタンス");
});

Deno.test("the README documents the multiplayer consequences of en_us override", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: { ...BASE_META, overrideEnglish: true },
      report: BASE_REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  const text = await zip.readText("README.md");
  assertStringIncludes(text, "en_us");
  assertStringIncludes(text, "every player");
  assertStringIncludes(text, "en_gb");
  assertStringIncludes(text, "server");
});

Deno.test("the archive contains no mod jars or pack assets", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: BASE_META,
      report: BASE_REPORT,
      layout: "both",
      redactor: new Redactor(),
    }),
  );
  const paths = zip.files().map((f) => f.path);
  assertEquals(paths.some((p) => p.endsWith(".jar")), false);
  assertEquals(paths.some((p) => p.startsWith("mods/")), false);
  assertEquals(paths.length <= 6, true, `unexpected extra files: ${paths.join(", ")}`);
});

Deno.test("no credential ever reaches the archive", async () => {
  const redactor = new Redactor();
  redactor.register("$2a$10$curseforgesecretvalue");
  const bytes = await buildArtifact({
    payload: TRANSLATED,
    meta: {
      ...BASE_META,
      sourceUrl: "https://example.com/pack.zip?api_key=$2a$10$curseforgesecretvalue",
    },
    report: BASE_REPORT,
    layout: "instance",
    redactor,
  });
  const text = new TextDecoder().decode(bytes);
  assertEquals(text.includes("curseforgesecretvalue"), false);
  const zip = await readZip(bytes);
  const manifest = await zip.readText("translation-manifest.json");
  assertEquals(manifest.includes("curseforgesecretvalue"), false);
  assertStringIncludes(manifest, "redacted");
});

Deno.test("packaging is deterministic for identical input", async () => {
  const args = {
    payload: TRANSLATED,
    meta: BASE_META,
    report: BASE_REPORT,
    layout: "instance" as const,
    redactor: new Redactor(),
  };
  assertEquals(await buildArtifact(args), await buildArtifact(args));
});

Deno.test("an explicit .zip output path is used verbatim with sidecars beside it", async () => {
  const dir = await tempDir();
  try {
    const plan = await resolveOutputPlan(`${dir}/aca-ja.zip`, BASE_META);
    assertEquals(plan.archivePath, `${dir}/aca-ja.zip`);
    assertEquals(plan.manifestPath, `${dir}/aca-ja.manifest.json`);
    assertEquals(plan.reportPath, `${dir}/aca-ja.report.json`);
    assertEquals(plan.readmePath, `${dir}/aca-ja.README.md`);
    assertEquals(plan.rawPayloadPath, `${dir}/aca-ja.ja_jp.snbt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a directory output path names the archive after the exact pack version", async () => {
  const dir = await tempDir();
  try {
    const plan = await resolveOutputPlan(dir, BASE_META);
    assertEquals(plan.archivePath, `${dir}/rubius-cobblemon-0.9-ja_jp.zip`);
    const override = await resolveOutputPlan(dir, { ...BASE_META, overrideEnglish: true });
    assertEquals(override.archivePath, `${dir}/rubius-cobblemon-0.9-ja_jp-en_us-override.zip`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an existing output file is never silently overwritten", async () => {
  const dir = await tempDir();
  try {
    await Deno.writeTextFile(`${dir}/aca-ja.zip`, "existing");
    await assertRejects(() => resolveOutputPlan(`${dir}/aca-ja.zip`, BASE_META), AppError);
    const forced = await resolveOutputPlan(`${dir}/aca-ja.zip`, BASE_META, { force: true });
    assertEquals(forced.archivePath, `${dir}/aca-ja.zip`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an existing sidecar is refused just as loudly as the archive", async () => {
  // Regression: only the archive path was checked, so a run could get all the
  // way to packaging and then overwrite a previous run's manifest, report or
  // README.
  const dir = await tempDir();
  try {
    for (const sidecar of ["aca-ja.manifest.json", "aca-ja.report.json", "aca-ja.README.md"]) {
      await Deno.writeTextFile(`${dir}/${sidecar}`, "existing");
      const error = await assertRejects(
        () => resolveOutputPlan(`${dir}/aca-ja.zip`, BASE_META),
        AppError,
      ) as AppError;
      assertEquals(error.code, "E_WRITE");
      assertStringIncludes(error.message, sidecar);
      await Deno.remove(`${dir}/${sidecar}`);
    }

    // The raw payload is only written when it was asked for, so it only counts
    // when it was asked for.
    await Deno.writeTextFile(`${dir}/aca-ja.ja_jp.snbt`, "existing");
    assertEquals(
      (await resolveOutputPlan(`${dir}/aca-ja.zip`, BASE_META)).archivePath,
      `${dir}/aca-ja.zip`,
    );
    await assertRejects(
      () => resolveOutputPlan(`${dir}/aca-ja.zip`, BASE_META, { emitRaw: true }),
      AppError,
    );
    assertEquals(
      (await resolveOutputPlan(`${dir}/aca-ja.zip`, BASE_META, { emitRaw: true, force: true }))
        .rawPayloadPath,
      `${dir}/aca-ja.ja_jp.snbt`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every colliding output path is named at once, not one run at a time", async () => {
  const dir = await tempDir();
  try {
    for (const name of ["aca-ja.zip", "aca-ja.report.json", "aca-ja.README.md"]) {
      await Deno.writeTextFile(`${dir}/${name}`, "existing");
    }
    const error = await assertRejects(
      () => resolveOutputPlan(`${dir}/aca-ja.zip`, BASE_META),
      AppError,
    ) as AppError;
    for (const name of ["aca-ja.zip", "aca-ja.report.json", "aca-ja.README.md"]) {
      assertStringIncludes(error.message, name);
    }
    assertEquals(error.message.includes("aca-ja.manifest.json"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("output file names are filesystem safe", async () => {
  const dir = await tempDir();
  try {
    const plan = await resolveOutputPlan(dir, {
      ...BASE_META,
      packName: "All of Create: Aeronautics / Deluxe",
      packVersion: "1.0 (beta)",
    });
    const name = plan.archivePath.slice(dir.length + 1);
    assertEquals(/^[A-Za-z0-9._-]+\.zip$/.test(name), true, name);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the README qualifies its server/client advice against the detected FTB Quests version", async () => {
  const known = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: { ...BASE_META, overrideEnglish: true, questModVersion: "2101.1.10" },
      report: BASE_REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  const text = await known.readText("README.md");
  assertStringIncludes(text, "2101.1.10");
  assertStringIncludes(text, "FTB Quests");

  // When it cannot be detected the README must say so rather than imply it was
  // checked: the advice is only as good as the evidence behind it.
  const unknown = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: { ...BASE_META, overrideEnglish: true },
      report: BASE_REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  const unknownText = await unknown.readText("README.md");
  assertStringIncludes(unknownText, "could not be detected");
  assertStringIncludes(unknownText, "検出できません");
});

Deno.test("the detected FTB Quests version is recorded in the manifest", async () => {
  const zip = await readZip(
    await buildArtifact({
      payload: TRANSLATED,
      meta: {
        ...BASE_META,
        questModVersion: "2101.1.10",
        questModFile: "ftb-quests-neoforge-2101.1.10.jar",
      },
      report: BASE_REPORT,
      layout: "instance",
      redactor: new Redactor(),
    }),
  );
  const manifest = JSON.parse(await zip.readText("translation-manifest.json"));
  assertEquals(manifest.questMod.version, "2101.1.10");
  assertEquals(manifest.questMod.file, "ftb-quests-neoforge-2101.1.10.jar");
});
