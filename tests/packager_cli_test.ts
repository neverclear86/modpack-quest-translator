import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { readZip } from "../src/archive/zip/reader.ts";
import { buildOverlay } from "../src/output/package.ts";
import type { OverlayMeta } from "../src/output/types.ts";
import { createDefaultRedactor } from "../src/util/redact.ts";
import { digestByKey } from "../src/quests/digest.ts";
import { ftbQuestsLangAdapter } from "../src/quests/ftbquests_lang.ts";
import { finishedRun } from "./helpers/translation_report.ts";
import { parsePackagerArgs } from "../src/packager/args.ts";
import { runPackager } from "../src/packager/run.ts";

const JAPANESE = '{\n  quest.title: "空の冒険"\n}\n';
/** What the run read; its per-key digests prove the payload is not it. */
const ENGLISH = '{\n  quest.title: "Skyward Adventure"\n}\n';

function refuses(argv: string[], needle: string): void {
  const error = assertThrows(() => parsePackagerArgs(argv), AppError);
  assertEquals(error.code, "E_INVALID_INPUT");
  assertStringIncludes(error.message, needle);
}

Deno.test("the packager needs an overlay and an output", () => {
  // No arguments at all is a request for help, not a failure.
  refuses(["--json"], "--overlay");
  refuses(["--overlay", "a.zip"], "--output");
  const options = parsePackagerArgs(["--overlay", "a.zip", "--output", "b.zip"]);
  assertEquals(options.overlay, "a.zip");
  assertEquals(options.output, "b.zip");
  assertEquals(options.noBinaries, false);
});

Deno.test("binaries come from a directory or from explicit paths", () => {
  const fromDir = parsePackagerArgs([
    "--overlay",
    "a.zip",
    "--output",
    "b.zip",
    "--binaries",
    "dist/bin",
  ]);
  assertEquals(fromDir.binariesDir, "dist/bin");

  const explicit = parsePackagerArgs([
    "--overlay",
    "a.zip",
    "--output",
    "b.zip",
    "--linux-binary",
    "/l",
    "--windows-binary",
    "/w",
  ]);
  assertEquals(explicit.linuxBinary, "/l");
  assertEquals(explicit.windowsBinary, "/w");
});

Deno.test("--no-binaries and an explicit binary contradict each other", () => {
  refuses(
    ["--overlay", "a.zip", "--output", "b.zip", "--no-binaries", "--linux-binary", "/l"],
    "--no-binaries",
  );
});

Deno.test("unknown flags and stray positionals are refused", () => {
  refuses(["--overlay", "a.zip", "--output", "b.zip", "--wat"], "--wat");
  refuses(["a.zip"], "a.zip");
});

Deno.test("--help and --version short-circuit", () => {
  assertEquals(parsePackagerArgs(["--help"]).mode, "help");
  assertEquals(parsePackagerArgs([]).mode, "help");
  assertEquals(parsePackagerArgs(["--version"]).mode, "version");
});

interface Harness {
  dir: string;
  overlay: string;
  binaries: string;
  stdout: string[];
  stderr: string[];
}

async function harness(): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-package-" });
  const meta: OverlayMeta = {
    toolVersion: "1.1.0",
    generatedAt: "2026-08-25T00:00:00.000Z",
    sourceUrl: "https://example.invalid/aca.zip",
    packName: "All of Create: Aeronautics",
    packVersion: "2.4",
    sourceArchiveSha256: "d".repeat(64),
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    overrideEnglish: true,
    provider: "echo",
    model: "haiku",
    fallbackModel: "sonnet",
    archiveFlavour: "curseforge",
    sourcePath: "overrides/config/ftbquests/quests/lang/en_us.snbt",
    keyCounts: { keys: 1, strings: 1, translated: 1, cached: 0, skipped: 0, fallback: 0 },
    sourceKeyDigests: digestByKey(ftbQuestsLangAdapter.extract(ENGLISH).units),
  };
  const overlay = `${dir}/aca-2.4-ja_jp-en_us-override.zip`;
  await Deno.writeFile(
    overlay,
    await buildOverlay({
      translatedSnbt: JAPANESE,
      meta,
      report: finishedRun(),
      layout: "instance",
      redactor: createDefaultRedactor(),
    }),
  );

  const binaries = `${dir}/bin`;
  await Deno.mkdir(binaries);
  await Deno.writeFile(
    `${binaries}/mqt-installer-linux-x86_64`,
    new TextEncoder().encode("\x7fELF fake"),
  );
  await Deno.writeFile(
    `${binaries}/mqt-installer-windows-x86_64.exe`,
    new TextEncoder().encode("MZ fake"),
  );
  return { dir, overlay, binaries, stdout: [], stderr: [] };
}

