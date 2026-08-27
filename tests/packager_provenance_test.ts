/**
 * `containsSourceProse: false` has to be earned.
 *
 * The packager used to accept any ZIP with a file under the quest lang
 * directory, copy its bytes into `payload/`, and write the claim into the
 * manifest unconditionally. Handing it the pack's own `en_us.snbt` and a
 * `--generated-at` was enough to redistribute the original English prose under
 * a manifest swearing it had not.
 *
 * What can be checked without signing is checked here, and what cannot is said
 * plainly in the bundle README rather than implied by a boolean.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { readZip } from "../src/archive/zip/reader.ts";
import { writeZip } from "../src/archive/zip/writer.ts";
import { buildArtifact } from "../src/output/package.ts";
import type { OverlayMeta } from "../src/output/types.ts";
import type { TranslateReport } from "../src/translate/orchestrator.ts";
import { buildInstallerBundle, type PackageBundleArgs } from "../src/packager/bundle.ts";
import { digestByKey } from "../src/quests/digest.ts";
import { ftbQuestsLangAdapter } from "../src/quests/ftbquests_lang.ts";
import { createDefaultRedactor } from "../src/util/redact.ts";
import { finishedRun } from "./helpers/translation_report.ts";
import { sourceArchiveOf } from "./helpers/source_archive.ts";

const LANG = "config/ftbquests/quests/lang";

const ENGLISH = `{
  aca.quest.1.title: "Build an Airship"
  aca.quest.1.desc: "Assemble a hull and sail the clouds"
  aca.quest.2.title: "Reach the Stratosphere"
}
`;

const JAPANESE = `{
  aca.quest.1.title: "飛行船を作る"
  aca.quest.1.desc: "船体を組み立てて雲を渡る"
  aca.quest.2.title: "成層圏に到達する"
}
`;

/** The pack archive the run read, so the manifest can be checked against it. */
const SOURCE = await sourceArchiveOf(ENGLISH);

/**
 * One key translated, and two of the pack's own English sentences left exactly
 * as they were. A per-key digest comparison sees three keys of which one
 * differs and calls the whole file a translation.
 */
const PART_ENGLISH = `{
  aca.quest.1.title: "飛行船を作る"
  aca.quest.1.desc: "Assemble a hull and sail the clouds"
  aca.quest.2.title: "Reach the Stratosphere"
}
`;

/**
 * A source file whose strings are mostly ones a translation run is *supposed*
 * to hand back unchanged: empty, whitespace, a bare image tag, a bare
 * formatting code, and a word too short to be prose. Only the two sentences
 * have anything in them a translator could change.
 */
const TECHNICAL = `{
  aca.quest.3.title: "Build a Steam Engine"
  aca.quest.3.quest_desc: [
    ""
    "   "
    "{image:allofcreate:textures/qb_image.png width:397 height:140 align:center}"
    "&e"
    "Andesite"
    "Pressurize the boiler and watch the flywheel spin"
  ]
}
`;

const TECHNICAL_JAPANESE = TECHNICAL
  .replace('"Build a Steam Engine"', '"蒸気機関を作る"')
  .replace(
    '"Pressurize the boiler and watch the flywheel spin"',
    '"ボイラーを加圧してフライホイールが回るのを見よう"',
  );

const TECHNICAL_SOURCE = await sourceArchiveOf(TECHNICAL);

function sourceDigests(snbt: string): Record<string, string> {
  return digestByKey(ftbQuestsLangAdapter.extract(snbt).units);
}

function meta(overrides: Partial<OverlayMeta> = {}): OverlayMeta {
  return {
    artifact: "snbt-overlay",
    toolVersion: "1.1.1",
    generatedAt: "2026-08-25T00:00:00.000Z",
    sourceUrl: "https://example.invalid/aca.zip",
    packName: "All of Create: Aeronautics",
    packVersion: "2.4",
    sourceArchiveSha256: SOURCE.sha256,
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    targetLanguage: "Japanese",
    overrideEnglish: true,
    provider: "echo",
    model: "haiku",
    fallbackModel: "sonnet",
    archiveFlavour: "curseforge",
    sourcePath: SOURCE.path,
    keyCounts: { keys: 3, strings: 3, translated: 3, cached: 0, skipped: 0, fallback: 0 },
    sourceKeyDigests: sourceDigests(ENGLISH),
    ...overrides,
  };
}

const REPORT: TranslateReport = finishedRun({ translated: 3 });

async function overlayOf(
  snbt: string,
  overrides: Partial<OverlayMeta> = {},
  report: TranslateReport = REPORT,
): Promise<Uint8Array> {
  return await buildArtifact({
    payload: snbt,
    meta: meta(overrides),
    report,
    layout: "instance",
    redactor: createDefaultRedactor(),
  });
}

