import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { readZip } from "../src/archive/zip/reader.ts";
import { writeZip } from "../src/archive/zip/writer.ts";
import { run } from "../src/cli/run.ts";
import {
  buildLangJar,
  buildQuestPack,
  englishLang,
  MISSING_KEY,
  REFERENCED_KEYS,
} from "./helpers/lang_pack.ts";

const PRESENT = REFERENCED_KEYS.filter((k) => k in englishLang());
const LANG_ENTRY = "assets/examplepack/lang/ja_jp.json";

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
  const dir = await Deno.makeTempDir({ prefix: "mqt-rp-e2e-" });
  const cacheDir = await Deno.makeTempDir({ prefix: "mqt-rp-cache-" });
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

Deno.test("a pack of placeholders plus a lang jar produces a resource pack", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(
      zip.files().map((f) => f.path).sort(),
      [
        "README.md",
        LANG_ENTRY,
        "pack.mcmeta",
        "translation-manifest.json",
        "translation-report.json",
      ].sort(),
    );

    const mcmeta = JSON.parse(await zip.readText("pack.mcmeta"));
    assertEquals(mcmeta.pack.pack_format, 15);

    const lang = JSON.parse(await zip.readText(LANG_ENTRY)) as Record<string, string>;
    assertEquals(new Set(Object.keys(lang)), new Set(PRESENT));
    assertStringIncludes(lang["quest.guide.survival.fiber.title"], "ja_jp");
  });
});

Deno.test("only referenced keys are translated; the rest of the mod is left alone", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    const text = await zip.readText(LANG_ENTRY);
    assertEquals(text.includes("unused.key.not.referenced"), false);
    assertEquals(text.includes("item.examplepack.plant_fiber"), false);
    assertEquals(text.includes(MISSING_KEY), false);
  });
});

Deno.test("formatting codes, escapes and printf tokens survive translation", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    const lang = JSON.parse(await zip.readText(LANG_ENTRY)) as Record<string, string>;
    assertStringIncludes(lang["quest.intro.hotkeys.subtitle"], "&6");
    assertStringIncludes(lang["quest.intro.hotkeys.subtitle"], "&r");
    assertStringIncludes(lang["quest.intro.hotkeys.description_2"], "%s");
    assertStringIncludes(lang["quest.guide.survival.fiber.subtitle"], "\\&");
    // An empty source value stays exactly empty.
    assertEquals(lang["quest.guide.survival.fiber.description_2"], "");
  });
});

Deno.test("the source english, the jar and the modpack never reach the output", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(zip.has("assets/examplepack/lang/en_us.json"), false);
    assertEquals(zip.files().some((f) => f.path.endsWith(".jar")), false);
    assertEquals(zip.files().some((f) => f.path.endsWith(".class")), false);
    assertEquals(zip.files().some((f) => f.path.startsWith("config/")), false);
    assertEquals(zip.files().some((f) => f.path === "manifest.json"), false);
    const lang = await zip.readText(LANG_ENTRY);
    // The English source strings are translated, not copied: no value is the
    // untouched source string. (The whole quoted value, so a provider that
    // prefixes still counts as having produced something.)
    assertEquals(lang.includes('"Fiber on Demand"'), false);
    assertEquals(lang.includes('"Beginners Guide to Modded Minecraft"'), false);
  });
});

