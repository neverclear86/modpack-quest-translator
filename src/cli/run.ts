import { AppError, exitCodeFor } from "../errors.ts";
import { VERSION } from "../version.ts";
import { type CliOptions, parseArgs } from "./args.ts";
import { HELP } from "./help.ts";
import { Reporter } from "./reporter.ts";
import { BoundedHttpClient, type FetchLike } from "../net/http.ts";
import { type ResolvedPack, resolveLocalArchive, resolvePack } from "../resolve/mod.ts";
import { readZip } from "../archive/zip/reader.ts";
import { discoverQuestSource } from "../archive/discover.ts";
import { buildChapterIndex } from "../quests/chapter_index.ts";
import type { TranslationUnit } from "../quests/adapter.ts";
import { buildBatches } from "../translate/batcher.ts";
import { glossaryVersion, PROMPT_VERSION, TranslationCache } from "../translate/cache.ts";
import { type TranslateReport, translateUnits } from "../translate/orchestrator.ts";
import { validateDocument } from "../translate/validate.ts";
import { ClaudeCodeProvider } from "../translate/providers/claude_code.ts";
import { EchoProvider } from "../translate/providers/echo.ts";
import type { TranslationProvider } from "../translate/types.ts";
import { buildManifest, buildOverlay, buildReport, resolveOutputPlan } from "../output/package.ts";
import { buildReadme } from "../output/readme.ts";
import type { OverlayLayout, OverlayMeta, UpdateDiff } from "../output/types.ts";
import { createDefaultRedactor, Redactor } from "../util/redact.ts";
import { fastHashHex, sha256Hex } from "../util/hash.ts";
import { writeFileAtomic } from "../util/fs.ts";
import type { CommandRunner } from "../util/command.ts";

export interface RunDependencies {
  fetch?: FetchLike;
  commandRunner?: CommandRunner;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/** Entry point shared by the binary and the tests. Returns an exit code. */
export async function run(argv: readonly string[], deps: RunDependencies = {}): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const env = deps.env ?? readEnv();
  const redactor = deps.env ? Redactor.fromEnv(deps.env) : createDefaultRedactor();

  let options: CliOptions;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    reportFailure(
      error,
      new Reporter({
        json: argv.includes("--json"),
        quiet: false,
        verbose: false,
        color: !argv.includes("--no-color"),
        stdout,
        stderr,
        redactor,
      }),
    );
    return exitCodeFor(error);
  }

  if (options.mode === "help") {
    stdout(HELP);
    return 0;
  }
  if (options.mode === "version") {
    stdout(VERSION);
    return 0;
  }

  redactor.register(options.curseForgeApiKey);

  const reporter = new Reporter({
    json: options.json,
    quiet: options.quiet,
    verbose: options.verbose,
    color: options.color,
    stdout,
    stderr,
    redactor,
  });

  try {
    await execute(options, reporter, redactor, deps, env);
    return 0;
  } catch (error) {
    reportFailure(error, reporter);
    return exitCodeFor(error);
  }
}

