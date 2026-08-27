import { AppError } from "../errors.ts";
import { writeZip, type ZipWriteEntry } from "../archive/zip/writer.ts";
import { shippedLangPath } from "../installer/bundle.ts";
import type { Durability } from "../util/durable.ts";
import {
  basenameOf,
  dirnameOf,
  joinPath,
  pathExists,
  writeFileAtomic,
  writeFileNoClobber,
} from "../util/fs.ts";
import type { Redactor } from "../util/redact.ts";
import { buildReadme } from "./readme.ts";
import { buildPackMcmeta, outputLocale, resourcePackLangPath } from "./resourcepack.ts";
import type { ArtifactMeta, OverlayLayout, OverlayReport } from "./types.ts";

export type {
  ArtifactKind,
  ArtifactMeta,
  Limitations,
  OverlayLayout,
  OverlayMeta,
  OverlayReport,
  ResourcePackInfo,
  SourceLangJar,
} from "./types.ts";

export interface BuildArtifactArgs {
  /** The translated document: SNBT for an overlay, JSON for a resource pack. */
  payload: string;
  meta: ArtifactMeta;
  report: OverlayReport;
  layout: Exclude<OverlayLayout, "auto">;
  redactor: Redactor;
}

/** The archive entry paths the payload is written to. */
export function artifactEntryPaths(
  meta: ArtifactMeta,
  layout: Exclude<OverlayLayout, "auto">,
): string[] {
  if (meta.artifact === "resource-pack") {
    // A resource pack has exactly one layout: Minecraft's own. `--layout` is
    // refused for this mode rather than silently ignored.
    return [
      meta.resourcePack?.langPath ??
        resourcePackLangPath(meta.resourcePack?.namespace ?? "minecraft", outputLocale(meta)),
    ];
  }
  // Shared with the packager and the installer, so an overlay this writer
  // produces is one they recognise. See `shippedLangPath`.
  const inner = shippedLangPath(meta);
  if (layout === "overrides") return [`overrides/${inner}`];
  if (layout === "both") return [inner, `overrides/${inner}`];
  return [inner];
}

export function buildManifest(meta: ArtifactMeta, redactor: Redactor): string {
  const manifest = {
    tool: "modpack-quest-translator",
    toolVersion: meta.toolVersion,
    generatedAt: meta.generatedAt,
    artifact: meta.artifact,
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
    sourceLangJar: meta.sourceLangJar,
    questMod: { version: meta.questModVersion, file: meta.questModFile },
    resourcePack: meta.resourcePack,
    sourceLocale: meta.sourceLocale,
    targetLocale: meta.targetLocale,
    targetLanguage: meta.targetLanguage,
    overrideEnglish: meta.overrideEnglish,
    provider: meta.provider,
    model: meta.model,
    fallbackModel: meta.fallbackModel,
    keyCounts: meta.keyCounts ?? {},
    limitations: meta.limitations,
    sourceKeyDigests: meta.sourceKeyDigests ?? {},
    updateDiff: meta.updateDiff,
  };
  return `${JSON.stringify(redactor.value(manifest), null, 2)}\n`;
}

export function buildReport(
  meta: ArtifactMeta,
  report: OverlayReport,
  redactor: Redactor,
): string {
  const body = {
    generatedAt: meta.generatedAt,
    artifact: meta.artifact,
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
    limitations: meta.limitations,
    updateDiff: meta.updateDiff,
  };
  return `${JSON.stringify(redactor.value(body), null, 2)}\n`;
}

/** Build the installable archive. Deterministic for identical input. */
export async function buildArtifact(args: BuildArtifactArgs): Promise<Uint8Array> {
  const entries: ZipWriteEntry[] = artifactEntryPaths(args.meta, args.layout).map((path) => ({
    path,
    text: args.payload,
  }));

  if (args.meta.artifact === "resource-pack") {
    entries.push({ path: "pack.mcmeta", text: buildPackMcmeta(args.meta) });
  }

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
  /** Where `--emit-raw` writes the translated document itself. */
  rawPayloadPath: string;
  /** True when --output named a directory rather than a .zip file. */
  isDirectory: boolean;
}

export interface OutputPlanOptions {
  force?: boolean;
  /** Whether `--emit-raw` will write the payload, so its path counts too. */
  emitRaw?: boolean;
}

/**
 * `--output` is deterministic: a path ending in `.zip` is that exact archive,
 * anything else is a directory. Existing files are never silently overwritten,
 * which is what makes "a newer pack release creates a new output" true.
 * See DESIGN.md §7.
 */
