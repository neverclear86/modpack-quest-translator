import { AppError } from "../errors.ts";
import { type ResolvedLocale, resolveTargetLocale } from "../locale.ts";
import type { OverlayLayout } from "../output/types.ts";

export type RunMode = "run" | "help" | "version";

export interface CliOptions {
  mode: RunMode;
  url?: string;
  archive?: string;
  target: ResolvedLocale;
  output: string;
  overrideEnglish: boolean;
  sourceLocale: string;
  layout: OverlayLayout;
  /**
   * Local mod jar providing `assets/<namespace>/lang/<source>.json`. Its presence
   * is what selects resource-pack mode: never a guess about the pack.
   */
  langJar?: string;
  langNamespace?: string;
  packFormat?: number;
  provider: string;
  model: string;
  fallbackModel: string;
  effort: string;
  batchSize: number;
  batchChars: number;
  concurrency: number;
  retries: number;
  timeoutMs: number;
  maxDownloadBytes: number;
  maxCostUsd?: number;
  cacheDir?: string;
  cacheEnabled: boolean;
  previous?: string;
  glossaryFile?: string;
  glossaryInline: Record<string, string>;
  emitRaw: boolean;
  force: boolean;
  dryRun: boolean;
  allowPrerelease: boolean;
  curseForgeApiKey?: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  color: boolean;
}

const QUALITY_PRESETS: Record<string, { model: string; fallbackModel: string }> = {
  fast: { model: "haiku", fallbackModel: "haiku" },
  balanced: { model: "haiku", fallbackModel: "sonnet" },
  best: { model: "sonnet", fallbackModel: "opus" },
};

const LAYOUTS: OverlayLayout[] = ["auto", "instance", "overrides", "both"];
const PROVIDERS = ["claude-code", "echo"];

/** Flags that take a value. Everything else is a boolean switch. */
const VALUE_FLAGS = new Set([
  "--url",
  "-u",
  "--archive",
  "--target",
  "-t",
  "--output",
  "-o",
  "--override-english",
  "--source-locale",
  "--layout",
  "--lang-jar",
  "--lang-namespace",
  "--pack-format",
  "--provider",
  "--model",
  "--fallback-model",
  "--quality",
  "--effort",
  "--batch-size",
  "--batch-chars",
  "--concurrency",
  "--retries",
  "--timeout",
  "--max-download",
  "--max-cost-usd",
  "--cache-dir",
  "--previous",
  "--glossary",
  "--glossary-file",
  "--curseforge-api-key",
]);

const BOOLEAN_FLAGS = new Set([
  "--override-en-us",
  "--emit-raw",
  "--force",
  "--dry-run",
  "--allow-prerelease",
  "--no-cache",
  "--json",
  "--quiet",
  "--verbose",
  "--no-color",
  "--help",
  "-h",
  "--version",
  "-v",
  "--allow-partial",
]);

interface RawArgs {
  values: Map<string, string[]>;
  switches: Set<string>;
}

function tokenize(argv: readonly string[]): RawArgs {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "--") {
      const rest = argv.slice(i + 1);
      if (rest.length > 0) {
        throw usage(`Unexpected positional argument(s): ${rest.join(" ")}`);
      }
      break;
    }

    if (!token.startsWith("-")) {
      throw usage(`Unexpected positional argument: ${token}`);
    }

    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;

    if (BOOLEAN_FLAGS.has(name) && inlineValue === undefined) {
      switches.add(name);
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      throw usage(
        `Unknown option: ${name}`,
        "Run `modpack-quest-translator --help` to see the supported options.",
      );
    }

    let value = inlineValue;
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw usage(`Option ${name} requires a value`);
    }
    const list = values.get(name) ?? [];
    list.push(value);
    values.set(name, list);
  }

  return { values, switches };
}

function usage(message: string, hint?: string): AppError {
  return new AppError("E_INVALID_INPUT", message, {
    hint: hint ?? "Run `modpack-quest-translator --help` for usage.",
  });
}

function single(raw: RawArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const list = raw.values.get(name);
    if (list && list.length > 0) return list[list.length - 1];
  }
  return undefined;
}

