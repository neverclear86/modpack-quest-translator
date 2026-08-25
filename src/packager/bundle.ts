import { AppError } from "../errors.ts";
import { readZip } from "../archive/zip/reader.ts";
import { writeZip, type ZipWriteEntry } from "../archive/zip/writer.ts";
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_MANIFEST_NAME,
  type BundleBinaryEntry,
  type BundleManifest,
  PAYLOAD_DIR,
  QUEST_LANG_DIR,
} from "../installer/bundle.ts";
import { sha256Hex } from "../util/hash.ts";
import { EXECUTABLE_MODE, linuxLauncher, windowsLauncher } from "./launchers.ts";
import { buildBundleReadme } from "./readme.ts";

export const TRANSLATION_MANIFEST_NAME = "translation-manifest.json";
export const TRANSLATION_REPORT_NAME = "translation-report.json";

/** Overlay entries that are metadata rather than installable payload. */
const OVERLAY_METADATA = new Set(["README.md", TRANSLATION_MANIFEST_NAME, TRANSLATION_REPORT_NAME]);

/** Layout prefixes the translator emits; both mean the same install target. */
const LAYOUT_PREFIXES = ["", "overrides/"];

export interface PackagedBinary {
  /** Bundle-relative path, e.g. `bin/mqt-installer-linux-x86_64`. */
  path: string;
  /** The deno compile target triple. */
  target: string;
  bytes: Uint8Array;
}

export interface PackageBundleArgs {
  /** The raw overlay ZIP this tool produced. */
  overlay: Uint8Array;
  bundleId: string;
  toolVersion: string;
  /**
   * ISO-8601 override. Left unset, it comes from the translation run's own
   * manifest, which is what makes packaging the same overlay twice produce
   * byte-identical output. There is deliberately no fallback to the clock.
   */
  generatedAt?: string;
  binaries: PackagedBinary[];
  /** Overrides for the sidecars, when they were given explicitly. */
  translationManifest?: string;
  translationReport?: string;
}

export interface BuiltBundle {
  bytes: Uint8Array;
  manifest: BundleManifest;
  /** Archive paths, sorted, for reporting. */
  entries: string[];
}

function packageError(message: string, hint?: string): AppError {
  return new AppError("E_BUNDLE", message, { hint });
}

/**
 * Build an installer bundle from an overlay this tool produced.
 *
 * The packager copies payload bytes only from entries the overlay itself holds
 * under the quest lang directory, and refuses everything else outright. That
 * refusal is the mechanical guarantee behind "the pack's own source prose is
 * never redistributed": there is no code path by which a file from the original
 * pack can reach `payload/`.
 */