Deno.test("missing keys and literal labels are reported and never guessed at", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/out.report.json`));
    assertEquals(report.limitations.missingKeys, [MISSING_KEY]);
    assertEquals(
      report.limitations.literalLabels.map((l: { text: string }) => l.text).sort(),
      ["Any #minecraft:wool", "WIP"],
    );
    assertEquals(report.limitations.referencedKeys, REFERENCED_KEYS.length);
    assertEquals(report.limitations.scannedQuestFiles, 3);
    assertEquals(report.limitations.unreadableQuestFiles, []);

    const readme = await Deno.readTextFile(`${h.dir}/out.README.md`);
    assertStringIncludes(readme, MISSING_KEY);
    assertStringIncludes(readme, "WIP");
  });
});

Deno.test("the manifest records the namespace and the jar it was read from", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const manifest = JSON.parse(await Deno.readTextFile(`${h.dir}/out.manifest.json`));
    assertEquals(manifest.artifact, "resource-pack");
    assertEquals(manifest.resourcePack.namespace, "examplepack");
    assertEquals(manifest.resourcePack.langPath, LANG_ENTRY);
    assertEquals(manifest.sourcePath, "assets/examplepack/lang/en_us.json");
    assertEquals(manifest.sourceLangJar.file, "ExampleTweaks_1.0.jar");
    assertEquals(manifest.sourceLangJar.sha256.length, 64);
    assertEquals(manifest.pack.minecraftVersion, "1.20.1");
  });
});

Deno.test("the jar path on disk is not written into any artefact", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    for (const file of ["out.manifest.json", "out.report.json", "out.README.md"]) {
      const text = await Deno.readTextFile(`${h.dir}/${file}`);
      assertEquals(text.includes(h.jar), false, file);
    }
  });
});

Deno.test("--override-en-us targets en_us.json and says what that means", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h, ["--override-en-us"]), deps(h)), 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(zip.has("assets/examplepack/lang/en_us.json"), true);
    assertEquals(zip.has(LANG_ENTRY), false);
    // It is the translation, not the pack's own English.
    const lang = JSON.parse(
      await zip.readText("assets/examplepack/lang/en_us.json"),
    ) as Record<string, string>;
    assertStringIncludes(lang["quest.guide.survival.fiber.title"], "ja_jp");
    const readme = await zip.readText("README.md");
    assertStringIncludes(readme, "fallback");
    assertStringIncludes(readme, "only the client that enables it");
  });
});

Deno.test("--emit-raw writes the payload as .json, not .snbt", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h, ["--emit-raw"]), deps(h)), 0, h.stderr.join("\n"));
    const raw = await Deno.readTextFile(`${h.dir}/out.ja_jp.json`);
    assertStringIncludes(raw, "[ja_jp]");
    await assertRejects(() => Deno.stat(`${h.dir}/out.ja_jp.snbt`));
  });
});

Deno.test("--dry-run reports discovery counts and writes nothing", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h, ["--dry-run", "--json"]), deps(h)), 0, h.stderr.join("\n"));
    const events = h.stdout.map((line) => JSON.parse(line));
    const dry = events.find((e) => e.type === "dry-run");
    assertEquals(dry.referenced, REFERENCED_KEYS.length);
    assertEquals(dry.strings, PRESENT.length);
    assertEquals(dry.missing, 1);
    assertEquals(dry.literals, 2);
    assertEquals(dry.entry, LANG_ENTRY);
    await assertRejects(() => Deno.stat(`${h.dir}/out.zip`));
  });
});

Deno.test("the stage sequence is the same in both modes", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h, ["--json"]), deps(h)), 0, h.stderr.join("\n"));
    const stages = h.stdout.map((l) => JSON.parse(l)).filter((e) => e.type === "stage").map((e) =>
      e.stage
    );
    assertEquals(stages, [
      "resolve",
      "download",
      "inspect",
      "parse",
      "translate",
      "validate",
      "package",
    ]);
  });
});

Deno.test("a second run is served from the cache, like the SNBT mode", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const second = { ...h, stdout: [], stderr: [] };
    assertEquals(
      await run(args(h, ["--output", `${h.dir}/again.zip`]), deps(second)),
      0,
      second.stderr.join("\n"),
    );
    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/again.report.json`));
    assertEquals(report.translated, 0);
    assertEquals(report.cached > 0, true);
  });
});

