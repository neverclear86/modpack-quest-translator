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

  const packRaw = body.pack;
  const pack = typeof packRaw === "object" && packRaw !== null && !Array.isArray(packRaw)
    ? packRaw as Record<string, unknown>
    : {};

  return {
    formatVersion,
    bundleId: requiredString(body, "bundleId"),
    tool: requiredString(body, "tool"),
    toolVersion: requiredString(body, "toolVersion"),
    generatedAt: requiredString(body, "generatedAt"),
    pack: {
      name: optionalString(pack, "name"),
      version: optionalString(pack, "version"),
    },
    sourceLocale: requiredString(body, "sourceLocale"),
    targetLocale: requiredString(body, "targetLocale"),
    overrideEnglish: body.overrideEnglish === true,
    containsSourceProse: false,
    payload,
    binaries: binariesRaw.map((entry, index) => parseBinaryEntry(entry, index)),
  };
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

function parseBinaryEntry(entry: unknown, index: number): BundleBinaryEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw bundleError(`binaries[${index}] is not an object`);
  }
  const body = entry as Record<string, unknown>;
  return {
    path: requiredString(body, "path", `binaries[${index}].path`),
    target: requiredString(body, "target", `binaries[${index}].target`),
    sha256: requiredString(body, "sha256", `binaries[${index}].sha256`),
  };
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
