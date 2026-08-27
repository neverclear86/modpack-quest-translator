import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { readZip } from "../src/archive/zip/reader.ts";
import { buildArtifact } from "../src/output/package.ts";
import type { OverlayMeta } from "../src/output/types.ts";
import { createDefaultRedactor } from "../src/util/redact.ts";
import { digestByKey } from "../src/quests/digest.ts";
import { ftbQuestsLangAdapter } from "../src/quests/ftbquests_lang.ts";
import { finishedRun } from "./helpers/translation_report.ts";
import { parsePackagerArgs } from "../src/packager/args.ts";
import { runPackager } from "../src/packager/run.ts";
import { sourceArchiveOf } from "./helpers/source_archive.ts";

const JAPANESE = '{\n  quest.title: "空の冒険"\n}\n';
/** What the run read; its per-key digests prove the payload is not it. */
const ENGLISH = '{\n  quest.title: "Skyward Adventure"\n}\n';

/** The three flags every packaging run has to carry. */
const REQUIRED = ["--overlay", "a.zip", "--output", "b.zip", "--source-archive", "pack.zip"];

function refuses(argv: string[], needle: string): void {
  const error = assertThrows(() => parsePackagerArgs(argv), AppError);
  assertEquals(error.code, "E_INVALID_INPUT");
  assertStringIncludes(error.message, needle);
}

Deno.test("the packager needs an overlay, a source archive and an output", () => {
  // No arguments at all is a request for help, not a failure.
  refuses(["--json"], "--overlay");
  refuses(["--overlay", "a.zip"], "--output");
  // Without the archive the run read, the only account of what the source said
  // is the manifest sitting next to the payload, which proves nothing.
  refuses(["--overlay", "a.zip", "--output", "b.zip"], "--source-archive");
  const options = parsePackagerArgs(REQUIRED);
  assertEquals(options.overlay, "a.zip");
  assertEquals(options.output, "b.zip");
  assertEquals(options.sourceArchive, "pack.zip");
  assertEquals(options.noBinaries, false);
});

Deno.test("binaries come from a directory or from explicit paths", () => {
  const fromDir = parsePackagerArgs([...REQUIRED, "--binaries", "dist/bin"]);
  assertEquals(fromDir.binariesDir, "dist/bin");

  const explicit = parsePackagerArgs([
    ...REQUIRED,
    "--linux-binary",
    "/l",
    "--windows-binary",
    "/w",
  ]);
  assertEquals(explicit.linuxBinary, "/l");
  assertEquals(explicit.windowsBinary, "/w");
});

Deno.test("--no-binaries and an explicit binary contradict each other", () => {
  refuses([...REQUIRED, "--no-binaries", "--linux-binary", "/l"], "--no-binaries");
});

Deno.test("unknown flags and stray positionals are refused", () => {
  refuses([...REQUIRED, "--wat"], "--wat");
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
  /** The modpack archive the run read, on disk. */
  sourceArchive: string;
  binaries: string;
  stdout: string[];
  stderr: string[];
}

async function harness(): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-package-" });
  const source = await sourceArchiveOf(ENGLISH);
  const sourceArchive = `${dir}/aca-v2.4.zip`;
  await Deno.writeFile(sourceArchive, source.bytes);
  const meta: OverlayMeta = {
    artifact: "snbt-overlay",
    toolVersion: "1.1.0",
    generatedAt: "2026-08-25T00:00:00.000Z",
    sourceUrl: "https://example.invalid/aca.zip",
    packName: "All of Create: Aeronautics",
    packVersion: "2.4",
    sourceArchiveSha256: source.sha256,
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    overrideEnglish: true,
    provider: "echo",
    model: "haiku",
    fallbackModel: "sonnet",
    archiveFlavour: "curseforge",
    sourcePath: source.path,
    keyCounts: { keys: 1, strings: 1, translated: 1, cached: 0, skipped: 0, fallback: 0 },
    sourceKeyDigests: digestByKey(ftbQuestsLangAdapter.extract(ENGLISH).units),
  };
  const overlay = `${dir}/aca-2.4-ja_jp-en_us-override.zip`;
  await Deno.writeFile(
    overlay,
    await buildArtifact({
      payload: JAPANESE,
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
  return { dir, overlay, sourceArchive, binaries, stdout: [], stderr: [] };
}

/** Adds the source archive, which every packaging run needs and none varies. */
async function invoke(h: Harness, argv: string[]): Promise<number> {
  const full = argv.includes("--source-archive")
    ? argv
    : [...argv, "--source-archive", h.sourceArchive];
  return await runPackager(full, {
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
    // "." and ".." carry no separator, so a plain character-class check lets
    // them through and the run dies as an unsafe-entry-path complaint from the
    // ZIP writer -- the exact message this check exists to replace.
    for (const id of ["../evil", "aca ja", "aca\nInstalled", "", ".", "..", "..."]) {
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

Deno.test("a source archive that is not the one the run read is refused at the CLI", async () => {
  await withHarness(async (h) => {
    const other = `${h.dir}/some-other-pack.zip`;
    await Deno.writeFile(other, (await sourceArchiveOf(`${ENGLISH}// v2.5\n`)).bytes);

    const code = await invoke(h, [
      "--overlay",
      h.overlay,
      "--output",
      `${h.dir}/out.zip`,
      "--no-binaries",
      "--source-archive",
      other,
    ]);
    assertEquals(code, 10);
    assertStringIncludes(h.stderr.join("\n"), "was made from");
    assertEquals(await exists(`${h.dir}/out.zip`), false);
  });
});

Deno.test("a source archive that is not there at all is an input error", async () => {
  await withHarness(async (h) => {
    const code = await invoke(h, [
      "--overlay",
      h.overlay,
      "--output",
      `${h.dir}/out.zip`,
      "--no-binaries",
      "--source-archive",
      `${h.dir}/nowhere.zip`,
    ]);
    assertEquals(code, 2);
    assertStringIncludes(h.stderr.join("\n"), "--source-archive");
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
