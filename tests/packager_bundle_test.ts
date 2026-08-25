import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { readZip } from "../src/archive/zip/reader.ts";
import { writeZip, type ZipWriteEntry } from "../src/archive/zip/writer.ts";
import { buildOverlay } from "../src/output/package.ts";
import type { OverlayMeta } from "../src/output/types.ts";
import { createDefaultRedactor } from "../src/util/redact.ts";
import { sha256Hex } from "../src/util/hash.ts";
import { buildInstallerBundle, type PackageBundleArgs } from "../src/packager/bundle.ts";
import { parseBundleManifest } from "../src/installer/bundle.ts";
import { digestByKey } from "../src/quests/digest.ts";
import { ftbQuestsLangAdapter } from "../src/quests/ftbquests_lang.ts";
import { finishedRun } from "./helpers/translation_report.ts";

const JAPANESE = '{\n  quest.title: "空の冒険"\n  quest.desc: "飛行船を作る"\n}\n';
const ENGLISH_PROSE = "Build an airship and sail the clouds";
/** What the run read. Its per-key digests are what prove the payload is not it. */
const ENGLISH = `{\n  quest.title: "Skyward Adventure"\n  quest.desc: "${ENGLISH_PROSE}"\n}\n`;
const LANG = "config/ftbquests/quests/lang/en_us.snbt";

function meta(): OverlayMeta {
  return {
    toolVersion: "1.1.0",
    generatedAt: "2026-08-25T00:00:00.000Z",
    sourceUrl: "https://example.invalid/aca.zip",
    packName: "All of Create: Aeronautics",
    packVersion: "2.4",
    minecraftVersion: "1.21.1",
    loader: "neoforge",
    sourceArchiveSha256: "d".repeat(64),
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    targetLanguage: "Japanese",
    overrideEnglish: true,
    provider: "echo",
    model: "haiku",
    fallbackModel: "sonnet",
    archiveFlavour: "curseforge",
    sourcePath: "overrides/config/ftbquests/quests/lang/en_us.snbt",
    keyCounts: { keys: 2, strings: 2, translated: 2, cached: 0, skipped: 0, fallback: 0 },
    sourceKeyDigests: digestByKey(ftbQuestsLangAdapter.extract(ENGLISH).units),
  };
}

async function realOverlay(layout: "instance" | "overrides" | "both"): Promise<Uint8Array> {
  return await buildOverlay({
    translatedSnbt: JAPANESE,
    meta: meta(),
    report: finishedRun({ translated: 2 }),
    layout,
    redactor: createDefaultRedactor(),
  });
}

function args(overlay: Uint8Array, overrides: Partial<PackageBundleArgs> = {}): PackageBundleArgs {
  return {
    overlay,
    bundleId: "aca-2.4-ja_jp-en_us-override",
    toolVersion: "1.1.0",
    generatedAt: "2026-08-25T00:00:00.000Z",
    binaries: [
      {
        path: "bin/mqt-installer-linux-x86_64",
        target: "x86_64-unknown-linux-gnu",
        bytes: new TextEncoder().encode("ELF-ish"),
      },
      {
        path: "bin/mqt-installer-windows-x86_64.exe",
        target: "x86_64-pc-windows-msvc",
        bytes: new TextEncoder().encode("MZ-ish"),
      },
    ],
    ...overrides,
  };
}

async function entriesOf(bytes: Uint8Array): Promise<string[]> {
  return (await readZip(bytes)).entries.map((entry) => entry.path).sort();
}

Deno.test("a bundle holds exactly the expected entries under one top-level directory", async () => {
  const built = await buildInstallerBundle(args(await realOverlay("instance")));
  assertEquals(await entriesOf(built.bytes), [
    "aca-2.4-ja_jp-en_us-override/INSTALL-LINUX.sh",
    "aca-2.4-ja_jp-en_us-override/INSTALL-WINDOWS.cmd",
    "aca-2.4-ja_jp-en_us-override/README.md",
    "aca-2.4-ja_jp-en_us-override/UNINSTALL-LINUX.sh",
    "aca-2.4-ja_jp-en_us-override/UNINSTALL-WINDOWS.cmd",
    "aca-2.4-ja_jp-en_us-override/bin/mqt-installer-linux-x86_64",
    "aca-2.4-ja_jp-en_us-override/bin/mqt-installer-windows-x86_64.exe",
    "aca-2.4-ja_jp-en_us-override/bundle-manifest.json",
    `aca-2.4-ja_jp-en_us-override/payload/${LANG}`,
    "aca-2.4-ja_jp-en_us-override/translation-manifest.json",
    "aca-2.4-ja_jp-en_us-override/translation-report.json",
  ]);
});

