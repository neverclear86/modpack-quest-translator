/**
 * The window between "these output paths are free" and "these outputs are
 * written".
 *
 * `resolveOutputPlan` looks at five names before a single key is translated,
 * and then the run spends minutes translating. Everything these tests do
 * happens in that gap: a competitor -- another run, an editor, a sync client --
 * creates a file at one of the planned names, and the run must lose that race
 * rather than win it by overwriting.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { publishOutputs, resolveOutputPlan } from "../src/output/package.ts";
import type { ArtifactMeta } from "../src/output/types.ts";
import { run } from "../src/cli/run.ts";
import { buildLangJar, buildQuestPack } from "./helpers/lang_pack.ts";

const META: ArtifactMeta = {
  artifact: "snbt-overlay",
  toolVersion: "1.0.0",
  generatedAt: "2026-08-25T00:00:00.000Z",
  sourceUrl: "https://modrinth.com/modpack/rubius-cobblemon",
  packName: "Rubius Cobblemon",
  packVersion: "0.9",
  minecraftVersion: "1.21.1",
  loader: "neoforge",
  sourceArchiveSha256: "a".repeat(64),
  sourceLocale: "en_us",
  targetLocale: "ja_jp",
  targetLanguage: "Japanese",
  overrideEnglish: false,
  provider: "echo",
  model: "echo",
  fallbackModel: "echo",
  archiveFlavour: "modrinth",
  sourcePath: "overrides/config/ftbquests/quests/lang/en_us.snbt",
};

const COMPETITOR = "written by somebody else\n";

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "mqt-race-" });
}

/** Every output of a run, in the order the run publishes them. */
function outputs(base: string) {
  return [
    { path: `${base}.zip`, data: "archive bytes" },
    { path: `${base}.manifest.json`, data: "manifest" },
    { path: `${base}.report.json`, data: "report" },
    { path: `${base}.README.md`, data: "readme" },
  ];
}