export async function buildInstallerBundle(args: PackageBundleArgs): Promise<BuiltBundle> {
  const overlay = await readZip(args.overlay);

  const payloads = new Map<string, Uint8Array>();
  const metadata = new Map<string, Uint8Array>();

  for (const entry of overlay.files()) {
    if (OVERLAY_METADATA.has(entry.path)) {
      metadata.set(entry.path, await overlay.read(entry.path));
      continue;
    }
    const target = installTargetFor(entry.path);
    if (target === undefined) {
      throw packageError(
        `The overlay contains ${entry.path}, which is not quest localisation and will not be ` +
          `packaged`,
        `A bundle installs only ${QUEST_LANG_DIR}/<locale>.snbt. Rebuild the overlay, or ` +
          `package a different one.`,
      );
    }
    const bytes = await overlay.read(entry.path);
    const existing = payloads.get(target);
    if (existing && !sameBytes(existing, bytes)) {
      throw packageError(
        `The overlay holds two copies of ${target} that disagree`,
        "Rebuild the overlay; --layout both should emit identical copies.",
      );
    }
    payloads.set(target, bytes);
  }

  if (payloads.size === 0) {
    throw packageError(
      `The overlay contains no file under ${QUEST_LANG_DIR}`,
      "Point --overlay at an archive this tool produced.",
    );
  }

  const translationManifest = args.translationManifest ??
    decode(metadata.get(TRANSLATION_MANIFEST_NAME));
  const translationReport = args.translationReport ?? decode(metadata.get(TRANSLATION_REPORT_NAME));
  const source = readTranslationManifest(translationManifest);
  const generatedAt = args.generatedAt ?? source.generatedAt;
  if (generatedAt === undefined) {
    throw new AppError(
      "E_INVALID_INPUT",
      `The overlay has no ${TRANSLATION_MANIFEST_NAME} to take a timestamp from`,
      {
        hint: "Pass --generated-at <iso>, or --manifest pointing at the manifest the " +
          "translation run wrote.",
      },
    );
  }

  const payloadPaths = [...payloads.keys()].sort();
  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    bundleId: args.bundleId,
    tool: "modpack-quest-translator",
    toolVersion: args.toolVersion,
    generatedAt,
    pack: {
      ...(source.packName ? { name: source.packName } : {}),
      ...(source.packVersion ? { version: source.packVersion } : {}),
    },
    sourceLocale: source.sourceLocale,
    targetLocale: source.targetLocale,
    overrideEnglish: source.overrideEnglish,
    containsSourceProse: false,
    payload: await Promise.all(payloadPaths.map(async (path) => ({
      path,
      sha256: await sha256Hex(payloads.get(path)!),
      sizeBytes: payloads.get(path)!.byteLength,
    }))),
    binaries: await Promise.all(
      args.binaries.map(async (binary): Promise<BundleBinaryEntry> => ({
        path: binary.path,
        target: binary.target,
        sha256: await sha256Hex(binary.bytes),
      })),
    ),
  };

  const entries: ZipWriteEntry[] = [
    { path: `${args.bundleId}/README.md`, text: buildBundleReadme(manifest) },
    { path: `${args.bundleId}/INSTALL-WINDOWS.cmd`, text: windowsLauncher("install") },
    { path: `${args.bundleId}/UNINSTALL-WINDOWS.cmd`, text: windowsLauncher("uninstall") },
    {
      path: `${args.bundleId}/INSTALL-LINUX.sh`,
      text: linuxLauncher("install"),
      mode: EXECUTABLE_MODE,
    },
    {
      path: `${args.bundleId}/UNINSTALL-LINUX.sh`,
      text: linuxLauncher("uninstall"),
      mode: EXECUTABLE_MODE,
    },
    {
      path: `${args.bundleId}/${BUNDLE_MANIFEST_NAME}`,
      text: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];

  if (translationManifest !== undefined) {
    entries.push({
      path: `${args.bundleId}/${TRANSLATION_MANIFEST_NAME}`,
      text: translationManifest,
    });
  }
  if (translationReport !== undefined) {
    entries.push({ path: `${args.bundleId}/${TRANSLATION_REPORT_NAME}`, text: translationReport });
  }
  for (const binary of args.binaries) {
    entries.push({
      path: `${args.bundleId}/${binary.path}`,
      data: binary.bytes,
      mode: EXECUTABLE_MODE,
    });
  }
  for (const path of payloadPaths) {
    entries.push({ path: `${args.bundleId}/${PAYLOAD_DIR}/${path}`, data: payloads.get(path)! });
  }

  const bytes = await writeZip(entries);
  return { bytes, manifest, entries: entries.map((entry) => entry.path).sort() };
}

/** The instance-relative destination for an overlay entry, or undefined. */
function installTargetFor(path: string): string | undefined {
  for (const prefix of LAYOUT_PREFIXES) {
    if (!path.startsWith(`${prefix}${QUEST_LANG_DIR}/`)) continue;
    const name = path.slice(`${prefix}${QUEST_LANG_DIR}/`.length);
    if (name.includes("/") || !/^[A-Za-z0-9._-]+\.snbt$/.test(name)) return undefined;
    return `${QUEST_LANG_DIR}/${name}`;
  }
  return undefined;
}

interface TranslationFacts {
  packName?: string;
  packVersion?: string;
  sourceLocale: string;
  targetLocale: string;
  overrideEnglish: boolean;
  generatedAt?: string;
}

function readTranslationManifest(text: string | undefined): TranslationFacts {
  const fallback: TranslationFacts = {
    sourceLocale: "en_us",
    targetLocale: "unknown",
    overrideEnglish: false,
  };
  if (text === undefined) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw packageError(
      `${TRANSLATION_MANIFEST_NAME} is not valid JSON`,
      "Pass --manifest pointing at the manifest the translation run wrote.",
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
  const body = raw as Record<string, unknown>;
  const pack = typeof body.pack === "object" && body.pack !== null
    ? body.pack as Record<string, unknown>
    : {};
  return {
    ...(typeof pack.name === "string" ? { packName: pack.name } : {}),
    ...(typeof pack.version === "string" ? { packVersion: pack.version } : {}),
    sourceLocale: typeof body.sourceLocale === "string" ? body.sourceLocale : fallback.sourceLocale,
    targetLocale: typeof body.targetLocale === "string" ? body.targetLocale : fallback.targetLocale,
    overrideEnglish: body.overrideEnglish === true,
    ...(typeof body.generatedAt === "string" ? { generatedAt: body.generatedAt } : {}),
  };
}

function decode(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
