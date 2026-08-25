import { AppError } from "../errors.ts";
import { discoverQuestSource } from "../archive/discover.ts";
import { readZip } from "../archive/zip/reader.ts";
import { shippedLangPath } from "../installer/bundle.ts";
import { digestByKey } from "../quests/digest.ts";
import { ftbQuestsLangAdapter } from "../quests/ftbquests_lang.ts";
import { sha256Hex } from "../util/hash.ts";

export const TRANSLATION_MANIFEST_NAME = "translation-manifest.json";
export const TRANSLATION_REPORT_NAME = "translation-report.json";

/** `en_us`, `ja_jp`, `pt_br`. */
const LOCALE = /^[a-z]{2,3}_[a-z]{2}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
const TOOL = "modpack-quest-translator";

/** What the manifest turned out to say, once it was believed. */
export interface TranslationFacts {
  packName?: string;
  packVersion?: string;
  sourceLocale: string;
  targetLocale: string;
  overrideEnglish: boolean;
  generatedAt: string;
  /** The one install target this overlay is allowed to produce. */
  payloadPath: string;
}

function refuse(message: string, hint?: string): AppError {
  return new AppError("E_BUNDLE", message, { hint });
}

const REBUILD =
  "Point --overlay at an archive a translation run produced, --manifest/--report at the " +
  "sidecars it wrote beside it, and --source-archive at the modpack archive that run read.";

const SOURCE_HINT =
  "--source-archive has to be the modpack archive the translation run read, byte for byte. " +
  "Its sha256 is recorded in the run's own manifest.";

/**
 * Decide whether an overlay is a translation this tool produced, before a byte
 * of it is copied into a bundle.
 *
 * **What this can prove.** The overlay carries the manifest and report the
 * translation run wrote, they agree with each other, and they describe a run
 * that finished. Then the load-bearing part: the caller has to hand over the
 * modpack archive the run read, its bytes have to hash to the digest the
 * manifest recorded for it, and the source quest file is re-found and re-read
 * *out of that archive*. Every per-key digest the manifest claims for the
 * source is recomputed from those bytes and has to match, as do the key and
 * string counts -- so a manifest that lies about what the source said is
 * refused rather than believed. Finally the payload is compared against the
 * source as independently read: same keys, and not the same text.
 *
 * That closes the hole a metadata-only check leaves open. Nothing in the
 * overlay is evidence about the source, because whoever writes the payload
 * writes the manifest beside it; the archive is evidence, because its digest
 * pins it and its contents are read rather than described.
 *
 * **What this cannot prove.** Nothing here is a signature, and the guarantee is
 * *relative to the archive supplied*. Hand it a fabricated modpack archive and
 * a manifest that agrees with it, and the two will agree -- what is established
 * is "this payload is a translation of the file in that archive", not "that
 * archive is what the publisher released". Establishing the second needs a
 * signed provenance scheme this project does not have, and the bundle README
 * says so rather than leaving `containsSourceProse: false` to imply it.
 */
