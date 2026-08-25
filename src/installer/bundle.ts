import { AppError } from "../errors.ts";
import { normaliseEntryPath } from "../archive/safety.ts";
import { joinPath } from "../util/fs.ts";
import { sha256Hex } from "../util/hash.ts";

/** Bumped only for a change an older installer could not read correctly. */
export const BUNDLE_FORMAT_VERSION = 1;
export const BUNDLE_MANIFEST_NAME = "bundle-manifest.json";
export const PAYLOAD_DIR = "payload";

/**
 * The only directory an installer will ever write into. Quest localisation is
 * the whole feature, so nothing outside it needs to be installable -- and a
 * bundle that asks for anything else is either broken or hostile.
 */
export const QUEST_LANG_DIR = "config/ftbquests/quests/lang";

/** The only tool whose bundles this installer will act on. */
export const TOOL_NAME = "modpack-quest-translator";

/**
 * The one file a run installs, and its name.
 *
 * Override mode replaces the `en_us` file FTB Quests falls back to when the
 * player's own language has none, so the name is `en_us` whatever locale the
 * text was read from (DESIGN.md 7.2). The overlay writer, the packager's
 * provenance check and this parser all have to agree on that rule, so it is
 * written once: a disagreement means a genuine overlay gets refused.
 */
/**
 * A bundle id is a plain short name, and both ends check the same rule.
 *
 * It is the bundle's top-level directory, so the packager needs it safe as a
 * path; it is also written into `state.json`, into every backup sidecar and
 * into the report the player reads, so the installer needs it free of control
 * characters and of any length worth truncating.
 */
export function isPlainBundleId(value: string): boolean {
  // A dot-only name is built entirely from allowed characters but names a
  // directory rather than a bundle: as the bundle's top-level entry it makes
  // every path escape the archive root, and printed back to a player it reads
  // as a path. Refuse it here, where the message can name the flag to change.
  if (/^\.+$/.test(value)) return false;
  return /^[A-Za-z0-9._-]{1,120}$/.test(value);
}

export function shippedLangPath(
  meta: { targetLocale: string; overrideEnglish: boolean },
): string {
  return `${QUEST_LANG_DIR}/${meta.overrideEnglish ? "en_us" : meta.targetLocale}.snbt`;
}