async function execute(
  options: CliOptions,
  reporter: Reporter,
  redactor: Redactor,
  deps: RunDependencies,
  env: Record<string, string | undefined>,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const signal = deps.signal;

  const client = new BoundedHttpClient({
    fetch: deps.fetch,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxDownloadBytes,
  });

  // ---- resolve -------------------------------------------------------------
  let pack: ResolvedPack;
  if (options.archive) {
    pack = resolveLocalArchive(options.archive);
    reporter.stage("resolve", `local archive ${options.archive}`);
  } else {
    pack = await resolvePack(options.url!, {
      client,
      curseForgeApiKey: options.curseForgeApiKey,
      allowPrerelease: options.allowPrerelease,
      signal,
    });
    reporter.stage("resolve", pack.projectName ?? pack.fileName);
    for (const line of pack.describe().split("\n")) reporter.detail(line);
  }
  reporter.detail(`target locale: ${options.target.describe()}`);
  reporter.detail(
    options.overrideEnglish
      ? "mode: english override (writes en_us.snbt)"
      : `mode: target locale (writes ${options.target.locale}.snbt)`,
  );
  reporter.event({ type: "resolved", pack: describeForJson(pack) });

  // ---- download ------------------------------------------------------------
  let archiveBytes: Uint8Array;
  if (options.archive) {
    try {
      archiveBytes = await Deno.readFile(options.archive);
    } catch (cause) {
      throw new AppError("E_DOWNLOAD", `Could not read ${options.archive}`, { cause });
    }
    reporter.stage("download", `read ${formatBytes(archiveBytes.length)} from disk`);
  } else {
    archiveBytes = await client.getBytes(pack.downloadUrl, {
      headers: pack.downloadHeaders,
      signal,
      onProgress: (received, total) => {
        reporter.debug(
          `downloaded ${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ""}`,
        );
      },
    });
    reporter.stage("download", `${pack.fileName} (${formatBytes(archiveBytes.length)})`);
  }
  const sourceArchiveSha256 = await sha256Hex(archiveBytes);
  reporter.detail(`sha256: ${sourceArchiveSha256}`);

  // ---- inspect -------------------------------------------------------------
  const archive = await readZip(archiveBytes, { maxTotalBytes: options.maxDownloadBytes * 4 });
  const source = await discoverQuestSource(archive, { sourceLocale: options.sourceLocale });
  reporter.stage("inspect", `${source.flavour} archive, quest source ${source.path}`);
  if (source.alternates.length > 0) {
    reporter.detail(`also present (not used): ${source.alternates.join(", ")}`);
  }

  // ---- parse ---------------------------------------------------------------
  const document = source.adapter.extract(source.text);
  const langStrings: Record<string, string> = {};
  for (const unit of document.units) {
    if (unit.index === -1) langStrings[unit.key] = unit.text;
  }
  // One digest per SNBT key, covering array elements too. Stored in the
  // manifest so a later run can diff added/changed/removed/reused keys without
  // the manifest carrying the whole source file.
  const sourceKeyDigests = digestByKey(document.units);
  const chapterIndex = buildChapterIndex(source.chapterFiles, langStrings);
  const units: TranslationUnit[] = document.units.map((unit) => ({
    ...unit,
    chapter: unit.objectId ? chapterIndex.get(unit.objectId) : undefined,
  }));
  const withChapter = units.filter((u) => u.chapter !== undefined).length;

  reporter.stage(
    "parse",
    `${document.keyCount} keys, ${units.length} translatable strings ` +
      `(adapter: ${source.adapter.id})`,
  );
  reporter.detail(
    `chapter context resolved for ${withChapter}/${units.length} strings ` +
      `from ${source.chapterFiles.length} chapter file(s)`,
  );

  // ---- glossary and cache --------------------------------------------------
  const glossary = await loadGlossary(options);
  const cacheDir = options.cacheDir ?? defaultCacheDir(env);
  const cache = await TranslationCache.open(cacheDir, {
    sourceLocale: options.sourceLocale,
    targetLocale: options.target.locale,
    provider: options.provider,
    promptVersion: PROMPT_VERSION,
    glossaryVersion: glossaryVersion(glossary),
  }, { enabled: options.cacheEnabled });

  const updateDiff = options.previous
    ? await diffAgainstPrevious(options.previous, sourceKeyDigests)
    : undefined;
  if (updateDiff) {
    reporter.detail(
      `vs previous: ${updateDiff.added.length} added, ${updateDiff.changed.length} changed, ` +
        `${updateDiff.removed.length} removed, ${updateDiff.reused.length} reused`,
    );
  }

  const layout: Exclude<OverlayLayout, "auto"> = options.layout === "auto"
    ? "instance"
    : options.layout;

  const meta: OverlayMeta = {
    toolVersion: VERSION,
    generatedAt: now().toISOString(),
    sourceUrl: pack.sourceUrl,
    packName: pack.projectName ?? source.packInfo.name,
    packVersion: pack.versionName ?? source.packInfo.version,
    minecraftVersion: pack.minecraftVersion ?? source.packInfo.minecraftVersion,
    loader: pack.loader ?? source.packInfo.loader,
    sourceArchiveSha256,
    sourceLocale: options.sourceLocale,
    targetLocale: options.target.locale,
    targetLanguage: options.target.englishName,
    overrideEnglish: options.overrideEnglish,
    provider: options.provider,
    model: options.model,
    fallbackModel: options.fallbackModel,
    archiveFlavour: source.flavour,
    sourcePath: source.path,
    sourceKeyDigests,
    updateDiff,
  };

  // ---- dry run -------------------------------------------------------------
  if (options.dryRun) {
    const batches = buildBatches(
      units.filter((u) => u.text.trim().length > 0),
      { maxItems: options.batchSize, maxChars: options.batchChars },
    );
    const plan = await resolveOutputPlan(options.output, meta, { force: true });
    reporter.stage("translate", "dry run: nothing was translated");
    reporter.detail(`${batches.length} batches would be sent to ${options.provider}`);
    reporter.detail(`archive would be written to ${plan.archivePath}`);
    reporter.detail(`overlay entry: ${overlayEntry(meta, layout)}`);
    reporter.event({
      type: "dry-run",
      keys: document.keyCount,
      strings: units.length,
      batches: batches.length,
      archive: plan.archivePath,
    });
    reporter.done({
      "dry run": "no archive was written",
      keys: document.keyCount,
      strings: units.length,
      batches: batches.length,
      archive: plan.archivePath,
    });
    return;
  }

  // Fail before spending anything if the output path is already taken.
  const plan = await resolveOutputPlan(options.output, meta, { force: options.force });

  // ---- translate -----------------------------------------------------------
  const provider = createProvider(options, deps);
  const preflight = await provider.preflight();
  if (!preflight.ok) {
    throw new AppError("E_PREFLIGHT", preflight.problem ?? "The translation provider is unusable", {
      hint: preflight.hint,
    });
  }
  reporter.stage(
    "translate",
    `${provider.id}${preflight.version ? ` (${preflight.version})` : ""}` +
      `${preflight.auth ? `, auth: ${preflight.auth}` : ""}`,
  );
  reporter.detail(
    `model ${options.model}, fallback ${options.fallbackModel}, effort ${options.effort}`,
  );

  const { translations, report } = await translateUnits(units, {
    provider,
    cache,
    sourceLocale: options.sourceLocale,
    targetLocale: options.target.locale,
    glossary,
    model: options.model,
    fallbackModel: options.fallbackModel,
    effort: options.effort,
    packName: meta.packName,
    batchSize: options.batchSize,
    batchChars: options.batchChars,
    concurrency: options.concurrency,
    retries: options.retries,
    timeoutMs: options.timeoutMs * 3,
    signal,
    onProgress: (done, total) => reporter.progress(done, total),
  });
  await cache.flush();

  // ---- validate ------------------------------------------------------------
  const translatedSnbt = source.adapter.apply(source.text, translations);
  const validation = validateDocument(source.text, translatedSnbt);
  if (!validation.ok) {
    throw new AppError(
      "E_VALIDATION",
      `The translated quest file failed validation: ` +
        validation.problems.slice(0, 5).map((p) => p.message).join("; "),
      {
        hint: "No archive was written. This is a bug in the tool or a provider that " +
          "returned structurally invalid output.",
        details: { problems: validation.problems.length },
      },
    );
  }
  reporter.stage(
    "validate",
    `key set and value shapes match the source (${document.keyCount} keys)`,
  );

  // ---- package -------------------------------------------------------------
  meta.keyCounts = {
    keys: document.keyCount,
    strings: units.length,
    translated: report.translated,
    cached: report.cached,
    skipped: report.skipped,
    fallback: report.fallback,
  };

  const archiveOut = await buildOverlay({ translatedSnbt, meta, report, layout, redactor });
  await writeFileAtomic(plan.archivePath, archiveOut);
  await writeFileAtomic(plan.manifestPath, buildManifest(meta, redactor));
  await writeFileAtomic(plan.reportPath, buildReport(meta, report, redactor));
  await writeFileAtomic(plan.readmePath, redactor.text(buildReadme(meta, layout)));
  if (options.emitRaw) await writeFileAtomic(plan.rawSnbtPath, translatedSnbt);

  reporter.stage("package", `${plan.archivePath} (${formatBytes(archiveOut.length)})`);
  reporter.detail(`overlay entry: ${overlayEntry(meta, layout)}`);

  reporter.done({
    archive: plan.archivePath,
    manifest: plan.manifestPath,
    reportPath: plan.reportPath,
    readme: plan.readmePath,
    ...(options.emitRaw ? { raw: plan.rawSnbtPath } : {}),
    translated: report.translated,
    cached: report.cached,
    skipped: report.skipped,
    fallback: report.fallback,
    ...(report.costUsd > 0 ? { costUsd: report.costUsd } : {}),
    report: summarise(report),
  });
}

