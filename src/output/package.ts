import { AppError } from "../errors.ts";
import { writeZip, type ZipWriteEntry } from "../archive/zip/writer.ts";
import { basenameOf, dirnameOf, joinPath, pathExists } from "../util/fs.ts";
import type { Redactor } from "../util/redact.ts";
import { buildReadme } from "./readme.ts";
import type { OverlayLayout, OverlayMeta, OverlayReport } from "./types.ts";

export type { OverlayLayout, OverlayMeta, OverlayReport } from "./types.ts";

const LANG_DIR = "config/ftbquests/quests/lang";

export interface BuildOverlayArgs {
  translatedSnbt: string;
  meta: OverlayMeta;
  report: OverlayReport;
  layout: Exclude<OverlayLayout, "auto">;
  redactor: Redactor;
}

/** The archive entry paths for a layout. */
export function overlayEntryPaths(
  meta: OverlayMeta,
  layout: Exclude<OverlayLayout, "auto">,
): string[] {
  const name = `${meta.overrideEnglish ? "en_us" : meta.targetLocale}.snbt`;
  const inner = `${LANG_DIR}/${name}`;
  if (layout === "overrides") return [`overrides/${inner}`];
  if (layout === "both") return [inner, `overrides/${inner}`];
  return [inner];
}

export function buildManifest(meta: OverlayMeta, redactor: Redactor): string {
  const manifest = {
    tool: "modpack-quest-translator",
    toolVersion: meta.toolVersion,
    generatedAt: meta.generatedAt,
    sourceUrl: meta.sourceUrl,
    pack: {
      name: meta.packName,
      version: meta.packVersion,
      minecraftVersion: meta.minecraftVersion,
      loader: meta.loader,
      archiveFlavour: meta.archiveFlavour,
    },
    sourceArchiveSha256: meta.sourceArchiveSha256,
    sourcePath: meta.sourcePath,
    questMod: { version: meta.questModVersion, file: meta.questModFile },
    sourceLocale: meta.sourceLocale,
    targetLocale: meta.targetLocale,
    targetLanguage: meta.targetLanguage,
    overrideEnglish: meta.overrideEnglish,
    provider: meta.provider,
    model: meta.model,
    fallbackModel: meta.fallbackModel,
    keyCounts: meta.keyCounts ?? {},
    sourceKeyDigests: meta.sourceKeyDigests ?? {},
    updateDiff: meta.updateDiff,
  };
  return `${JSON.stringify(redactor.value(manifest), null, 2)}\n`;
}

export function buildReport(
  meta: OverlayMeta,
  report: OverlayReport,
  redactor: Redactor,
): string {
  const body = {
    generatedAt: meta.generatedAt,
    targetLocale: meta.targetLocale,
    provider: meta.provider,
    translated: report.translated,
    cached: report.cached,
    skipped: report.skipped,
    fallback: report.fallback,
    failed: report.failed,
    batches: report.batches,
    retries: report.retries,
    modelsUsed: report.modelsUsed,
    usage: report.usage,
    costUsd: report.costUsd,
    updateDiff: meta.updateDiff,
  };
  return `${JSON.stringify(redactor.value(body), null, 2)}\n`;
}

/** Build the installable overlay archive. Deterministic for identical input. */
export async function buildOverlay(args: BuildOverlayArgs): Promise<Uint8Array> {
  const entries: ZipWriteEntry[] = overlayEntryPaths(args.meta, args.layout).map((path) => ({
    path,
    text: args.translatedSnbt,
  }));

  entries.push(
    { path: "README.md", text: args.redactor.text(buildReadme(args.meta, args.layout)) },
    { path: "translation-manifest.json", text: buildManifest(args.meta, args.redactor) },
    { path: "translation-report.json", text: buildReport(args.meta, args.report, args.redactor) },
  );

  return await writeZip(entries);
}

export interface OutputPlan {
  archivePath: string;
  manifestPath: string;
  reportPath: string;
  readmePath: string;
  rawSnbtPath: string;
  /** True when --output named a directory rather than a .zip file. */
  isDirectory: boolean;
}

export interface OutputPlanOptions {
  force?: boolean;
}

/**
 * `--output` is deterministic: a path ending in `.zip` is that exact archive,
 * anything else is a directory. Existing files are never silently overwritten,
 * which is what makes "a newer pack release creates a new output" true.
 * See DESIGN.md §7.
 */
export async function resolveOutputPlan(
  output: string,
  meta: OverlayMeta,
  options: OutputPlanOptions = {},
): Promise<OutputPlan> {
  const trimmed = output.replace(/[/\\]+$/, "");
  if (trimmed.length === 0) {
    throw new AppError("E_INVALID_INPUT", "--output is empty");
  }

  const isZip = /\.zip$/i.test(trimmed);
  const archivePath = isZip ? trimmed : joinPath(trimmed, defaultArchiveName(meta));
  const base = archivePath.replace(/\.zip$/i, "");

  const plan: OutputPlan = {
    archivePath,
    manifestPath: `${base}.manifest.json`,
    reportPath: `${base}.report.json`,
    readmePath: `${base}.README.md`,
    rawSnbtPath: `${base}.${meta.overrideEnglish ? "en_us" : meta.targetLocale}.snbt`,
    isDirectory: !isZip,
  };

  if (!options.force && await pathExists(plan.archivePath)) {
    throw new AppError(
      "E_WRITE",
      `Refusing to overwrite the existing file ${plan.archivePath}`,
      {
        hint: "Running against a newer pack release should produce a new output. " +
          "Pass --force to overwrite, or choose a different --output.",
      },
    );
  }

  return plan;
}

/** `<slug>-<packVersion>-<targetLocale>[-en_us-override].zip` */
function defaultArchiveName(meta: OverlayMeta): string {
  const slug = safeSegment(meta.packName ?? basenameOf(dirnameOf(meta.sourcePath)) ?? "modpack");
  const version = meta.packVersion ? `-${safeSegment(meta.packVersion)}` : "";
  const suffix = meta.overrideEnglish ? "-en_us-override" : "";
  return `${slug}${version}-${safeSegment(meta.targetLocale)}${suffix}.zip`;
}

function safeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") || "modpack";
}