const LOCALE = /^[a-z]{2,3}_[a-z]{2}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface BundlePayloadEntry {
  /** Instance-relative destination, always under QUEST_LANG_DIR. */
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface BundleBinaryEntry {
  path: string;
  target: string;
  sha256: string;
}

export interface BundleManifest {
  formatVersion: number;
  bundleId: string;
  tool: string;
  toolVersion: string;
  generatedAt: string;
  pack: { name?: string; version?: string };
  sourceLocale: string;
  targetLocale: string;
  overrideEnglish: boolean;
  /** Always false. The bundle carries translated text, never the pack's own prose. */
  containsSourceProse: false;
  payload: BundlePayloadEntry[];
  binaries: BundleBinaryEntry[];
}

export interface LoadedPayload extends BundlePayloadEntry {
  /** Absolute path of the payload file inside the bundle. */
  sourcePath: string;
  bytes: Uint8Array;
}

export interface LoadedBundleManifest {
  dir: string;
  manifest: BundleManifest;
}

export interface LoadedBundle extends LoadedBundleManifest {
  payload: LoadedPayload[];
}

const TAMPERED_HINT = "The bundle is corrupt or has been tampered with; download it again.";

export function bundleError(
  message: string,
  options: { hint?: string; cause?: unknown } = {},
): AppError {
  return new AppError("E_BUNDLE", message, options);
}

/**
 * Validate a payload destination against the allowlist.
 *
 * `normaliseEntryPath` already refuses traversal, absolute, drive-prefixed and
 * UNC names; this narrows what survives to a single `.snbt` file directly
 * inside the quest lang directory, so a bundle cannot aim a write at `saves/`
 * or at a nested path that only looks like it is inside the allowed directory.
 */
export function assertPayloadPath(rawPath: string): string {
  let path: string;
  try {
    path = normaliseEntryPath(rawPath);
  } catch (cause) {
    throw bundleError(`The bundle declares an unsafe payload path ${JSON.stringify(rawPath)}`, {
      hint: TAMPERED_HINT,
      cause,
    });
  }

  const prefix = `${QUEST_LANG_DIR}/`;
  const name = path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  if (name === undefined || name.includes("/") || !/^[A-Za-z0-9._-]+\.snbt$/.test(name)) {
    throw bundleError(
      `The bundle declares the payload path ${JSON.stringify(rawPath)}, which is not a ` +
        `.snbt file directly inside ${QUEST_LANG_DIR}`,
      { hint: "This installer only ever writes quest localisation files." },
    );
  }
  return path;
}

export function parseBundleManifest(text: string): BundleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw bundleError(`${BUNDLE_MANIFEST_NAME} is not valid JSON`, { cause });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw bundleError(`${BUNDLE_MANIFEST_NAME} is not a JSON object`);
  }
  const body = raw as Record<string, unknown>;

  const formatVersion = body.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion)) {
    throw bundleError(`${BUNDLE_MANIFEST_NAME} has no integer formatVersion`);
  }
  if (formatVersion > BUNDLE_FORMAT_VERSION) {
    throw bundleError(
      `This bundle was made by a newer version of the tool ` +
        `(bundle formatVersion ${formatVersion}, this installer understands ` +
        `${BUNDLE_FORMAT_VERSION})`,
      { hint: "Use the installer that came inside the bundle." },
    );
  }
  if (formatVersion < BUNDLE_FORMAT_VERSION) {
    throw bundleError(
      `${BUNDLE_MANIFEST_NAME} declares the unsupported formatVersion ${formatVersion}`,
    );
  }

  if (body.containsSourceProse !== false) {
    throw bundleError(
      "The bundle manifest does not declare containsSourceProse: false",
      {
        hint: "Bundles carry translated text only; the pack's own source prose is never " +
          "redistributed.",
      },
    );
  }

  const payloadRaw = body.payload;
  if (!Array.isArray(payloadRaw) || payloadRaw.length === 0) {
    throw bundleError(`${BUNDLE_MANIFEST_NAME} has no payload entries`);
  }
  const payload = payloadRaw.map((entry, index) => parsePayloadEntry(entry, index));
  const seen = new Set<string>();
  for (const entry of payload) {
    if (seen.has(entry.path)) {
      throw bundleError(`The bundle declares ${entry.path} twice`);
    }
    seen.add(entry.path);
  }

  const binariesRaw = body.binaries ?? [];
  if (!Array.isArray(binariesRaw)) {
    throw bundleError(`${BUNDLE_MANIFEST_NAME} has a non-array binaries field`);
  }

  // Never a path here, but it lands in state.json, in every backup sidecar and
  // in the report the player reads, so it stays a plain short name.
  const bundleId = requiredString(body, "bundleId");
  if (!isPlainBundleId(bundleId)) {
    throw bundleError(
      `${BUNDLE_MANIFEST_NAME} has the unusable bundleId ${JSON.stringify(bundleId)}`,
      { hint: TAMPERED_HINT },
    );
  }
  const tool = requiredString(body, "tool");
  if (tool !== TOOL_NAME) {
    throw bundleError(
      `${BUNDLE_MANIFEST_NAME} names the tool ${JSON.stringify(tool)}, not ${TOOL_NAME}`,
      { hint: "This installer only acts on bundles this tool produced." },
    );
  }
  const toolVersion = requiredString(body, "toolVersion");
  if (!SEMVER.test(toolVersion)) {
    throw bundleError(
      `${BUNDLE_MANIFEST_NAME} has the unusable toolVersion ${JSON.stringify(toolVersion)}`,
      { hint: TAMPERED_HINT },
    );
  }
  const generatedAt = requiredString(body, "generatedAt");
  const parsedAt = new Date(generatedAt);
  if (Number.isNaN(parsedAt.getTime()) || parsedAt.toISOString() !== generatedAt) {
    throw bundleError(
      `${BUNDLE_MANIFEST_NAME} has the unusable generatedAt ${JSON.stringify(generatedAt)}`,
      { hint: "Expected an ISO-8601 timestamp such as 2026-08-25T00:00:00.000Z." },
    );
  }
  const sourceLocale = localeField(body, "sourceLocale");
  const targetLocale = localeField(body, "targetLocale");
  if (sourceLocale === targetLocale) {
    throw bundleError(
      `${BUNDLE_MANIFEST_NAME} has targetLocale ${targetLocale}, which is also its sourceLocale ` +
        `-- that describes a copy of the pack's own file, not a translation of it`,
      { hint: TAMPERED_HINT },
    );
  }

  // The payload a bundle carries has to be the one it says it is, so a manifest
  // cannot describe a Japanese translation while shipping something else.
  const overrideEnglish = body.overrideEnglish === true;
  const expected = shippedLangPath({ targetLocale, overrideEnglish });
  if (!payload.some((entry) => entry.path === expected)) {
    throw bundleError(
      `${BUNDLE_MANIFEST_NAME} declares overrideEnglish: ${overrideEnglish} with locales ` +
        `${sourceLocale} -> ${targetLocale}, so it should install ${expected}, but its payload ` +
        `is ${payload.map((entry) => entry.path).join(", ")}`,
      { hint: TAMPERED_HINT },
    );
  }

  const packRaw = body.pack;
  const pack = typeof packRaw === "object" && packRaw !== null && !Array.isArray(packRaw)
    ? packRaw as Record<string, unknown>
    : {};

  return {
    formatVersion,
    bundleId,
    tool,
    toolVersion,
    generatedAt,
    pack: {
      name: optionalString(pack, "name"),
      version: optionalString(pack, "version"),
    },
    sourceLocale,
    targetLocale,
    overrideEnglish,
    containsSourceProse: false,
    payload,
    binaries: binariesRaw.map((entry, index) => parseBinaryEntry(entry, index)),
  };
}