Deno.test("packaging the same overlay twice is byte-identical", async () => {
  const overlay = await realOverlay("instance");
  const first = await buildInstallerBundle(args(overlay));
  const second = await buildInstallerBundle(args(overlay));
  assertEquals(await sha256Hex(first.bytes), await sha256Hex(second.bytes));
});

Deno.test("the executables and shell launchers carry the execute bit", async () => {
  const built = await buildInstallerBundle(args(await realOverlay("instance")));
  const archive = await readZip(built.bytes);
  for (const entry of archive.entries) {
    const expected = /\.sh$|\/bin\//.test(entry.path) ? 0o755 : 0o644;
    assertEquals(entry.unixMode, expected, `${entry.path} should be ${expected.toString(8)}`);
  }
});

Deno.test("the bundle manifest describes the payload and the binaries", async () => {
  const built = await buildInstallerBundle(args(await realOverlay("instance")));
  const archive = await readZip(built.bytes);
  const manifest = parseBundleManifest(
    await archive.readText("aca-2.4-ja_jp-en_us-override/bundle-manifest.json"),
  );
  assertEquals(manifest.formatVersion, 1);
  assertEquals(manifest.containsSourceProse, false);
  assertEquals(manifest.targetLocale, "ja_jp");
  assertEquals(manifest.overrideEnglish, true);
  assertEquals(manifest.pack.name, "All of Create: Aeronautics");
  assertEquals(manifest.payload.length, 1);
  assertEquals(manifest.payload[0].path, LANG);
  assertEquals(manifest.payload[0].sha256, await sha256Hex(JAPANESE));
  assertEquals(manifest.binaries.length, 2);
  assertEquals(manifest.binaries[0].sha256, await sha256Hex("ELF-ish"));
});

Deno.test("the payload is byte-identical to what the translation run produced", async () => {
  const built = await buildInstallerBundle(args(await realOverlay("instance")));
  const archive = await readZip(built.bytes);
  assertEquals(
    await archive.readText(`aca-2.4-ja_jp-en_us-override/payload/${LANG}`),
    JAPANESE,
  );
});

Deno.test("an overrides-layout overlay is unwrapped to the instance-relative path", async () => {
  const built = await buildInstallerBundle(args(await realOverlay("overrides")));
  assert((await entriesOf(built.bytes)).includes(`aca-2.4-ja_jp-en_us-override/payload/${LANG}`));
});

Deno.test("a both-layout overlay collapses its two identical copies into one payload", async () => {
  const built = await buildInstallerBundle(args(await realOverlay("both")));
  assertEquals(built.manifest.payload.length, 1);
});

Deno.test("two copies of the same target that disagree are refused", async () => {
  const overlay = await writeZip([
    { path: LANG, text: JAPANESE },
    { path: `overrides/${LANG}`, text: `${JAPANESE}// different\n` },
    { path: "translation-manifest.json", text: "{}" },
    { path: "translation-report.json", text: "{}" },
  ]);
  const error = await assertRejects(() => buildInstallerBundle(args(overlay)), AppError);
  assertEquals(error.code, "E_BUNDLE");
  assertStringIncludes(error.message, "disagree");
});

Deno.test("anything in the overlay that is not quest localisation is refused", async () => {
  for (
    const stray of [
      "mods/SomeMod-1.0.jar",
      "config/ftbquests/quests/chapters/one.snbt",
      "overrides/config/ftbquests/quests/lang/nested/en_us.snbt",
      "en_us.snbt",
    ]
  ) {
    const overlay = await writeZip([
      { path: LANG, text: JAPANESE },
      { path: stray, text: "whatever" },
      { path: "translation-manifest.json", text: "{}" },
    ] as ZipWriteEntry[]);
    const error = await assertRejects(
      () => buildInstallerBundle(args(overlay)),
      AppError,
      undefined,
      `expected ${stray} to be refused`,
    );
    assertEquals(error.code, "E_BUNDLE");
    assertStringIncludes(error.message, stray);
  }
});

Deno.test("an overlay with no quest localisation at all is refused", async () => {
  const overlay = await writeZip([{ path: "translation-manifest.json", text: "{}" }]);
  const error = await assertRejects(() => buildInstallerBundle(args(overlay)), AppError);
  assertEquals(error.code, "E_BUNDLE");
});