function overlayEntry(meta: OverlayMeta, layout: Exclude<OverlayLayout, "auto">): string {
  const name = `${meta.overrideEnglish ? "en_us" : meta.targetLocale}.snbt`;
  const inner = `config/ftbquests/quests/lang/${name}`;
  return layout === "overrides" ? `overrides/${inner}` : inner;
}

function summarise(report: TranslateReport): Record<string, unknown> {
  return {
    translated: report.translated,
    cached: report.cached,
    skipped: report.skipped,
    fallback: report.fallback,
    failed: report.failed.length,
    batches: report.batches,
    retries: report.retries,
    costUsd: report.costUsd,
  };
}

function createProvider(options: CliOptions, deps: RunDependencies): TranslationProvider {
  if (options.provider === "echo") return new EchoProvider();
  return new ClaudeCodeProvider({
    runner: deps.commandRunner,
    maxBudgetUsd: options.maxCostUsd,
  });
}

async function loadGlossary(options: CliOptions): Promise<Record<string, string>> {
  const glossary: Record<string, string> = {};
  if (options.glossaryFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(options.glossaryFile));
    } catch (cause) {
      throw new AppError(
        "E_INVALID_INPUT",
        `Could not read --glossary-file ${options.glossaryFile}`,
        {
          cause,
          hint: "It must be a JSON object mapping a source term to its required translation.",
        },
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError("E_INVALID_INPUT", "--glossary-file must contain a JSON object");
    }
    for (const [term, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new AppError("E_INVALID_INPUT", `Glossary entry ${term} must map to a string`);
      }
      glossary[term] = value;
    }
  }
  return { ...glossary, ...options.glossaryInline };
}