function args(overlay: Uint8Array, overrides: Partial<PackageBundleArgs> = {}): PackageBundleArgs {
  return {
    overlay,
    sourceArchive: SOURCE.bytes,
    bundleId: "aca-2.4-ja_jp-en_us-override",
    toolVersion: "1.1.1",
    binaries: [],
    ...overrides,
  };
}

async function refused(
  overlay: Uint8Array,
  needle: string,
  overrides: Partial<PackageBundleArgs> = {},
): Promise<void> {
  const error = await assertRejects(
    () => buildInstallerBundle(args(overlay, overrides)),
    AppError,
    undefined,
    `expected the overlay to be refused for: ${needle}`,
  );
  assertEquals(error.code, "E_BUNDLE");
  assertStringIncludes(error.message, needle);
}

Deno.test("a genuine translated overlay packages", async () => {
  const built = await buildInstallerBundle(args(await overlayOf(JAPANESE)));
  assertEquals(built.manifest.containsSourceProse, false);
  assertEquals(built.manifest.targetLocale, "ja_jp");
  assertEquals(built.manifest.payload[0].path, `${LANG}/en_us.snbt`);
});

Deno.test("an overlay whose payload is still the pack's own English is refused", async () => {
  // Every key digests to exactly what the source archive says, so whatever this
  // is, it is not a translation of it.
  await refused(await overlayOf(ENGLISH), "byte-for-byte");
});

Deno.test("a hand-made overlay with no translation manifest is refused", async () => {
  const overlay = await writeZip([{ path: `${LANG}/en_us.snbt`, text: ENGLISH }]);
  await refused(overlay, "translation-manifest.json");
  // ...and passing --generated-at does not buy a way past it.
  await refused(overlay, "translation-manifest.json", {
    generatedAt: "2026-08-25T00:00:00.000Z",
  });
});

Deno.test("a manifest with no source key digests cannot prove anything, so it is refused", async () => {
  await refused(await overlayOf(JAPANESE, { sourceKeyDigests: {} }), "sourceKeyDigests");
});

Deno.test("a payload whose keys are not the ones the run recorded is refused", async () => {
  const different = `{
  other.quest.1.title: "べつのもの"
}
`;
  await refused(await overlayOf(different), "keys");
});

Deno.test("a manifest claiming nothing was translated is refused", async () => {
  await refused(
    await overlayOf(JAPANESE, {
      keyCounts: { keys: 3, strings: 3, translated: 0, cached: 0, skipped: 3, fallback: 0 },
    }),
    "translated",
  );
});

Deno.test("a report with failures is refused: a partial translation is not a bundle", async () => {
  const overlay = await overlayOf(JAPANESE, {}, {
    ...REPORT,
    failed: [{ id: "aca.quest.2.title", reason: "placeholder lost" }],
  });
  await refused(overlay, "failed");
});

Deno.test("a manifest fabricated field by field is refused", async () => {
  const genuine = await overlayOf(JAPANESE);
  const facts = {
    tool: "modpack-quest-translator",
    toolVersion: "1.1.1",
    generatedAt: "2026-08-25T00:00:00.000Z",
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    overrideEnglish: true,
    keyCounts: { keys: 3, strings: 3, translated: 3, cached: 0, skipped: 0, fallback: 0 },
    sourceKeyDigests: sourceDigests(ENGLISH),
  };
  const cases: [Record<string, unknown>, string][] = [
    [{ tool: "someone-elses-tool" }, "tool"],
    [{ generatedAt: "yesterday" }, "generatedAt"],
    [{ generatedAt: "2026-13-45T99:00:00.000Z" }, "generatedAt"],
    [{ sourceLocale: "../../etc" }, "sourceLocale"],
    [{ targetLocale: "en_us" }, "targetLocale"],
    [{ toolVersion: "" }, "toolVersion"],
  ];
  for (const [override, needle] of cases) {
    await refused(genuine, needle, {
      translationManifest: JSON.stringify({ ...facts, ...override }),
    });
  }
});

Deno.test("a payload named for the wrong locale is refused", async () => {
  // overrideEnglish means the Japanese text ships under the en_us name. A
  // payload named anything else did not come from the run this manifest
  // describes.
  const overlay = await writeZip([
    { path: `${LANG}/ja_jp.snbt`, text: JAPANESE },
    {
      path: "translation-manifest.json",
      text: JSON.stringify({
        tool: "modpack-quest-translator",
        toolVersion: "1.1.1",
        generatedAt: "2026-08-25T00:00:00.000Z",
        sourceLocale: "en_us",
        targetLocale: "ja_jp",
        overrideEnglish: true,
        keyCounts: { keys: 3, strings: 3, translated: 3, cached: 0, skipped: 0, fallback: 0 },
        sourceKeyDigests: sourceDigests(ENGLISH),
      }),
    },
    { path: "translation-report.json", text: JSON.stringify(REPORT) },
  ]);
  await refused(overlay, "en_us.snbt");
});