Deno.test("no entry anywhere in the bundle contains the pack's own English prose", async () => {
  const overlay = await realOverlay("instance");
  // A control: the English prose is genuinely absent from the input too.
  assert(!new TextDecoder().decode(overlay).includes(ENGLISH_PROSE));

  const built = await buildInstallerBundle(args(overlay));
  const archive = await readZip(built.bytes);
  for (const entry of archive.entries) {
    const text = new TextDecoder().decode(await archive.read(entry.path));
    assert(!text.includes(ENGLISH_PROSE), `${entry.path} contains the source prose`);
  }
});

Deno.test("a bundle built without binaries says so in the manifest and the README", async () => {
  const built = await buildInstallerBundle(args(await realOverlay("instance"), { binaries: [] }));
  const archive = await readZip(built.bytes);
  const readme = await archive.readText("aca-2.4-ja_jp-en_us-override/README.md");
  assertEquals(built.manifest.binaries, []);
  assertStringIncludes(readme, "実行ファイルは含まれていません");
  assertStringIncludes(readme, "does not include the installer executables");
});

Deno.test("the README's contents table lists only files the bundle really holds", async () => {
  // A player who reads "bin/mqt-installer-windows-x86_64.exe" in the table and
  // cannot find it has been told the bundle is broken when it is not.
  for (const binaries of [args(new Uint8Array()).binaries, []]) {
    const built = await buildInstallerBundle(args(await realOverlay("instance"), { binaries }));
    const entries = new Set(await entriesOf(built.bytes));
    const archive = await readZip(built.bytes);
    const readme = await archive.readText("aca-2.4-ja_jp-en_us-override/README.md");
    // The table rows only: the prose below them names fields of the manifest as
    // well as files, and a field is not something a player goes looking for.
    const table = readme.slice(readme.indexOf("## What is in this bundle"))
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .join("\n");

    const listed = [...table.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    assert(listed.length > 0, "the table should list something");
    for (const path of listed) {
      const full = `aca-2.4-ja_jp-en_us-override/${path}`;
      assert(
        entries.has(full) || [...entries].some((entry) => entry.startsWith(full)),
        `the README lists ${path}, which is not in the bundle`,
      );
    }
  }
});

Deno.test("the README is Japanese first and covers SmartScreen, backups and undo", async () => {
  const built = await buildInstallerBundle(args(await realOverlay("instance")));
  const archive = await readZip(built.bytes);
  const readme = await archive.readText("aca-2.4-ja_jp-en_us-override/README.md");
  const japanese = readme.indexOf("日本語");
  const english = readme.indexOf("English");
  assert(japanese >= 0 && english > japanese, "Japanese should come first");
  assertStringIncludes(readme, "SmartScreen");
  assertStringIncludes(readme, ".mqt-installer");
  assertStringIncludes(readme, "UNINSTALL-WINDOWS.cmd");
  assertStringIncludes(readme, "INSTALL-LINUX.sh");
  // No administrator rights are needed, and the README has to say so.
  assertStringIncludes(readme, "管理者");
});

Deno.test("the translation manifest and report travel with the bundle verbatim", async () => {
  const overlay = await realOverlay("instance");
  const source = await readZip(overlay);
  const built = await buildInstallerBundle(args(overlay));
  const archive = await readZip(built.bytes);
  for (const name of ["translation-manifest.json", "translation-report.json"]) {
    assertEquals(
      await archive.readText(`aca-2.4-ja_jp-en_us-override/${name}`),
      await source.readText(name),
    );
  }
});

Deno.test("an overlay with no translation manifest has no timestamp and no provenance", async () => {
  // The clock is never a fallback, and neither is --generated-at: a bundle
  // whose overlay cannot be shown to be a translation is refused either way.
  const overlay = await writeZip([{ path: LANG, text: JAPANESE }]);
  const { generatedAt: _dropped, ...rest } = args(overlay);
  for (const candidate of [rest, args(overlay)]) {
    const error = await assertRejects(() => buildInstallerBundle(candidate), AppError);
    assertEquals(error.code, "E_BUNDLE");
    assertStringIncludes(error.message, "translation-manifest.json");
  }
});

Deno.test("--generated-at overrides the translation run's timestamp", async () => {
  const built = await buildInstallerBundle(
    args(await realOverlay("instance"), { generatedAt: "2027-01-02T03:04:05.000Z" }),
  );
  assertEquals(built.manifest.generatedAt, "2027-01-02T03:04:05.000Z");
});