async function invoke(h: Harness, argv: string[]): Promise<number> {
  return await runPackager(argv, {
    stdout: (line) => h.stdout.push(line),
    stderr: (line) => h.stderr.push(line),
  });
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await harness();
  try {
    await fn(h);
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
}

Deno.test("the packager writes a bundle named after the overlay", async () => {
  await withHarness(async (h) => {
    const output = `${h.dir}/out`;
    const code = await invoke(h, [
      "--overlay",
      h.overlay,
      "--output",
      output,
      "--binaries",
      h.binaries,
    ]);
    assertEquals(code, 0);
    const written = `${output}/aca-2.4-ja_jp-en_us-override-installer.zip`;
    const archive = await readZip(await Deno.readFile(written));
    assert(
      archive.has("aca-2.4-ja_jp-en_us-override/bin/mqt-installer-linux-x86_64"),
      "the Linux binary should be bundled",
    );
    assertStringIncludes(h.stdout.join("\n"), written);
  });
});

Deno.test("packaging twice produces the same bytes and refuses to overwrite", async () => {
  await withHarness(async (h) => {
    const output = `${h.dir}/aca-installer.zip`;
    assertEquals(
      await invoke(h, ["--overlay", h.overlay, "--output", output, "--binaries", h.binaries]),
      0,
    );
    const first = await Deno.readFile(output);

    const second = await invoke(h, [
      "--overlay",
      h.overlay,
      "--output",
      output,
      "--binaries",
      h.binaries,
    ]);
    assertEquals(second, 8);
    assertStringIncludes(h.stderr.join("\n"), "--force");

    assertEquals(
      await invoke(h, [
        "--overlay",
        h.overlay,
        "--output",
        output,
        "--binaries",
        h.binaries,
        "--force",
      ]),
      0,
    );
    assertEquals(await Deno.readFile(output), first);
  });
});

Deno.test("a missing binary is an error, and --no-binaries is the way to opt out", async () => {
  await withHarness(async (h) => {
    await Deno.remove(`${h.binaries}/mqt-installer-windows-x86_64.exe`);
    const code = await invoke(h, [
      "--overlay",
      h.overlay,
      "--output",
      `${h.dir}/a.zip`,
      "--binaries",
      h.binaries,
    ]);
    assertEquals(code, 2);
    assertStringIncludes(h.stderr.join("\n"), "mqt-installer-windows-x86_64.exe");

    assertEquals(
      await invoke(h, ["--overlay", h.overlay, "--output", `${h.dir}/b.zip`, "--no-binaries"]),
      0,
    );
  });
});

Deno.test("--json reports the bundle it built", async () => {
  await withHarness(async (h) => {
    const output = `${h.dir}/c.zip`;
    const code = await invoke(h, [
      "--overlay",
      h.overlay,
      "--output",
      output,
      "--binaries",
      h.binaries,
      "--json",
    ]);
    assertEquals(code, 0);
    const body = JSON.parse(h.stdout.join("\n"));
    assertEquals(body.ok, true);
    assertEquals(body.bundleId, "aca-2.4-ja_jp-en_us-override");
    assertEquals(body.output, output);
    assertEquals(body.payload[0].path, "config/ftbquests/quests/lang/en_us.snbt");
    assertEquals(typeof body.sha256, "string");
  });
});

Deno.test("--bundle-id overrides the name derived from the overlay", async () => {
  await withHarness(async (h) => {
    const output = `${h.dir}/d.zip`;
    await invoke(h, [
      "--overlay",
      h.overlay,
      "--output",
      output,
      "--no-binaries",
      "--bundle-id",
      "aca-ja",
    ]);
    const archive = await readZip(await Deno.readFile(output));
    assert(archive.has("aca-ja/bundle-manifest.json"));
  });
});

Deno.test("a --bundle-id that is not a plain name is refused with a usable message", async () => {
  // It becomes the bundle's top-level directory and the id the installer writes
  // into state.json, so it is checked here rather than left to surface as a ZIP
  // writer complaint about an unsafe entry path.
  await withHarness(async (h) => {
    for (const id of ["../evil", "aca ja", "aca\nInstalled", ""]) {
      const code = await invoke(h, [
        "--overlay",
        h.overlay,
        "--output",
        `${h.dir}/id-${encodeURIComponent(id)}.zip`,
        "--no-binaries",
        "--bundle-id",
        id,
      ]);
      assertEquals(code, 10, `expected --bundle-id ${JSON.stringify(id)} to be refused`);
      assertStringIncludes(h.stderr.join("\n"), "--bundle-id");
    }
  });
});

Deno.test("a missing overlay file is reported, not thrown as a stack trace", async () => {
  await withHarness(async (h) => {
    const code = await invoke(h, [
      "--overlay",
      `${h.dir}/nope.zip`,
      "--output",
      `${h.dir}/e.zip`,
      "--no-binaries",
    ]);
    assertEquals(code, 2);
    assertStringIncludes(h.stderr.join("\n"), "nope.zip");
  });
});