Deno.test("--previous diffs the referenced keys across runs", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const second = { ...h, stdout: [], stderr: [] };
    assertEquals(
      await run(
        args(h, ["--output", `${h.dir}/v2.zip`, "--previous", `${h.dir}/out.manifest.json`]),
        deps(second),
      ),
      0,
      second.stderr.join("\n"),
    );
    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/v2.report.json`));
    assertEquals(report.updateDiff.reused.length, PRESENT.length);
    assertEquals(report.updateDiff.added.length, 0);
  });
});

Deno.test("an ambiguous jar fails with an actionable error and no output", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 2);
    const message = h.stderr.join("\n");
    assertStringIncludes(message, "--lang-namespace");
    await assertRejects(() => Deno.stat(`${h.dir}/out.zip`));

    const second = { ...h, stdout: [], stderr: [] };
    assertEquals(await run(args(h, ["--lang-namespace", "alpha"]), deps(second)), 0);
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(zip.has("assets/alpha/lang/ja_jp.json"), true);
  }, {
    jar: await buildLangJar({
      namespaces: {
        alpha: { en_us: { "quest.intro": "A", "quest.main": "A" } },
        beta: { en_us: { "quest.guide": "B", "quest.intro.subtitle": "B" } },
      },
    }),
  });
});

Deno.test("a jar that backs none of the referenced keys exits 5", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 5);
    assertStringIncludes(h.stderr.join("\n"), "--lang-jar");
  }, {
    jar: await buildLangJar({ namespaces: { hordes: { en_us: { "message.hordes.Start": "x" } } } }),
  });
});

Deno.test("a missing lang jar is a usage error, not a crash", async () => {
  await harness(async (h) => {
    const code = await run(
      args(h, ["--lang-jar", `${h.dir}/no-such-file.jar`]).slice(0),
      deps(h),
    );
    assertEquals(code, 2);
    assertStringIncludes(h.stderr.join("\n"), "no-such-file.jar");
  });
});

Deno.test("--lang-namespace or --pack-format without --lang-jar is refused", async () => {
  await harness(async (h) => {
    const base = ["--archive", h.pack, "--target", "ja_jp", "--output", `${h.dir}/x.zip`];
    assertEquals(await run([...base, "--lang-namespace", "x"], deps(h)), 2);
    const second = { ...h, stdout: [], stderr: [] };
    assertEquals(await run([...base, "--pack-format", "15"], deps(second)), 2);
    assertStringIncludes(second.stderr.join("\n"), "--lang-jar");
  });
});

Deno.test("--layout is meaningless for a resource pack and is refused", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h, ["--layout", "overrides"]), deps(h)), 2);
    assertStringIncludes(h.stderr.join("\n"), "--layout");
  });
});

Deno.test("--pack-format overrides the version-derived default", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h, ["--pack-format", "34"]), deps(h)), 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(JSON.parse(await zip.readText("pack.mcmeta")).pack.pack_format, 34);
  });
});

Deno.test("a pack whose quests hold no placeholders exits 5 with a useful hint", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 5);
    assertStringIncludes(h.stderr.join("\n"), "placeholder");
  }, {
    pack: await writeZip([
      { path: "manifest.json", text: '{"name":"Plain","version":"1"}' },
      {
        path: "config/ftbquests/quests/chapters/plain.snbt",
        text: '{\n\tid: "AAAA000000000001"\n\ttitle: "Getting Started"\n}\n',
      },
    ]),
  });
});

Deno.test("an existing output is still refused unless forced", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const second = { ...h, stdout: [], stderr: [] };
    assertEquals(await run(args(h), deps(second)), 8);
    const third = { ...h, stdout: [], stderr: [] };
    assertEquals(await run(args(h, ["--force"]), deps(third)), 0);
  });
});

Deno.test("no secret from the environment leaks into the resource pack", async () => {
  await harness(async (h) => {
    const secret = "$2a$10$supersecretcurseforgekey";
    const code = await run(args(h, ["--emit-raw"]), {
      ...deps(h),
      env: { CURSEFORGE_API_KEY: secret, ANTHROPIC_API_KEY: "sk-ant-secret-value-x" },
    });
    assertEquals(code, 0, h.stderr.join("\n"));
    for (
      const file of ["out.zip", "out.manifest.json", "out.report.json", "out.README.md"]
    ) {
      const text = new TextDecoder().decode(await Deno.readFile(`${h.dir}/${file}`));
      assertEquals(text.includes("supersecretcurseforgekey"), false, file);
      assertEquals(text.includes("sk-ant-secret-value-x"), false, file);
    }
  });
});

Deno.test("without --lang-jar a pack of placeholders still takes the SNBT path", async () => {
  // Regression: mode selection is the flag, never a guess about the pack.
  await harness(async (h) => {
    const code = await run([
      "--archive",
      h.pack,
      "--target",
      "ja_jp",
      "--output",
      `${h.dir}/snbt.zip`,
      "--provider",
      "echo",
      "--cache-dir",
      h.cacheDir,
    ], deps(h));
    assertEquals(code, 5);
    const message = h.stderr.join("\n");
    assertStringIncludes(message, "lang/en_us.snbt");
    // ...and points at the mode that would work.
    assertStringIncludes(message, "--lang-jar");
  });
});

Deno.test("--lang-jar wins even when the pack also ships an SNBT lang file", async () => {
  await harness(async (h) => {
    assertEquals(await run(args(h), deps(h)), 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(zip.has(LANG_ENTRY), true);
    assertEquals(zip.has("config/ftbquests/quests/lang/ja_jp.snbt"), false);
  }, {
    pack: await buildQuestPack({
      snbtLang: '{\n\tquest.0000000000002329.title: "Welcome, Trainer!"\n}\n',
    }),
  });
});
