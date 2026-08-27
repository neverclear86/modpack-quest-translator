import type { ArchiveFlavour } from "../archive/discover.ts";
import type { TranslateReport } from "../translate/orchestrator.ts";

export type OverlayLayout = "instance" | "overrides" | "both" | "auto";

/**
 * What kind of installable thing a run produces.
 *
 * `snbt-overlay` is FTB Quests' own localization file, extracted into an
 * instance. `resource-pack` is a normal Minecraft resource pack, used when the
 * quest files hold `{translation.key}` placeholders and the strings live in a
 * mod's language file: those keys can only be overridden the way Minecraft
 * overrides any other mod string.
 */
export type ArtifactKind = "snbt-overlay" | "resource-pack";

export interface ResourcePackInfo {
  /** `assets/<namespace>/lang/...`, the namespace the strings belong to. */
  namespace: string;
  packFormat: number;
  /** False when the format was the fallback rather than a known MC version. */
  packFormatExact: boolean;
  /** Entry path of the emitted language file. */
  langPath: string;
}

/**
 * Where the source strings came from. The jar's path on disk is deliberately
 * not recorded -- it can carry a user name -- so provenance is the file's own
 * name, its hash and the entry that was read.
 */
export interface SourceLangJar {
  file: string;
  sha256: string;
  entry: string;
}

/**
 * What this run could not do, stated rather than papered over. Both are
 * structural: a key the quest files reference but no language file defines
 * cannot be translated, and a label typed straight into a quest file has no
 * translation key to override.
 */
export interface Limitations {
  /** Quest files scanned for translation-key references. */
  scannedQuestFiles: number;
  /** Distinct keys those files referenced. */
  referencedKeys: number;
  /** Referenced keys the language file does not define. */
  missingKeys: string[];
  /** Hard-coded visible labels, with the file they were found in. */
  literalLabels: { field: string; text: string; file: string; count: number }[];
  /** Quest files that did not parse, so their references are unknown. */
  unreadableQuestFiles: string[];
}

/** Everything the manifest, the report and the README are generated from. */
export interface ArtifactMeta {
  artifact: ArtifactKind;
  toolVersion: string;
  /** ISO-8601. Injected rather than read from the clock, so runs are testable. */
  generatedAt: string;
  sourceUrl: string;
  packName?: string;
  packVersion?: string;
  minecraftVersion?: string;
  loader?: string;
  sourceArchiveSha256: string;
  sourceLocale: string;
  targetLocale: string;
  targetLanguage?: string;
  overrideEnglish: boolean;
  provider: string;
  model: string;
  fallbackModel: string;
  archiveFlavour: ArchiveFlavour;
  /** Path of the source strings: in the pack archive, or inside the lang jar. */
  sourcePath: string;
  /** Detected FTB Quests mod version, when the pack's file list revealed one. */
  questModVersion?: string;
  questModFile?: string;
  keyCounts?: KeyCounts;
  /** Per-key digest of the source values, so a later run can diff against it. */
  sourceKeyDigests?: Record<string, string>;
  /** Diff against a previous run, when --previous was supplied. */
  updateDiff?: UpdateDiff;
  /** Resource-pack mode only. */
  resourcePack?: ResourcePackInfo;
  sourceLangJar?: SourceLangJar;
  limitations?: Limitations;
}

/**
 * The overlay writer, the packager and the installer all speak this type. It
 * grew to cover resource packs too; the old name stays so those callers, and
 * bundles already on disk, keep working.
 */
export type OverlayMeta = ArtifactMeta;

export interface KeyCounts {
  keys: number;
  strings: number;
  translated: number;
  cached: number;
  skipped: number;
  fallback: number;
}

export interface UpdateDiff {
  added: string[];
  changed: string[];
  removed: string[];
  reused: string[];
}

export type OverlayReport = TranslateReport;
