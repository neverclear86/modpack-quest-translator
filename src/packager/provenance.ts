import { AppError } from "../errors.ts";
import { shippedLangPath } from "../installer/bundle.ts";
import { digestByKey } from "../quests/digest.ts";
import { ftbQuestsLangAdapter } from "../quests/ftbquests_lang.ts";

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
  "Point --overlay at an archive a translation run produced, and --manifest/--report at the " +
  "sidecars it wrote beside it.";

/**
 * Decide whether an overlay is a translation this tool produced, before a byte
 * of it is copied into a bundle.
 *
 * **What this can prove.** The overlay carries the manifest and report the
 * translation run wrote, they agree with each other, they describe a run that
 * finished, and -- the load-bearing one -- the payload is *not* the source the
 * manifest recorded. The run stores a digest per SNBT key of the text it read;
 * re-computing those over the payload with the same function and finding every
 * one unchanged means the file is the pack's own prose wearing a translation's
 * manifest.
 *
 * **What this cannot prove.** Nothing here is a signature. A manifest is a JSON
 * file, and someone determined to lie can write one that agrees with a payload
 * they also wrote. What it does do is make the *accident* -- pointing --overlay
 * at the pack's own `en_us.snbt`, or at a half-finished run -- mechanically
 * impossible, and that is the failure mode this project actually has. The
 * bundle README says as much rather than leaving `containsSourceProse: false`
 * to imply more.
 */
export function verifyTranslationProvenance(args: {
  manifestText: string | undefined;
  reportText: string | undefined;
  /** Install target → payload bytes, as gathered from the overlay. */
  payloads: ReadonlyMap<string, Uint8Array>;
}): TranslationFacts {
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
  assertPayloadIsNotTheSource(manifest.sourceKeyDigests, args.payloads.get(expected)!);

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

/**
 * The one check that stands between the pack's own prose and `payload/`.
 *
 * The run recorded a digest per SNBT key of the text it *read*. Re-computing
 * them over the payload with the same function must produce the same key set --
 * a translation preserves keys -- and must not reproduce every digest, because
 * a file that digests to the source, key for key, *is* the source.
 */
function assertPayloadIsNotTheSource(raw: unknown, payload: Uint8Array): void {
  if (!isObject(raw) || Object.keys(raw).length === 0) {
    throw refuse(
      `${TRANSLATION_MANIFEST_NAME} has no sourceKeyDigests, so there is no way to prove its ` +
        `payload is a translation rather than the pack's own quest file`,
      REBUILD,
    );
  }
  const source = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || value.length === 0) {
      throw refuse(
        `${TRANSLATION_MANIFEST_NAME} sourceKeyDigests[${key}] is not a digest`,
        REBUILD,
      );
    }
    source.set(key, value);
  }

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
  const sourceKeys = [...source.keys()].sort();
  if (payloadKeys.length !== sourceKeys.length || payloadKeys.some((k, i) => k !== sourceKeys[i])) {
    throw refuse(
      `The overlay's quest file has ${payloadKeys.length} keys, but ` +
        `${TRANSLATION_MANIFEST_NAME} recorded ${sourceKeys.length} for the run it describes -- ` +
        `they are not the same file`,
      REBUILD,
    );
  }

  const unchanged = payloadKeys.filter((key) => payloadDigests[key] === source.get(key));
  if (unchanged.length === payloadKeys.length) {
    throw refuse(
      `Every key in the overlay's quest file is byte-for-byte the source text this manifest ` +
        `describes, so it is the pack's own prose and will not be packaged`,
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
