import type { ArchiveFlavour } from "../archive/discover.ts";
import type { TranslateReport } from "../translate/orchestrator.ts";

export type OverlayLayout = "instance" | "overrides" | "both" | "auto";

export interface OverlayMeta {
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
  /** Path of the source lang file inside the pack archive. */
  sourcePath: string;
  keyCounts?: KeyCounts;
  /** Per-key digest of the source values, so a later run can diff against it. */
  sourceKeyDigests?: Record<string, string>;
  /** Diff against a previous run, when --previous was supplied. */
  updateDiff?: UpdateDiff;
}

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
