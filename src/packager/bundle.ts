import { AppError } from "../errors.ts";
import { readZip } from "../archive/zip/reader.ts";
import { writeZip, type ZipWriteEntry } from "../archive/zip/writer.ts";
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_MANIFEST_NAME,
  type BundleBinaryEntry,
  type BundleManifest,
  isPlainBundleId,
  PAYLOAD_DIR,
  QUEST_LANG_DIR,
} from "../installer/bundle.ts";
import { sha256Hex } from "../util/hash.ts";
import { EXECUTABLE_MODE, linuxLauncher, windowsLauncher } from "./launchers.ts";
import {
  isoTimestamp,
  TRANSLATION_MANIFEST_NAME,
  TRANSLATION_REPORT_NAME,
  verifyTranslationProvenance,
} from "./provenance.ts";
import { buildBundleReadme } from "./readme.ts";

export { TRANSLATION_MANIFEST_NAME, TRANSLATION_REPORT_NAME };

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
  /**
   * The modpack archive the translation run read. Not optional: without it the
   * only account of what the source said is the manifest sitting next to the
   * payload, and whoever writes one writes the other.
   */
  sourceArchive: Uint8Array;
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
 * Two things stand between the pack's own prose and `payload/`. The first is
 * the allowlist: bytes are copied only from entries the overlay itself holds
 * under the quest lang directory, and anything else is refused outright. The
 * second, and the one that matters, is `verifyTranslationProvenance` -- the
 * payload is compared against the source quest file read out of the modpack
 * archive the run recorded, pinned by digest. An overlay holding the original
 * `en_us.snbt` fails that however its manifest is dressed up, because the
 * source it is measured against is read rather than described.
 *
 * That is not a signature and is not claimed as one; see `provenance.ts`.
 */
export async function buildInstallerBundle(args: PackageBundleArgs): Promise<BuiltBundle> {
  // It becomes the bundle's top-level directory. Checked here rather than left
  // to the ZIP writer, whose complaint about an unsafe entry path would not
  // tell anyone which flag to change.
  if (!isPlainBundleId(args.bundleId)) {
    throw packageError(
      `--bundle-id ${JSON.stringify(args.bundleId)} is not a plain name`,
      "Use letters, digits, dot, dash and underscore, up to 120 characters.",
    );
  }

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
  const source = await verifyTranslationProvenance({
    manifestText: translationManifest,
    reportText: translationReport,
    payloads,
    sourceArchive: args.sourceArchive,
  });
  // `--generated-at` overrides the timestamp for reproducibility; it is not a
  // way past the provenance check, and it still has to be a real timestamp.
  const generatedAt = args.generatedAt === undefined
    ? source.generatedAt
    : isoTimestamp(args.generatedAt, "--generated-at");

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

function decode(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