export async function verifyTranslationProvenance(args: {
  manifestText: string | undefined;
  reportText: string | undefined;
  /** Install target → payload bytes, as gathered from the overlay. */
  payloads: ReadonlyMap<string, Uint8Array>;
  /** The modpack archive the translation run read. Required; see above. */
  sourceArchive: Uint8Array;
}): Promise<TranslationFacts> {
  if (args.manifestText === undefined) {
    throw refuse(
      `The overlay has no ${TRANSLATION_MANIFEST_NAME}, so there is no way to tell a ` +
        `translation from the pack's own quest file`,
      REBUILD,
    );
  }
  const manifest = parseObject(args.manifestText, TRANSLATION_MANIFEST_NAME);

  if (manifest.tool !== TOOL) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} says it was written by ` +
        `${JSON.stringify(manifest.tool)}, not by ${TOOL}`,
      REBUILD,
    );
  }
  const toolVersion = manifest.toolVersion;
  if (typeof toolVersion !== "string" || !SEMVER.test(toolVersion)) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} has no usable toolVersion ` +
        `(${JSON.stringify(toolVersion)})`,
      REBUILD,
    );
  }
  const generatedAt = isoTimestamp(
    manifest.generatedAt,
    `${TRANSLATION_MANIFEST_NAME} generatedAt`,
  );

  const sourceLocale = locale(manifest.sourceLocale, "sourceLocale");
  const targetLocale = locale(manifest.targetLocale, "targetLocale");
  if (sourceLocale === targetLocale) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} has targetLocale ${targetLocale}, which is also its ` +
        `sourceLocale -- that describes a copy, not a translation`,
      REBUILD,
    );
  }
  if (typeof manifest.overrideEnglish !== "boolean") {
    throw refuse(`${TRANSLATION_MANIFEST_NAME} has no boolean overrideEnglish`, REBUILD);
  }
  const overrideEnglish = manifest.overrideEnglish;

  // The overlay writer emits exactly one install target, named by the rule all
  // three of it, this check and the installer share. Anything else did not come
  // from the run this manifest describes.
  const expected = shippedLangPath({ targetLocale, overrideEnglish });
  const paths = [...args.payloads.keys()].sort();
  if (paths.length !== 1 || paths[0] !== expected) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} describes a run that produces ${expected}, but the ` +
        `overlay holds ${paths.length === 0 ? "no quest file" : paths.join(", ")}`,
      REBUILD,
    );
  }

  assertSomethingWasTranslated(manifest.keyCounts);
  assertRunFinished(args.reportText, targetLocale);

  const source = await readRecordedSource(manifest, sourceLocale, args.sourceArchive);
  assertManifestDescribesTheSource(manifest, source);
  assertPayloadIsATranslationOf(source, args.payloads.get(expected)!);

  const pack = isObject(manifest.pack) ? manifest.pack : {};
  return {
    ...(typeof pack.name === "string" && pack.name.length > 0 ? { packName: pack.name } : {}),
    ...(typeof pack.version === "string" && pack.version.length > 0
      ? { packVersion: pack.version }
      : {}),
    sourceLocale,
    targetLocale,
    overrideEnglish,
    generatedAt,
    payloadPath: expected,
  };
}

