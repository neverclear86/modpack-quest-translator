import { assertEquals, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { parseArgs } from "../src/cli/args.ts";

const MIN = ["--url", "https://modrinth.com/modpack/x", "--target", "ja_jp", "--output", "./out"];

Deno.test("the four required inputs are parsed", () => {
  const options = parseArgs(MIN);
  assertEquals(options.url, "https://modrinth.com/modpack/x");
  assertEquals(options.target.locale, "ja_jp");
  assertEquals(options.output, "./out");
  assertEquals(options.overrideEnglish, false);
});

Deno.test("short aliases work", () => {
  const options = parseArgs(["-u", "https://modrinth.com/modpack/x", "-t", "ja", "-o", "./out"]);
  assertEquals(options.target.locale, "ja_jp");
  assertEquals(options.output, "./out");
});

Deno.test("--override-en-us is a boolean flag", () => {
  assertEquals(parseArgs([...MIN, "--override-en-us"]).overrideEnglish, true);
});

Deno.test("--override-english takes the literal true/false spelling from the requirements", () => {
  assertEquals(parseArgs([...MIN, "--override-english", "true"]).overrideEnglish, true);
  assertEquals(parseArgs([...MIN, "--override-english", "false"]).overrideEnglish, false);
  assertEquals(parseArgs([...MIN, "--override-english=true"]).overrideEnglish, true);
  assertThrows(() => parseArgs([...MIN, "--override-english", "maybe"]), AppError);
});

Deno.test("--url and --archive are mutually exclusive and one is required", () => {
  assertThrows(() => parseArgs(["--target", "ja_jp", "--output", "./out"]), AppError);
  assertThrows(
    () => parseArgs([...MIN, "--archive", "./pack.zip"]),
    AppError,
  );
  const local = parseArgs(["--archive", "./pack.zip", "--target", "ja_jp", "--output", "./out"]);
  assertEquals(local.archive, "./pack.zip");
  assertEquals(local.url, undefined);
});

Deno.test("--target and --output are required", () => {
  assertThrows(
    () => parseArgs(["--url", "https://modrinth.com/modpack/x", "--output", "./o"]),
    AppError,
  );
  assertThrows(
    () => parseArgs(["--url", "https://modrinth.com/modpack/x", "--target", "ja"]),
    AppError,
  );
});

Deno.test("an unknown flag is a usage error rather than silently ignored", () => {
  const err = assertThrows(() => parseArgs([...MIN, "--turbo"]), AppError) as AppError;
  assertEquals(err.code, "E_INVALID_INPUT");
  assertEquals(String(err.message).includes("--turbo"), true);
});

Deno.test("a flag missing its value is a usage error", () => {
  assertThrows(() => parseArgs(["--url"]), AppError);
  assertThrows(() => parseArgs([...MIN, "--model"]), AppError);
});

Deno.test("defaults match the documented model policy", () => {
  const options = parseArgs(MIN);
  assertEquals(options.provider, "claude-code");
  assertEquals(options.model, "haiku");
  assertEquals(options.fallbackModel, "sonnet");
  assertEquals(options.effort, "low");
  assertEquals(options.sourceLocale, "en_us");
  assertEquals(options.layout, "auto");
  assertEquals(options.batchSize, 40);
  assertEquals(options.batchChars, 6000);
  assertEquals(options.concurrency, 2);
  assertEquals(options.retries, 3);
});

Deno.test("quality presets override the model pair", () => {
  const fast = parseArgs([...MIN, "--quality", "fast"]);
  assertEquals([fast.model, fast.fallbackModel], ["haiku", "haiku"]);
  const best = parseArgs([...MIN, "--quality", "best"]);
  assertEquals([best.model, best.fallbackModel], ["sonnet", "opus"]);
  const balanced = parseArgs([...MIN, "--quality", "balanced"]);
  assertEquals([balanced.model, balanced.fallbackModel], ["haiku", "sonnet"]);
  assertThrows(() => parseArgs([...MIN, "--quality", "turbo"]), AppError);
});

Deno.test("an explicit --model wins over the preset", () => {
  const options = parseArgs([...MIN, "--quality", "fast", "--model", "opus"]);
  assertEquals(options.model, "opus");
  assertEquals(options.fallbackModel, "haiku");
});

Deno.test("numeric flags are validated and bounded", () => {
  assertEquals(parseArgs([...MIN, "--concurrency", "4"]).concurrency, 4);
  assertThrows(() => parseArgs([...MIN, "--concurrency", "0"]), AppError);
  assertThrows(() => parseArgs([...MIN, "--concurrency", "99"]), AppError);
  assertThrows(() => parseArgs([...MIN, "--concurrency", "abc"]), AppError);
  assertThrows(() => parseArgs([...MIN, "--batch-size", "-1"]), AppError);
  assertThrows(() => parseArgs([...MIN, "--retries", "1000"]), AppError);
});

Deno.test("--max-download accepts human sizes", () => {
  assertEquals(parseArgs([...MIN, "--max-download", "512MiB"]).maxDownloadBytes, 512 * 1024 * 1024);
  assertEquals(parseArgs([...MIN, "--max-download", "2GB"]).maxDownloadBytes, 2_000_000_000);
  assertEquals(parseArgs([...MIN, "--max-download", "1048576"]).maxDownloadBytes, 1048576);
  assertThrows(() => parseArgs([...MIN, "--max-download", "big"]), AppError);
});

Deno.test("--max-download is finite and bounded", () => {
  // Regression: a digit string long enough to overflow a double parsed as
  // Infinity, which passed `> 0` and then disabled every size limit derived
  // from it -- including the ZIP reader's total-inflation cap.
  for (
    const value of ["9".repeat(400), "1e309", `${Number.MAX_SAFE_INTEGER}`, "1000GB", "17179869185"]
  ) {
    const error = assertThrows(
      () => parseArgs([...MIN, "--max-download", value]),
      AppError,
    ) as AppError;
    assertEquals(error.code, "E_INVALID_INPUT", value);
  }
  const largest = parseArgs([...MIN, "--max-download", "16GiB"]).maxDownloadBytes;
  assertEquals(largest, 16 * 1024 ** 3);
  assertEquals(Number.isSafeInteger(largest * 4), true);
});

Deno.test("--layout is validated", () => {
  assertEquals(parseArgs([...MIN, "--layout", "overrides"]).layout, "overrides");
  assertThrows(() => parseArgs([...MIN, "--layout", "sideways"]), AppError);
});

Deno.test("boolean switches parse", () => {
  const options = parseArgs([
    ...MIN,
    "--dry-run",
    "--emit-raw",
    "--force",
    "--json",
    "--no-cache",
    "--allow-prerelease",
  ]);
  assertEquals(options.dryRun, true);
  assertEquals(options.emitRaw, true);
  assertEquals(options.force, true);
  assertEquals(options.json, true);
  assertEquals(options.cacheEnabled, false);
  assertEquals(options.allowPrerelease, true);
});

Deno.test("--quiet and --verbose are mutually exclusive", () => {
  assertThrows(() => parseArgs([...MIN, "--quiet", "--verbose"]), AppError);
});

Deno.test("--allow-partial is rejected in v1 with an explanation", () => {
  const err = assertThrows(() => parseArgs([...MIN, "--allow-partial"]), AppError) as AppError;
  assertEquals(String(err.hint).includes("atomic"), true);
});

Deno.test("--help and --version short circuit", () => {
  assertEquals(parseArgs(["--help"]).mode, "help");
  assertEquals(parseArgs(["-h"]).mode, "help");
  assertEquals(parseArgs(["--version"]).mode, "version");
  assertEquals(parseArgs(["-v"]).mode, "version");
  assertEquals(parseArgs([]).mode, "help");
  assertEquals(parseArgs(MIN).mode, "run");
});

Deno.test("the curseforge api key comes from a flag or the environment", () => {
  assertEquals(
    parseArgs([...MIN, "--curseforge-api-key", "$2a$10$k"]).curseForgeApiKey,
    "$2a$10$k",
  );
  assertEquals(
    parseArgs(MIN, { CURSEFORGE_API_KEY: "$2a$10$envkey" }).curseForgeApiKey,
    "$2a$10$envkey",
  );
  assertEquals(
    parseArgs([...MIN, "--curseforge-api-key", "$2a$10$flag"], { CURSEFORGE_API_KEY: "$2a$10$env" })
      .curseForgeApiKey,
    "$2a$10$flag",
  );
});

Deno.test("--glossary accepts inline pairs and repeats", () => {
  const options = parseArgs([...MIN, "--glossary", "Create=Create", "--glossary", "Ponder=Ponder"]);
  assertEquals(options.glossaryInline, { Create: "Create", Ponder: "Ponder" });
  assertThrows(() => parseArgs([...MIN, "--glossary", "novalue"]), AppError);
});

Deno.test("an equals-form flag value is accepted", () => {
  assertEquals(
    parseArgs(["--url=https://modrinth.com/modpack/x", "--target=ja", "--output=./o"]).output,
    "./o",
  );
});

Deno.test("a bare -- stops flag parsing", () => {
  const err = assertThrows(() => parseArgs([...MIN, "--", "--not-a-flag"]), AppError) as AppError;
  assertEquals(String(err.message).includes("positional"), true);
});

Deno.test("target resolution happens during parsing so errors surface early", () => {
  const err = assertThrows(
    () =>
      parseArgs([
        "--url",
        "https://modrinth.com/modpack/x",
        "--target",
        "Klingon",
        "--output",
        "./o",
      ]),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_INVALID_INPUT");
});