/** Digest each SNBT key's whole value, so array edits are detected too. */
function digestByKey(units: readonly TranslationUnit[]): Record<string, string> {
  const byKey = new Map<string, string[]>();
  for (const unit of units) {
    const parts = byKey.get(unit.key) ?? [];
    parts.push(unit.text);
    byKey.set(unit.key, parts);
  }
  const out: Record<string, string> = {};
  for (const [key, parts] of byKey) out[key] = fastHashHex(JSON.stringify(parts));
  return out;
}

async function diffAgainstPrevious(
  path: string,
  current: Record<string, string>,
): Promise<UpdateDiff> {
  let previous: Record<string, string>;
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as {
      sourceKeyDigests?: Record<string, string>;
    };
    previous = parsed.sourceKeyDigests ?? {};
  } catch (cause) {
    throw new AppError("E_INVALID_INPUT", `Could not read --previous ${path}`, {
      cause,
      hint: "Pass the translation-manifest.json produced by an earlier run.",
    });
  }

  if (Object.keys(previous).length === 0) {
    throw new AppError(
      "E_INVALID_INPUT",
      `--previous ${path} has no sourceKeyDigests to compare against`,
      { hint: "It must be a translation-manifest.json written by this tool." },
    );
  }

  const added: string[] = [];
  const changed: string[] = [];
  const reused: string[] = [];
  for (const [key, digest] of Object.entries(current)) {
    if (!(key in previous)) added.push(key);
    else if (previous[key] !== digest) changed.push(key);
    else reused.push(key);
  }
  const removed = Object.keys(previous).filter((key) => !(key in current));
  return { added, changed, removed, reused };
}

function defaultCacheDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CACHE_HOME;
  if (xdg) return `${xdg}/modpack-quest-translator`;
  const home = env.HOME ?? env.USERPROFILE;
  if (home) return `${home}/.cache/modpack-quest-translator`;
  return ".mqt-cache";
}

function readEnv(): Record<string, string | undefined> {
  const keys = ["CURSEFORGE_API_KEY", "CF_API_KEY", "XDG_CACHE_HOME", "HOME", "USERPROFILE"];
  const env: Record<string, string | undefined> = {};
  for (const key of keys) {
    try {
      env[key] = Deno.env.get(key);
    } catch {
      // Running without --allow-env; defaults apply.
    }
  }
  return env;
}

function describeForJson(pack: ResolvedPack): Record<string, unknown> {
  return {
    source: pack.source,
    project: pack.projectName,
    version: pack.versionName,
    minecraftVersion: pack.minecraftVersion,
    loader: pack.loader,
    publishedAt: pack.publishedAt,
    downloadUrl: pack.downloadUrl,
    fileName: pack.fileName,
  };
}

function reportFailure(error: unknown, reporter: Reporter): void {
  if (error instanceof AppError) {
    reporter.error(error.message, error.hint, error.code);
    return;
  }
  reporter.error(
    error instanceof Error ? error.message : String(error),
    "This is an unexpected internal error. Please report it with the command you ran.",
    "E_INTERNAL",
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