export async function resolveOutputPlan(
  output: string,
  meta: ArtifactMeta,
  options: OutputPlanOptions = {},
): Promise<OutputPlan> {
  const trimmed = output.replace(/[/\\]+$/, "");
  if (trimmed.length === 0) {
    throw new AppError("E_INVALID_INPUT", "--output is empty");
  }

  const isZip = /\.zip$/i.test(trimmed);
  const archivePath = isZip ? trimmed : joinPath(trimmed, defaultArchiveName(meta));
  const base = archivePath.replace(/\.zip$/i, "");
  const extension = meta.artifact === "resource-pack" ? "json" : "snbt";

  const plan: OutputPlan = {
    archivePath,
    manifestPath: `${base}.manifest.json`,
    reportPath: `${base}.report.json`,
    readmePath: `${base}.README.md`,
    rawPayloadPath: `${base}.${outputLocale(meta)}.${extension}`,
    isDirectory: !isZip,
  };

  if (!options.force) {
    // Every path the run will write, not just the archive. The sidecars are as
    // much a result as the ZIP is, and a run that checked one of five and then
    // overwrote the other four would break the guarantee this check exists for.
    // Checked here, before a single key is translated, and reported all at once
    // so the answer to "what is in the way?" takes one run rather than four.
    const willWrite = [
      plan.archivePath,
      plan.manifestPath,
      plan.reportPath,
      plan.readmePath,
      ...(options.emitRaw ? [plan.rawPayloadPath] : []),
    ];
    const existing: string[] = [];
    for (const path of willWrite) {
      if (await pathExists(path)) existing.push(path);
    }
    if (existing.length > 0) {
      throw new AppError(
        "E_WRITE",
        `Refusing to overwrite ${existing.length} existing file(s): ${existing.join(", ")}`,
        {
          hint: "Running against a newer pack release should produce a new output. " +
            "Pass --force to overwrite, or choose a different --output.",
        },
      );
    }
  }

  return plan;
}

export interface OutputFile {
  path: string;
  data: Uint8Array | string;
}

export interface PublishOutputsOptions {
  /** `--force`: replace whatever is at these names, on purpose. */
  force?: boolean;
  /** How bytes are pushed past the page cache. Injected so faults are testable. */
  durability?: Durability;
}

/**
 * Write every final output, without overwriting a file this run did not put
 * there.
 *
 * `resolveOutputPlan` looks at these names before a single key is translated,
 * and the run then spends minutes translating. A check made then is a statement
 * about the past by the time the bytes are ready, so it is not what the promise
 * rests on: each output is published with `writeFileNoClobber`, which cannot
 * replace a name something else has taken. The preflight stays because failing
 * before the money is spent is worth a great deal; it is an early answer, not
 * the guarantee.
 *
 * A run publishes several files and can therefore lose the race on the fourth
 * having won it on the first three. Earlier outputs are deliberately left in
 * place. Removing them safely is impossible with pathname operations: another
 * process can replace a checked path immediately before unlink. A partial set
 * of this run's outputs is safer than ever risking deletion of a stranger's
 * file; the next run's preflight names every leftover explicitly.
 *
 * `--force` means the opposite thing on purpose, and keeps the plain replacing
 * write.
 */
export async function publishOutputs(
  files: readonly OutputFile[],
  options: PublishOutputsOptions = {},
): Promise<void> {
  if (options.force) {
    for (const file of files) {
      await writeFileAtomic(file.path, file.data, { durability: options.durability });
    }
    return;
  }

  const published: string[] = [];
  for (const file of files) {
    let didPublish: boolean;
    try {
      didPublish = await writeFileNoClobber(file.path, file.data, {
        durability: options.durability,
      });
    } catch (failure) {
      throw withPublishedNote(failure, published);
    }
    if (!didPublish) {
      throw raceLost(file.path, published);
    }
    published.push(file.path);
  }
}

function raceLost(path: string, published: readonly string[]): AppError {
  return new AppError(
    "E_WRITE",
    `Refusing to overwrite ${path}: it was created while this run was working`,
    {
      hint:
        `Its contents were left exactly as they are. ${
          publishedNote(published)
        }Another run, an editor or a sync ` +
        `client took the name after the output paths were checked. Choose a different --output, ` +
        `or pass --force to replace whatever is there.`,
    },
  );
}

/** Keep the original failure's words while naming outputs already published. */
function withPublishedNote(failure: unknown, published: readonly string[]): unknown {
  const note = publishedNote(published);
  if (note.length === 0 || !(failure instanceof AppError)) return failure;
  return new AppError(failure.code, failure.message, {
    cause: failure.cause,
    details: failure.details,
    hint: failure.hint ? `${note}${failure.hint}` : note.trim(),
  });
}

/** Explain the conservative no-delete policy after a partial publication. */
function publishedNote(published: readonly string[]): string {
  if (published.length === 0) return "";
  return `The ${published.length} output(s) already published by this run were left in place ` +
    `because deleting by pathname could delete a competitor's replacement: ${
      published.join(", ")
    }. `;
}

/** `<slug>-<packVersion>-<targetLocale>[-en_us-override][-resourcepack].zip` */
function defaultArchiveName(meta: ArtifactMeta): string {
  const slug = safeSegment(meta.packName ?? basenameOf(dirnameOf(meta.sourcePath)) ?? "modpack");
  const version = meta.packVersion ? `-${safeSegment(meta.packVersion)}` : "";
  const suffix = meta.overrideEnglish ? "-en_us-override" : "";
  const kind = meta.artifact === "resource-pack" ? "-resourcepack" : "";
  return `${slug}${version}-${safeSegment(meta.targetLocale)}${suffix}${kind}.zip`;
}

function safeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") || "modpack";
}