Deno.test("override mode ships the English fallback file, whatever locale was read", async () => {
  // `--override-english` replaces the en_us file FTB Quests falls back to, so
  // the payload is named en_us even for a run that read de_de (DESIGN.md 7.2).
  // The overlay writer, the provenance check and the installer's manifest
  // parser all have to agree on that, or a genuine overlay is refused.
  const german = await sourceArchiveOf(ENGLISH, "de_de");
  const built = await buildInstallerBundle(
    args(
      await overlayOf(JAPANESE, {
        sourceLocale: "de_de",
        sourceArchiveSha256: german.sha256,
        sourcePath: german.path,
      }),
      { sourceArchive: german.bytes },
    ),
  );
  assertEquals(built.manifest.payload[0].path, `${LANG}/en_us.snbt`);
  assertEquals(built.manifest.sourceLocale, "de_de");
});

Deno.test("a report whose failures were edited out to a bare count is refused", async () => {
  // A real report lists what failed. A hand-written `failed: 0` is a manifest
  // this tool never wrote.
  const overlay = await writeZip([
    { path: `${LANG}/en_us.snbt`, text: JAPANESE },
    { path: "translation-manifest.json", text: await manifestText() },
    { path: "translation-report.json", text: JSON.stringify({ ...REPORT, failed: 0 }) },
  ]);
  await refused(overlay, "failed");
});

Deno.test("the bundle README says what the digests prove and what they do not", async () => {
  const built = await buildInstallerBundle(args(await overlayOf(JAPANESE)));
  const bundle = await readZip(built.bytes);
  const readme = await bundle.readText("aca-2.4-ja_jp-en_us-override/README.md");

  // The digests are worth describing, because they do catch a corrupt download.
  assertStringIncludes(readme, "SHA-256");
  // But an unsigned bundle cannot prove who made it, and the README says so in
  // both languages rather than letting `containsSourceProse: false` imply it.
  assertStringIncludes(readme, "not signed");
  assertStringIncludes(readme, "署名がありません");
  // And the source-prose claim is described as the check it is, not as proof --
  // including whose word the source is taken on.
  assertStringIncludes(readme, "modpack archive the translation was made from");
  assertStringIncludes(readme, "relative to the archive supplied");
});

/** The manifest a genuine run writes, extracted from a genuine overlay. */
async function manifestText(): Promise<string> {
  const overlay = await readZip(await overlayOf(JAPANESE));
  return await overlay.readText("translation-manifest.json");
}

/**
 * The reviewer's sequence: a real source archive, a real payload of the pack's
 * own English, and a manifest that lies about what the source said.
 *
 * `sourceKeyDigests` is the manifest's own claim about text it read. A payload
 * compared only against that claim proves nothing at all -- whoever writes the
 * payload writes the claim beside it, and setting every digest to a string the
 * payload cannot possibly produce used to be enough to have the pack's own
 * prose packaged with `containsSourceProse: false`.
 *
 * So the claim is no longer read as evidence. Every digest is recomputed from
 * the archive the manifest names, and a manifest that disagrees with the file
 * it says it read is refused before the payload is looked at.
 */
function fabricatedManifest(overrides: Record<string, unknown> = {}): string {
  const honest = sourceDigests(ENGLISH);
  const lies: Record<string, string> = {};
  for (const key of Object.keys(honest)) lies[key] = "deadbeefdeadbeef";
  return JSON.stringify({
    tool: "modpack-quest-translator",
    toolVersion: "1.1.1",
    generatedAt: "2026-08-25T00:00:00.000Z",
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    overrideEnglish: true,
    sourceArchiveSha256: SOURCE.sha256,
    sourcePath: SOURCE.path,
    keyCounts: { keys: 3, strings: 3, translated: 3, cached: 0, skipped: 0, fallback: 0 },
    sourceKeyDigests: lies,
    ...overrides,
  });
}

Deno.test("a manifest that lies about the source cannot launder the source itself", async () => {
  const overlay = await writeZip([
    { path: `${LANG}/en_us.snbt`, text: ENGLISH },
    { path: "translation-manifest.json", text: fabricatedManifest() },
    { path: "translation-report.json", text: JSON.stringify(REPORT) },
  ]);
  await refused(overlay, "different source digest");
});