/** A run that translated nothing produced nothing worth shipping. */
function assertSomethingWasTranslated(raw: unknown): void {
  if (!isObject(raw)) {
    throw refuse(`${TRANSLATION_MANIFEST_NAME} has no keyCounts`, REBUILD);
  }
  const count = (field: string): number => {
    const value = raw[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw refuse(
        `${TRANSLATION_MANIFEST_NAME} keyCounts.${field} is not a whole number`,
        REBUILD,
      );
    }
    return value;
  };
  const produced = count("translated") + count("cached") + count("fallback");
  if (produced === 0) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} records that nothing was translated, cached or fell back, ` +
        `so its payload cannot be a translation`,
      REBUILD,
    );
  }
}

/**
 * A half-finished run is not something to hand a player.
 *
 * `failed` is the *list* of strings that could not be translated and validated,
 * which is what a run actually writes. A bare count in that field is a report
 * this tool has never produced, so it is refused rather than read leniently.
 */
function assertRunFinished(reportText: string | undefined, targetLocale: string): void {
  if (reportText === undefined) {
    throw refuse(
      `The overlay has no ${TRANSLATION_REPORT_NAME}, so there is no way to tell whether the ` +
        `translation run finished`,
      REBUILD,
    );
  }
  const report = parseObject(reportText, TRANSLATION_REPORT_NAME);
  const failed = report.failed;
  if (!Array.isArray(failed)) {
    throw refuse(
      `${TRANSLATION_REPORT_NAME} has no failed list (${JSON.stringify(failed)}); a run records ` +
        `what could not be translated, not just how much`,
      REBUILD,
    );
  }
  if (failed.length > 0) {
    throw refuse(
      `${TRANSLATION_REPORT_NAME} records ${failed.length} failed translation(s); a partial ` +
        `translation is not packaged`,
      "Re-run the translation until it reports no failures, then package that overlay.",
    );
  }
  if (typeof report.targetLocale === "string" && report.targetLocale !== targetLocale) {
    throw refuse(
      `${TRANSLATION_REPORT_NAME} is for ${report.targetLocale} but ` +
        `${TRANSLATION_MANIFEST_NAME} is for ${targetLocale}`,
      REBUILD,
    );
  }
}

/** The source quest file, as read out of the archive rather than described. */
interface ReadSource {
  path: string;
  digests: Record<string, string>;
  keyCount: number;
  unitCount: number;
}

/**
 * Find and read the source quest file inside the archive the run recorded.
 *
 * The archive is pinned by digest first, so "the source" is a specific pile of
 * bytes and not whatever was handed over. The file inside it is then rediscovered
 * with the same rules the translation run used, and the path the manifest claims
 * has to be one of the ones that search actually turned up -- a manifest cannot
 * point the reader at a file of its own choosing.
 */
async function readRecordedSource(
  manifest: Record<string, unknown>,
  sourceLocale: string,
  archiveBytes: Uint8Array,
): Promise<ReadSource> {
  const declared = manifest.sourceArchiveSha256;
  if (typeof declared !== "string" || !/^[0-9a-f]{64}$/.test(declared)) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} has no usable sourceArchiveSha256, so the archive it was ` +
        `made from cannot be identified`,
      REBUILD,
    );
  }
  const actual = await sha256Hex(archiveBytes);
  if (actual !== declared) {
    throw refuse(
      `--source-archive hashes to ${actual}, but ${TRANSLATION_MANIFEST_NAME} was made from ` +
        `${declared}`,
      SOURCE_HINT,
    );
  }

  const recordedPath = manifest.sourcePath;
  if (typeof recordedPath !== "string" || recordedPath.length === 0) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} has no sourcePath, so there is no way to tell which file in ` +
        `the archive the run read`,
      REBUILD,
    );
  }

  const archive = await readZip(archiveBytes);
  // Chapter files are context for translating, not for verifying, so none are
  // read: this is a several-hundred-megabyte archive in the ordinary case.
  const found = await discoverQuestSource(archive, { sourceLocale, maxChapterFiles: 0 });
  if (recordedPath !== found.path && !found.alternates.includes(recordedPath)) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} says it read ${recordedPath}, but the ${sourceLocale} quest ` +
        `file in --source-archive is ${[found.path, ...found.alternates].join(", ")}`,
      SOURCE_HINT,
    );
  }

  const text = await archive.readText(recordedPath);
  const detected = ftbQuestsLangAdapter.detect(text);
  if (!detected.supported) {
    throw refuse(
      `${recordedPath} in --source-archive is not a readable FTB Quests lang file ` +
        `(${detected.reason ?? "unrecognised"})`,
      SOURCE_HINT,
    );
  }
  const document = ftbQuestsLangAdapter.extract(text);
  return {
    path: recordedPath,
    digests: digestByKey(document.units),
    keyCount: document.keyCount,
    unitCount: document.units.length,
  };
}

/**
 * The manifest's account of the source has to match the source.
 *
 * This is what makes the rest of the check mean anything. `sourceKeyDigests` is
 * the manifest's own claim about text it read, and a payload compared only
 * against that claim proves nothing at all: whoever writes the payload writes
 * the claim. Recomputing every digest from the archive turns it from an
 * assertion into a fact, and a manifest that disagrees is refused outright
 * rather than quietly overruled.
 */