async function entriesOf(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

// ---- the publishing primitive ----------------------------------------------

Deno.test("a file created after the plan is never overwritten by the archive", async () => {
  const dir = await tempDir();
  try {
    // Preflight passes: the directory is empty.
    const plan = await resolveOutputPlan(`${dir}/out.zip`, META);
    // ...and then, while the run translates, somebody else takes the name.
    await Deno.writeTextFile(plan.archivePath, COMPETITOR);

    const error = await assertRejects(
      () => publishOutputs(outputs(`${dir}/out`)),
      AppError,
    ) as AppError;
    assertEquals(error.code, "E_WRITE");
    assertStringIncludes(error.message, "out.zip");

    assertEquals(await Deno.readTextFile(plan.archivePath), COMPETITOR);
    // Nothing else was written either, and no temporary file was left behind.
    assertEquals(await entriesOf(dir), ["out.zip"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a sidecar race leaves earlier outputs rather than risking a stranger's file", async () => {
  const dir = await tempDir();
  try {
    await resolveOutputPlan(`${dir}/out.zip`, META);
    // The last of the four is the one that is taken, so the first three are
    // published before the run finds out.
    await Deno.writeTextFile(`${dir}/out.README.md`, COMPETITOR);

    const error = await assertRejects(
      () => publishOutputs(outputs(`${dir}/out`)),
      AppError,
    ) as AppError;
    assertEquals(error.code, "E_WRITE");
    assertStringIncludes(error.message, "out.README.md");

    assertEquals(await Deno.readTextFile(`${dir}/out.README.md`), COMPETITOR);
    // Conservative failure: already-published files remain. Removing them by
    // pathname would race with a competitor replacing one just before unlink.
    assertEquals(await entriesOf(dir), [
      "out.README.md",
      "out.manifest.json",
      "out.report.json",
      "out.zip",
    ]);
    assertStringIncludes(error.hint ?? "", "left in place");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--force is a deliberate replacement, race or no race", async () => {
  const dir = await tempDir();
  try {
    for (const file of outputs(`${dir}/out`)) {
      await Deno.writeTextFile(file.path, COMPETITOR);
    }
    await publishOutputs(outputs(`${dir}/out`), { force: true });
    assertEquals(await Deno.readTextFile(`${dir}/out.zip`), "archive bytes");
    assertEquals(await Deno.readTextFile(`${dir}/out.README.md`), "readme");
    assertEquals(await entriesOf(dir), [
      "out.README.md",
      "out.manifest.json",
      "out.report.json",
      "out.zip",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an uncontested publication writes every output and cleans up after itself", async () => {
  const dir = await tempDir();
  try {
    await publishOutputs([
      ...outputs(`${dir}/nested/out`),
      { path: `${dir}/nested/out.ja_jp.snbt`, data: new TextEncoder().encode("raw") },
    ]);
    assertEquals(await Deno.readTextFile(`${dir}/nested/out.zip`), "archive bytes");
    assertEquals(await Deno.readTextFile(`${dir}/nested/out.ja_jp.snbt`), "raw");
    assertEquals(await entriesOf(`${dir}/nested`), [
      "out.README.md",
      "out.ja_jp.snbt",
      "out.manifest.json",
      "out.report.json",
      "out.zip",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- end to end ------------------------------------------------------------

interface Harness {
  dir: string;
  cacheDir: string;
  pack: string;
  jar: string;
  stdout: string[];
  stderr: string[];
}

async function harness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-race-e2e-" });
  const cacheDir = await Deno.makeTempDir({ prefix: "mqt-race-cache-" });
  const pack = `${dir}/pack.zip`;
  const jar = `${dir}/ExampleTweaks_1.0.jar`;
  await Deno.writeFile(pack, await buildQuestPack());
  await Deno.writeFile(jar, await buildLangJar());
  try {
    await fn({ dir, cacheDir, pack, jar, stdout: [], stderr: [] });
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(cacheDir, { recursive: true });
  }
}

function args(h: Harness, extra: string[] = []): string[] {
  return [
    "--archive",
    h.pack,
    "--lang-jar",
    h.jar,
    "--target",
    "ja_jp",
    "--output",
    `${h.dir}/out.zip`,
    "--provider",
    "echo",
    "--cache-dir",
    h.cacheDir,
    "--json",
    ...extra,
  ];
}

/**
 * Run with a competitor that publishes into `contested` at the last possible
 * moment: the `validate` stage is the event immediately before packaging, so
 * the file appears long after the preflight and just before the run writes.
 */
function racingDeps(h: Harness, contested: readonly string[]) {
  return {
    stdout: (line: string) => {
      h.stdout.push(line);
      let event: { type?: string; stage?: string };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "stage" || event.stage !== "validate") return;
      for (const path of contested) Deno.writeTextFileSync(path, COMPETITOR);
    },
    stderr: (line: string) => h.stderr.push(line),
    now: () => new Date("2026-08-27T00:00:00.000Z"),
    env: {} as Record<string, string | undefined>,
    fetch: () => Promise.reject(new Error("the network must not be touched")),
  };
}

Deno.test("an archive that appears mid-run is left exactly as the competitor wrote it", async () => {
  await harness(async (h) => {
    const code = await run(args(h), racingDeps(h, [`${h.dir}/out.zip`]));
    assertEquals(code, 8, h.stderr.join("\n"));
    assertStringIncludes(h.stderr.join("\n"), "out.zip");

    assertEquals(await Deno.readTextFile(`${h.dir}/out.zip`), COMPETITOR);
    assertEquals(
      await entriesOf(h.dir),
      ["ExampleTweaks_1.0.jar", "out.zip", "pack.zip"],
    );
  });
});

Deno.test("a sidecar that appears mid-run costs the run its own outputs, not the competitor's", async () => {
  await harness(async (h) => {
    const contested = [`${h.dir}/out.README.md`, `${h.dir}/out.report.json`];
    const code = await run(args(h, ["--emit-raw"]), racingDeps(h, contested));
    assertEquals(code, 8, h.stderr.join("\n"));

    for (const path of contested) {
      assertEquals(await Deno.readTextFile(path), COMPETITOR, path);
    }
    // The archive and manifest were published before the report collision.
    // They remain intentionally: deleting by pathname could delete a file a
    // competitor swapped in after any identity check.
    assertEquals(
      await entriesOf(h.dir),
      [
        "ExampleTweaks_1.0.jar",
        "out.README.md",
        "out.manifest.json",
        "out.report.json",
        "out.zip",
        "pack.zip",
      ],
    );
  });
});

Deno.test("--force replaces a file that appears mid-run, which is what it is for", async () => {
  await harness(async (h) => {
    const code = await run(
      args(h, ["--force"]),
      racingDeps(h, [`${h.dir}/out.zip`, `${h.dir}/out.manifest.json`]),
    );
    assertEquals(code, 0, h.stderr.join("\n"));
    const zip = await Deno.readFile(`${h.dir}/out.zip`);
    assertEquals(zip.byteLength > COMPETITOR.length, true);
    assertStringIncludes(await Deno.readTextFile(`${h.dir}/out.manifest.json`), "resource-pack");
  });
});