Deno.test("a manifest that lies about the source is refused even with a real payload", async () => {
  // Nothing is being smuggled here; the point is that the check does not depend
  // on the payload being wrong. A manifest whose account of the source is false
  // is refused on its own terms.
  const overlay = await writeZip([
    { path: `${LANG}/en_us.snbt`, text: JAPANESE },
    { path: "translation-manifest.json", text: fabricatedManifest() },
    { path: "translation-report.json", text: JSON.stringify(REPORT) },
  ]);
  await refused(overlay, "different source digest");
});

Deno.test("a manifest with no source archive digest cannot be checked, so it is refused", async () => {
  const overlay = await writeZip([
    { path: `${LANG}/en_us.snbt`, text: JAPANESE },
    {
      path: "translation-manifest.json",
      text: fabricatedManifest({
        sourceArchiveSha256: undefined,
        sourceKeyDigests: sourceDigests(ENGLISH),
      }),
    },
    { path: "translation-report.json", text: JSON.stringify(REPORT) },
  ]);
  await refused(overlay, "sourceArchiveSha256");
});

Deno.test("a source archive that is not the one the run read is refused", async () => {
  const other = await sourceArchiveOf(`${ENGLISH}// a different release\n`);
  await refused(await overlayOf(JAPANESE), "was made from", { sourceArchive: other.bytes });
});

Deno.test("a manifest pointing at a file the archive does not hold is refused", async () => {
  await refused(
    await overlayOf(JAPANESE, { sourcePath: "overrides/config/ftbquests/quests/lang/zz_zz.snbt" }),
    "says it read",
  );
});

/**
 * The reviewer's second sequence: a payload that is part translation and part
 * the pack's own prose.
 *
 * Comparing per-key digests answers "did *anything* change?", and one Japanese
 * title was enough to make it say yes -- so an overlay carrying two of ACA's
 * English sentences verbatim was packaged with `containsSourceProse: false`.
 * The payload is now compared string by string against the source as read out
 * of the archive, and a source string the translator's own validator would have
 * rejected coming back unchanged is rejected here too.
 */
Deno.test("an overlay that left two English prose strings untranslated is refused", async () => {
  const overlay = await overlayOf(PART_ENGLISH);
  await refused(overlay, "word for word");
  const error = await assertRejects(() => buildInstallerBundle(args(overlay)), AppError);
  // Named, so whoever rebuilds the overlay knows which strings to look at.
  assertStringIncludes(error.message, "aca.quest.1.desc");
  assertStringIncludes(error.message, "aca.quest.2.title");
});

Deno.test("the strings a translation run legitimately skips may come back unchanged", async () => {
  // Empty, whitespace-only, markup-only and too-short-to-be-prose strings are
  // exactly what `validateUnit` allows a provider to return byte-identical, so
  // refusing them here would refuse every honest overlay that has one.
  const built = await buildInstallerBundle(
    args(
      await overlayOf(TECHNICAL_JAPANESE, {
        sourceArchiveSha256: TECHNICAL_SOURCE.sha256,
        sourcePath: TECHNICAL_SOURCE.path,
        keyCounts: { keys: 2, strings: 7, translated: 2, cached: 0, skipped: 5, fallback: 0 },
        sourceKeyDigests: sourceDigests(TECHNICAL),
      }, finishedRun({ translated: 2, skipped: 5 })),
      { sourceArchive: TECHNICAL_SOURCE.bytes },
    ),
  );
  assertEquals(built.manifest.containsSourceProse, false);
});

Deno.test("a payload that dropped a line out of a description is refused", async () => {
  // Same keys, and every remaining string translated -- but one array element
  // fewer, which a per-key digest cannot describe and a player would notice.
  const shortened = TECHNICAL_JAPANESE.replace('    "&e"\n', "");
  await refused(
    await overlayOf(shortened, {
      sourceArchiveSha256: TECHNICAL_SOURCE.sha256,
      sourcePath: TECHNICAL_SOURCE.path,
      keyCounts: { keys: 2, strings: 7, translated: 2, cached: 0, skipped: 5, fallback: 0 },
      sourceKeyDigests: sourceDigests(TECHNICAL),
    }, finishedRun({ translated: 2, skipped: 5 })),
    "strings",
    { sourceArchive: TECHNICAL_SOURCE.bytes },
  );
});

Deno.test("counts the run wrote down are checked against the file it says it counted", async () => {
  await refused(
    await overlayOf(JAPANESE, {
      keyCounts: { keys: 99, strings: 3, translated: 3, cached: 0, skipped: 0, fallback: 0 },
    }),
    "keyCounts.keys",
  );
  await refused(
    await overlayOf(JAPANESE, {
      keyCounts: { keys: 3, strings: 99, translated: 3, cached: 0, skipped: 0, fallback: 0 },
    }),
    "keyCounts.strings",
  );
});