function assertManifestDescribesTheSource(
  manifest: Record<string, unknown>,
  source: ReadSource,
): void {
  const raw = manifest.sourceKeyDigests;
  if (!isObject(raw) || Object.keys(raw).length === 0) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} has no sourceKeyDigests, so there is no way to prove its ` +
        `payload is a translation rather than the pack's own quest file`,
      REBUILD,
    );
  }

  const claimed = Object.keys(raw).sort();
  const actual = Object.keys(source.digests).sort();
  if (claimed.length !== actual.length || claimed.some((key, i) => key !== actual[i])) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} records ${claimed.length} source keys, but ${source.path} in ` +
        `--source-archive has ${actual.length} -- the manifest does not describe this archive`,
      SOURCE_HINT,
    );
  }
  const wrong = actual.filter((key) => raw[key] !== source.digests[key]);
  if (wrong.length > 0) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} records a different source digest from the one ${source.path} ` +
        `in --source-archive actually produces, for ${wrong.length} of ${actual.length} keys ` +
        `(${wrong.slice(0, 3).join(", ")}${wrong.length > 3 ? ", ..." : ""})`,
      SOURCE_HINT,
    );
  }

  // Counts the run wrote down, checked against the file it says it counted.
  const counts = manifest.keyCounts as Record<string, unknown>;
  for (
    const [field, expected] of [
      ["keys", source.keyCount],
      ["strings", source.unitCount],
    ] as const
  ) {
    if (counts[field] !== expected) {
      throw refuse(
        `${TRANSLATION_MANIFEST_NAME} keyCounts.${field} is ${
          JSON.stringify(counts[field])
        }, but ` +
          `${source.path} in --source-archive has ${expected}`,
        SOURCE_HINT,
      );
    }
  }
}

/**
 * The last check: the payload has to be a translation *of that source*.
 *
 * A translation preserves the key set and changes the text behind it. Compared
 * against the source as independently read -- not against the manifest's
 * account of it -- a payload that reproduces every digest is the pack's own
 * prose, whatever the manifest beside it says.
 */
function assertPayloadIsATranslationOf(source: ReadSource, payload: Uint8Array): void {
  const text = new TextDecoder().decode(payload);
  const detected = ftbQuestsLangAdapter.detect(text);
  if (!detected.supported) {
    throw refuse(
      `The overlay's quest file is not a readable FTB Quests lang file ` +
        `(${detected.reason ?? "unrecognised"})`,
      REBUILD,
    );
  }
  const payloadDigests = digestByKey(ftbQuestsLangAdapter.extract(text).units);

  const payloadKeys = Object.keys(payloadDigests).sort();
  const sourceKeys = Object.keys(source.digests).sort();
  if (payloadKeys.length !== sourceKeys.length || payloadKeys.some((k, i) => k !== sourceKeys[i])) {
    throw refuse(
      `The overlay's quest file has ${payloadKeys.length} keys, but ${source.path} in ` +
        `--source-archive has ${sourceKeys.length} -- they are not the same file`,
      REBUILD,
    );
  }

  const translated = payloadKeys.filter((key) => payloadDigests[key] !== source.digests[key]);
  if (translated.length === 0) {
    throw refuse(
      `Every key in the overlay's quest file is byte-for-byte ${source.path} in ` +
        `--source-archive, so it is the pack's own prose and will not be packaged`,
      "Package the translated overlay, not the file the translation was read from.",
    );
  }
}

function parseObject(text: string, name: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new AppError("E_BUNDLE", `${name} is not valid JSON`, { hint: REBUILD, cause });
  }
  if (!isObject(raw)) throw refuse(`${name} is not a JSON object`, REBUILD);
  return raw;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function locale(value: unknown, field: string): string {
  if (typeof value !== "string" || !LOCALE.test(value)) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} has no usable ${field} (${JSON.stringify(value)})`,
      REBUILD,
    );
  }
  return value;
}

/** ISO-8601 that survives a round trip, so "yesterday" and month 13 are out. */
export function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw refuse(`${label} is not a string`, REBUILD);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw refuse(
      `${label} is not an ISO-8601 timestamp (${JSON.stringify(value)})`,
      "Expected something like 2026-08-25T00:00:00.000Z.",
    );
  }
  return value;
}