function localeField(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  if (!LOCALE.test(value)) {
    throw bundleError(
      `${BUNDLE_MANIFEST_NAME} has the unusable ${field} ${JSON.stringify(value)}`,
      { hint: "A locale looks like en_us or ja_jp." },
    );
  }
  return value;
}

function parsePayloadEntry(entry: unknown, index: number): BundlePayloadEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw bundleError(`payload[${index}] is not an object`);
  }
  const body = entry as Record<string, unknown>;
  const path = assertPayloadPath(requiredString(body, "path", `payload[${index}].path`));
  const sha256 = requiredString(body, "sha256", `payload[${index}].sha256`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw bundleError(`payload[${index}].sha256 is not a lower-case SHA-256 digest`);
  }
  const sizeBytes = body.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw bundleError(`payload[${index}].sizeBytes is not a whole number of bytes`);
  }
  return { path, sha256, sizeBytes };
}

/**
 * A binary entry is only ever reported, never opened by this installer -- but
 * the bundle README prints these paths, and a name that reads as a path is one
 * a reader could be talked into running.
 */
function parseBinaryEntry(entry: unknown, index: number): BundleBinaryEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw bundleError(`binaries[${index}] is not an object`);
  }
  const body = entry as Record<string, unknown>;
  const path = requiredString(body, "path", `binaries[${index}].path`);
  if (!/^bin\/[A-Za-z0-9._-]+$/.test(path)) {
    throw bundleError(
      `binaries[${index}].path is ${JSON.stringify(path)}, which is not a plain name inside bin/`,
      { hint: TAMPERED_HINT },
    );
  }
  const target = requiredString(body, "target", `binaries[${index}].target`);
  if (!/^[A-Za-z0-9._-]+$/.test(target)) {
    throw bundleError(
      `binaries[${index}].target is ${JSON.stringify(target)}, which is not a compile target`,
      { hint: TAMPERED_HINT },
    );
  }
  const sha256 = requiredString(body, "sha256", `binaries[${index}].sha256`);
  if (!SHA256.test(sha256)) {
    throw bundleError(
      `binaries[${index}].sha256 is not a lower-case SHA-256 digest`,
      { hint: TAMPERED_HINT },
    );
  }
  return { path, target, sha256 };
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
  label = key,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw bundleError(`${BUNDLE_MANIFEST_NAME} has no usable ${label}`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read and validate `bundle-manifest.json`. Payload bytes are not touched. */
export async function loadBundleManifest(dir: string): Promise<LoadedBundleManifest> {
  const path = joinPath(dir, BUNDLE_MANIFEST_NAME);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    throw bundleError(`No ${BUNDLE_MANIFEST_NAME} in ${dir}`, {
      hint: `Point --bundle at the extracted bundle directory, the one holding ` +
        `${BUNDLE_MANIFEST_NAME}.`,
      cause,
    });
  }
  return { dir, manifest: parseBundleManifest(text) };
}

/**
 * Read the manifest *and* every payload file, verifying size and digest before
 * the caller is allowed to touch the user's instance. Nothing is written until
 * this returns, so a tampered bundle cannot get as far as opening the target.
 */
export async function loadBundle(dir: string): Promise<LoadedBundle> {
  const { manifest } = await loadBundleManifest(dir);
  const payload: LoadedPayload[] = [];

  for (const entry of manifest.payload) {
    const sourcePath = joinPath(dir, PAYLOAD_DIR, entry.path);
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(sourcePath);
    } catch (cause) {
      throw bundleError(`The bundle is missing the payload file ${PAYLOAD_DIR}/${entry.path}`, {
        hint: "The bundle is incomplete; extract it again, keeping the whole directory.",
        cause,
      });
    }
    if (bytes.byteLength !== entry.sizeBytes) {
      throw bundleError(
        `${PAYLOAD_DIR}/${entry.path} is ${bytes.byteLength} bytes, but the manifest ` +
          `declares ${entry.sizeBytes}`,
        { hint: TAMPERED_HINT },
      );
    }
    const digest = await sha256Hex(bytes);
    if (digest !== entry.sha256) {
      throw bundleError(
        `${PAYLOAD_DIR}/${entry.path} does not match the digest in the manifest`,
        { hint: TAMPERED_HINT },
      );
    }
    payload.push({ ...entry, sourcePath, bytes });
  }

  return { dir, manifest, payload };
}