function integer(
  raw: RawArgs,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = single(raw, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw usage(`${name} must be a whole number, got "${value}"`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw usage(`${name} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/**
 * Ceiling for any byte-size flag.
 *
 * Every downstream limit is derived from `--max-download` -- the HTTP body cap,
 * the `--lang-jar` cap, and the ZIP reader's total-inflation cap at four times
 * this -- so a value that is not a finite, safe integer does not merely allow a
 * large download: it silently switches those defences off. 16 GiB is far above
 * any real modpack or mod jar, and four times it is still an exact integer.
 */
export const MAX_SIZE_BYTES = 16 * 1024 ** 3;

function size(raw: RawArgs, name: string, fallback: number): number {
  const value = single(raw, name);
  if (value === undefined) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(value.trim());
  if (!match) throw usage(`${name} must be a size such as 512MiB or 2GB, got "${value}"`);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "" ? 1 : SIZE_UNITS[unit];
  if (multiplier === undefined) throw usage(`${name} has an unknown unit "${match[2]}"`);
  const bytes = Math.round(Number(match[1]) * multiplier);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw usage(`${name} must be greater than zero, got "${value}"`);
  }
  if (bytes > MAX_SIZE_BYTES) {
    throw usage(
      `${name} must be at most ${MAX_SIZE_BYTES} bytes (16GiB), got "${value}"`,
      "The cap is what bounds the download, the --lang-jar read and the ZIP reader's " +
        "total inflation, so it cannot be raised past the point where it stops being a number.",
    );
  }
  return bytes;
}

function boolValue(value: string, name: string): boolean {
  const lower = value.trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(lower)) return true;
  if (["false", "no", "0", "off"].includes(lower)) return false;
  throw usage(`${name} must be true or false, got "${value}"`);
}

/** Parse and fully validate argv. Never performs I/O. */
export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): CliOptions {
  const raw = tokenize(argv);

  if (raw.switches.has("--help") || raw.switches.has("-h") || argv.length === 0) {
    return { ...blank(), mode: "help" };
  }
  if (raw.switches.has("--version") || raw.switches.has("-v")) {
    return { ...blank(), mode: "version" };
  }

  if (raw.switches.has("--allow-partial")) {
    throw usage(
      "--allow-partial is not available in v1",
      {
        hint: "v1 output is atomic: no installable archive is written unless every " +
          "selected key validates. The work-in-progress cache is kept, so re-running " +
          "resumes rather than starting over.",
      }.hint,
    );
  }

  const url = single(raw, "--url", "-u");
  const archive = single(raw, "--archive");
  if (url && archive) {
    throw usage("--url and --archive are mutually exclusive", "Pass exactly one source.");
  }
  if (!url && !archive) {
    throw usage("--url is required (or --archive for a local pack file)");
  }

  const targetRaw = single(raw, "--target", "-t");
  if (!targetRaw) throw usage("--target is required, e.g. --target ja_jp");
  const target = resolveTargetLocale(targetRaw);

  const output = single(raw, "--output", "-o");
  if (!output) throw usage("--output is required, e.g. --output ./aca-ja.zip");

  const quiet = raw.switches.has("--quiet");
  const verbose = raw.switches.has("--verbose");
  if (quiet && verbose) throw usage("--quiet and --verbose cannot be combined");

  let overrideEnglish = raw.switches.has("--override-en-us");
  const overrideEnglishValue = single(raw, "--override-english");
  if (overrideEnglishValue !== undefined) {
    overrideEnglish = boolValue(overrideEnglishValue, "--override-english");
  }

  const qualityName = single(raw, "--quality");
  if (qualityName !== undefined && !(qualityName in QUALITY_PRESETS)) {
    throw usage(
      `--quality must be one of ${Object.keys(QUALITY_PRESETS).join(", ")}, got "${qualityName}"`,
    );
  }
  const preset = QUALITY_PRESETS[qualityName ?? "balanced"];

  const layout = (single(raw, "--layout") ?? "auto") as OverlayLayout;
  if (!LAYOUTS.includes(layout)) {
    throw usage(`--layout must be one of ${LAYOUTS.join(", ")}, got "${layout}"`);
  }

  const langJar = single(raw, "--lang-jar");
  const langNamespace = single(raw, "--lang-namespace");
  const packFormatRaw = single(raw, "--pack-format");
  for (
    const [flag, value] of [["--lang-namespace", langNamespace], ["--pack-format", packFormatRaw]]
  ) {
    if (value !== undefined && langJar === undefined) {
      throw usage(
        `${flag} only applies with --lang-jar`,
        "--lang-jar <mod.jar> selects resource-pack mode; without it the tool translates the " +
          "pack's own config/ftbquests/quests/lang/<locale>.snbt.",
      );
    }
  }
  if (langJar !== undefined && single(raw, "--layout") !== undefined) {
    throw usage(
      "--layout does not apply with --lang-jar",
      "A resource pack has exactly one layout: assets/<namespace>/lang/<locale>.json. " +
        "--layout only chooses where an FTB Quests SNBT overlay is placed.",
    );
  }
  const packFormat = packFormatRaw === undefined
    ? undefined
    : integer(raw, "--pack-format", 0, 1, 99);

  const provider = single(raw, "--provider") ?? "claude-code";
  if (!PROVIDERS.includes(provider)) {
    throw usage(`--provider must be one of ${PROVIDERS.join(", ")}, got "${provider}"`);
  }

  const maxCostRaw = single(raw, "--max-cost-usd");
  let maxCostUsd: number | undefined;
  if (maxCostRaw !== undefined) {
    maxCostUsd = Number(maxCostRaw);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      throw usage(`--max-cost-usd must be a positive number, got "${maxCostRaw}"`);
    }
  }

  const glossaryInline: Record<string, string> = {};
  for (const pair of raw.values.get("--glossary") ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw usage(`--glossary expects term=translation, got "${pair}"`);
    }
    glossaryInline[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  return {
    mode: "run",
    url,
    archive,
    target,
    output,
    overrideEnglish,
    sourceLocale: (single(raw, "--source-locale") ?? "en_us").toLowerCase().replace(/-/g, "_"),
    layout,
    langJar,
    langNamespace,
    packFormat,
    provider,
    model: single(raw, "--model") ?? preset.model,
    fallbackModel: single(raw, "--fallback-model") ?? preset.fallbackModel,
    effort: single(raw, "--effort") ?? "low",
    batchSize: integer(raw, "--batch-size", 40, 1, 500),
    batchChars: integer(raw, "--batch-chars", 6000, 100, 200_000),
    concurrency: integer(raw, "--concurrency", 2, 1, 8),
    retries: integer(raw, "--retries", 3, 0, 10),
    timeoutMs: integer(raw, "--timeout", 60, 1, 3600) * 1000,
    maxDownloadBytes: size(raw, "--max-download", 1024 * 1024 * 1024),
    maxCostUsd,
    cacheDir: single(raw, "--cache-dir"),
    cacheEnabled: !raw.switches.has("--no-cache"),
    previous: single(raw, "--previous"),
    glossaryFile: single(raw, "--glossary-file"),
    glossaryInline,
    emitRaw: raw.switches.has("--emit-raw"),
    force: raw.switches.has("--force"),
    dryRun: raw.switches.has("--dry-run"),
    allowPrerelease: raw.switches.has("--allow-prerelease"),
    curseForgeApiKey: single(raw, "--curseforge-api-key") ?? env.CURSEFORGE_API_KEY ??
      env.CF_API_KEY,
    json: raw.switches.has("--json"),
    quiet,
    verbose,
    color: !raw.switches.has("--no-color"),
  };
}

function blank(): CliOptions {
  return {
    mode: "help",
    target: resolveTargetLocale("en_us"),
    output: "",
    overrideEnglish: false,
    sourceLocale: "en_us",
    layout: "auto",
    provider: "claude-code",
    model: "haiku",
    fallbackModel: "sonnet",
    effort: "low",
    batchSize: 40,
    batchChars: 6000,
    concurrency: 2,
    retries: 3,
    timeoutMs: 60_000,
    maxDownloadBytes: 1024 * 1024 * 1024,
    cacheEnabled: true,
    glossaryInline: {},
    emitRaw: false,
    force: false,
    dryRun: false,
    allowPrerelease: false,
    json: false,
    quiet: false,
    verbose: false,
    color: true,
  };
}
