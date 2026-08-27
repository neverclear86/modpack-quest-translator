/**
 * End-to-end regressions for the bounds of resource-pack mode.
 *
 * Every case here is one the tool used to get *quietly* wrong: a limit that
 * silently truncated, a file that was silently dropped, a size cap that parsed
 * to Infinity, an overwrite that was only checked for one of the five files a
 * run writes. The assertion in each is the same shape -- either the run refuses
 * with something the user can act on, or it succeeds and says what it could not
 * cover. Never a partial answer presented as a whole one.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { readZip } from "../src/archive/zip/reader.ts";
import { run } from "../src/cli/run.ts";
import {
  breakEntryData,
  buildLangJar,
  buildQuestPack,
  englishLang,
  langJson,
  REFERENCED_KEYS,
} from "./helpers/lang_pack.ts";

const LANG_ENTRY = "assets/examplepack/lang/ja_jp.json";
const INTRO = "overrides/config/ftbquests/quests/chapters/intro.snbt";

interface Harness {
  dir: string;
  cacheDir: string;
  pack: string;
  jar: string;
  stdout: string[];
  stderr: string[];
}

async function harness(
  fn: (h: Harness) => Promise<void>,
  build: { pack?: Uint8Array; jar?: Uint8Array } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-rp-limits-" });
  const cacheDir = await Deno.makeTempDir({ prefix: "mqt-rp-limits-cache-" });
  const pack = `${dir}/pack.zip`;
  const jar = `${dir}/ExampleTweaks_1.0.jar`;
  await Deno.writeFile(pack, build.pack ?? await buildQuestPack());
  await Deno.writeFile(jar, build.jar ?? await buildLangJar());
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
    ...extra,
  ];
}

function deps(h: Harness) {
  return {
    stdout: (line: string) => h.stdout.push(line),
    stderr: (line: string) => h.stderr.push(line),
    now: () => new Date("2026-08-27T00:00:00.000Z"),
    env: {} as Record<string, string | undefined>,
    fetch: () => Promise.reject(new Error("the network must not be touched")),
  };
}

async function wroteNothing(h: Harness): Promise<void> {
  for (const name of ["out.zip", "out.manifest.json", "out.report.json", "out.README.md"]) {
    await assertRejects(() => Deno.stat(`${h.dir}/${name}`), Deno.errors.NotFound, "", name);
  }
}

// ---- 1. size parsing and the size that was actually read -------------------

Deno.test("a --max-download too large to be a number is refused, not believed", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h, ["--max-download", "9".repeat(400)]), deps(h)), 2);
    assertStringIncludes(h.stderr.join("\n"), "--max-download");
    await wroteNothing(h);
  });
});

function readsMoreThanItClaims(path: string, floor: number): boolean {
  try {
    return Deno.statSync(path).size === 0 && Deno.readFileSync(path).byteLength > floor;
  } catch {
    return false;
  }
}

Deno.test({
  name: "a lang jar that reads larger than it claimed is refused after the read",
  // `/proc/<pid>/maps` is a regular file that stats as zero bytes and reads far
  // more: the stat-versus-read gap, without a race to lose.
  ignore: Deno.build.os !== "linux" || !readsMoreThanItClaims("/proc/self/maps", 2000),
  fn: async () => {
    await harness(async (h) => {
      const code = await run(
        args(h, ["--lang-jar", "/proc/self/maps", "--max-download", "2000"]),
        deps(h),
      );
      assertEquals(code, 2, h.stderr.join("\n"));
      assertStringIncludes(h.stderr.join("\n"), "byte limit");
      await wroteNothing(h);
    });
  },
});

// ---- 2. a referenced key whose value is not a string -----------------------

Deno.test("a referenced key that is not a string fails the run, and is never guessed at", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 2, h.stderr.join("\n"));
    const message = h.stderr.join("\n");
    assertStringIncludes(message, "not strings");
    assertStringIncludes(message, "quest.intro");
    await wroteNothing(h);
  }, {
    jar: await buildLangJar({
      rawNamespaces: {
        examplepack: {
          en_us: JSON.stringify({ ...englishLang(), "quest.intro": ["a", "list"] }, null, 2),
        },
      },
    }),
  });
});

// ---- 3. the quest-file count cap -------------------------------------------

Deno.test("more quest files than the cap is an explicit failure, not a truncation", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 3);
    const message = h.stderr.join("\n");
    assertStringIncludes(message, "501");
    assertStringIncludes(message, "500");
    await wroteNothing(h);
  }, { pack: await buildQuestPack({ filler: 498 }) });
});

Deno.test("exactly the cap is still translated in full", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/out.report.json`));
    assertEquals(report.limitations.scannedQuestFiles, 500);
    assertEquals(report.limitations.referencedKeys, REFERENCED_KEYS.length);
  }, { pack: await buildQuestPack({ filler: 497 }) });
});

// ---- 4. a quest file that could not be read ---------------------------------

Deno.test("a quest entry that fails to read is reported, and coverage is not claimed", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/out.report.json`));
    assertEquals(report.limitations.unreadableQuestFiles, [INTRO]);
    // Two of the three quest files were actually scanned; the count says so.
    assertEquals(report.limitations.scannedQuestFiles, 2);
    assertEquals(report.limitations.referencedKeys < REFERENCED_KEYS.length, true);

    // The run names it on stdout; the README declares the gap and the report
    // carries the list, which is where every other full list lives too.
    assertStringIncludes(h.stdout.join("\n"), "did not parse");
    assertStringIncludes(h.stdout.join("\n"), INTRO);
    assertStringIncludes(
      await Deno.readTextFile(`${h.dir}/out.README.md`),
      "1 quest file(s) could not be parsed",
    );
  }, { pack: breakEntryData(await buildQuestPack(), INTRO) });
});

// ---- 5. more namespaces than the cap, plus --lang-namespace ----------------

function crowdedJar(withExamplePack: boolean): Record<string, Record<string, string>> {
  const raw: Record<string, Record<string, string>> = {};
  if (withExamplePack) raw.examplepack = { en_us: langJson() };
  for (let i = 0; i < 64; i++) raw[`filler${i}`] = { en_us: '{"unrelated.key":"x"}' };
  return raw;
}

Deno.test("a crowded jar is refused when auto-detecting, and accepted when told", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 2);
    assertStringIncludes(h.stderr.join("\n"), "--lang-namespace");
    await wroteNothing(h);

    // Regression: naming the one file to read used to be rejected by the very
    // limit it exists to answer.
    const second = { ...h, stdout: [], stderr: [] };
    assertEquals(
      await run(args(h, ["--lang-namespace", "examplepack"]), deps(second)),
      0,
      second.stderr.join("\n"),
    );
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(zip.has(LANG_ENTRY), true);
    const manifest = JSON.parse(await Deno.readTextFile(`${h.dir}/out.manifest.json`));
    assertEquals(manifest.resourcePack.namespace, "examplepack");
  }, { jar: await buildLangJar({ rawNamespaces: crowdedJar(true) }) });
});

Deno.test("a named namespace the crowded jar does not ship is still a clear error", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h, ["--lang-namespace", "examplepack"]), deps(h)), 2);
    assertStringIncludes(h.stderr.join("\n"), "examplepack");
    await wroteNothing(h);
  }, { jar: await buildLangJar({ rawNamespaces: crowdedJar(false) }) });
});

// ---- 6. lang files that are not usable language files ----------------------

Deno.test("a named namespace whose file is malformed says so, concretely", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h, ["--lang-namespace", "examplepack"]), deps(h)), 2);
    const message = h.stderr.join("\n");
    assertStringIncludes(message, "assets/examplepack/lang/en_us.json");
    assertStringIncludes(message, "not valid JSON");
    await wroteNothing(h);
  }, {
    jar: await buildLangJar({
      rawNamespaces: { examplepack: { en_us: '{"quest.intro": "unterminated' } },
    }),
  });
});

Deno.test("a jar of unusable lang files names them instead of reporting an absence", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 2);
    const message = h.stderr.join("\n");
    assertStringIncludes(message, "assets/alpha/lang/en_us.json");
    assertStringIncludes(message, "assets/beta/lang/en_us.json");
    assertStringIncludes(message, "assets/gamma/lang/en_us.json");
    await wroteNothing(h);
  }, {
    jar: await buildLangJar({
      rawNamespaces: {
        alpha: { en_us: "not json at all" },
        beta: { en_us: '["quest.intro"]' },
        gamma: { en_us: "{}" },
      },
    }),
  });
});

// ---- 7. every file the run will write -------------------------------------

Deno.test("a sidecar left over from an earlier run stops the run before it spends", async () => {
  for (
    const sidecar of ["out.manifest.json", "out.report.json", "out.README.md"]
  ) {
    await harness(async (h) => {
      await Deno.writeTextFile(`${h.dir}/${sidecar}`, "from an earlier run");
      assertEquals(await run(args(h), deps(h)), 8, sidecar);
      assertStringIncludes(h.stderr.join("\n"), sidecar);
      // Nothing else was written, and the survivor is untouched.
      await assertRejects(() => Deno.stat(`${h.dir}/out.zip`), Deno.errors.NotFound);
      assertEquals(await Deno.readTextFile(`${h.dir}/${sidecar}`), "from an earlier run");

      const forced = { ...h, stdout: [], stderr: [] };
      assertEquals(await run(args(h, ["--force"]), deps(forced)), 0, forced.stderr.join("\n"));
    });
  }
});

Deno.test("the raw payload path only collides when --emit-raw asks for it", async () => {
  await harness(async (h) => {
    await Deno.writeTextFile(`${h.dir}/out.ja_jp.json`, "from an earlier run");
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));

    const second = { ...h, stdout: [], stderr: [] };
    assertEquals(
      await run(args(h, ["--emit-raw", "--output", `${h.dir}/out.zip`, "--force"]), deps(second)),
      0,
      second.stderr.join("\n"),
    );

    const third = { ...h, stdout: [], stderr: [] };
    await Deno.writeTextFile(`${h.dir}/again.ja_jp.json`, "from an earlier run");
    assertEquals(
      await run(args(h, ["--emit-raw", "--output", `${h.dir}/again.zip`]), deps(third)),
      8,
    );
    assertStringIncludes(third.stderr.join("\n"), "again.ja_jp.json");
    await assertRejects(() => Deno.stat(`${h.dir}/again.zip`), Deno.errors.NotFound);
  });
});

Deno.test("--dry-run is not blocked by anything already on disk", async () => {
  await harness(async (h) => {
    for (const name of ["out.zip", "out.manifest.json", "out.report.json", "out.README.md"]) {
      await Deno.writeTextFile(`${h.dir}/${name}`, "from an earlier run");
    }
    assertEquals(await run(args(h, ["--dry-run"]), deps(h)), 0, h.stderr.join("\n"));
    assertEquals(await Deno.readTextFile(`${h.dir}/out.zip`), "from an earlier run");
  });
});
