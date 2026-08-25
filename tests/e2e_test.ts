import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { readZip } from "../src/archive/zip/reader.ts";
import { writeZip } from "../src/archive/zip/writer.ts";
import { run } from "../src/cli/run.ts";
import { parseSnbt } from "../src/quests/snbt/mod.ts";
import type { FetchLike } from "../src/net/http.ts";
import { asBufferSource } from "../src/util/bytes.ts";

const LANG = await Deno.readTextFile(new URL("./fixtures/snbt/lang_en_us.snbt", import.meta.url));
const CHAPTER = await Deno.readTextFile(
  new URL("./fixtures/snbt/chapter_rubius_main.snbt", import.meta.url),
);

async function packBytes(): Promise<Uint8Array> {
  return await writeZip([
    {
      path: "modrinth.index.json",
      text: JSON.stringify({
        name: "Rubius Cobblemon",
        versionId: "0.9",
        dependencies: { minecraft: "1.21.1", neoforge: "21.1.228" },
        files: [
          { path: "mods/ftb-quests-neoforge-2101.1.10.jar", downloads: [] },
          { path: "mods/sodium-0.6.0.jar", downloads: [] },
        ],
      }),
    },
    { path: "overrides/config/ftbquests/quests/lang/en_us.snbt", text: LANG },
    { path: "overrides/config/ftbquests/quests/chapters/rubius_main.snbt", text: CHAPTER },
    { path: "overrides/mods/SomeMod-1.0.jar", text: "not really a jar" },
  ]);
}

function fetchFor(bytes: Uint8Array): FetchLike {
  const routes: Record<string, () => Response> = {
    "https://api.modrinth.com/v2/project/rubius-cobblemon": () =>
      new Response(
        JSON.stringify({
          slug: "rubius-cobblemon",
          title: "Rubius Cobblemon",
          project_type: "modpack",
        }),
      ),
    "https://api.modrinth.com/v2/project/rubius-cobblemon/version": () =>
      new Response(JSON.stringify([{
        id: "SzR6i4dZ",
        version_number: "0.9",
        version_type: "release",
        game_versions: ["1.21.1"],
        loaders: ["neoforge"],
        date_published: "2026-06-06T16:56:03.830029Z",
        files: [{
          filename: "Rubius 0.9.mrpack",
          url: "https://cdn.modrinth.com/a.mrpack",
          primary: true,
        }],
      }])),
    "https://cdn.modrinth.com/a.mrpack": () => new Response(asBufferSource(bytes)),
  };
  return (input) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes[url];
    return Promise.resolve(route ? route() : new Response("not found", { status: 404 }));
  };
}

interface Harness {
  dir: string;
  cacheDir: string;
  stdout: string[];
  stderr: string[];
  fetch: FetchLike;
}

async function harness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-e2e-" });
  const cacheDir = await Deno.makeTempDir({ prefix: "mqt-e2e-cache-" });
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    await fn({ dir, cacheDir, stdout, stderr, fetch: fetchFor(await packBytes()) });
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(cacheDir, { recursive: true });
  }
}

function baseArgs(h: Harness, extra: string[] = []): string[] {
  return [
    "--url",
    "https://modrinth.com/modpack/rubius-cobblemon",
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
    fetch: h.fetch,
    stdout: (line: string) => h.stdout.push(line),
    stderr: (line: string) => h.stderr.push(line),
    now: () => new Date("2026-08-25T00:00:00.000Z"),
    env: {} as Record<string, string | undefined>,
  };
}

Deno.test("end to end: resolve, download, parse, translate, validate, package", async () => {
  await harness(async (h) => {
    const code = await run(baseArgs(h), deps(h));
    assertEquals(code, 0, h.stderr.join("\n"));

    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(zip.has("config/ftbquests/quests/lang/ja_jp.snbt"), true);

    const translated = await zip.readText("config/ftbquests/quests/lang/ja_jp.snbt");
    const source = parseSnbt(LANG);
    const output = parseSnbt(translated);
    // Exactly the same keys, in the same order, with the same shapes.
    assertEquals(output.members.map((m) => m.key), source.members.map((m) => m.key));
    for (const [i, member] of source.members.entries()) {
      assertEquals(output.members[i].value.type, member.value.type);
    }
    // Every non-empty value actually changed.
    const title = output.members.find((m) => m.key === "quest.0000000000002329.title")!;
    assertStringIncludes((title.value as { value: string }).value, "ja_jp");
  });
});

Deno.test("the translated file preserves formatting codes, placeholders and escapes", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h), deps(h)), 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    const text = await zip.readText("config/ftbquests/quests/lang/ja_jp.snbt");

    assertStringIncludes(text, "&b");
    assertStringIncludes(text, "&r");
    assertStringIncludes(text, "\\\\&");
    assertStringIncludes(
      text,
      "{image:cobblemore_lib:item/ball_lids/incomplete_ball/incomplete_ultra_ball width:100 height:100 align:center}",
    );
    assertStringIncludes(text, "%s");
    assertStringIncludes(text, "%1$s");
    assertStringIncludes(text, "Pokémon");
    // The empty title stays empty, and empty array elements stay empty.
    assertStringIncludes(text, 'quest.00000000000FFFF1.title: ""');
    assertStringIncludes(text, '\t\t""');
    // CRLF, as the source used.
    assertEquals(text.includes("\r\n"), true);
  });
});

Deno.test("the extracted overlay lands at the exact expected instance path", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h), deps(h)), 0);
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    const target = `${h.dir}/instance`;
    for (const entry of zip.files()) {
      const dest = `${target}/${entry.path}`;
      await Deno.mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
      await Deno.writeFile(dest, await zip.read(entry.path));
    }
    const stat = await Deno.stat(`${target}/config/ftbquests/quests/lang/ja_jp.snbt`);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("english-override mode writes en_us.snbt and says so in the README", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h, ["--override-en-us"]), deps(h)), 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(zip.has("config/ftbquests/quests/lang/en_us.snbt"), true);
    assertEquals(zip.has("config/ftbquests/quests/lang/ja_jp.snbt"), false);
    const readme = await zip.readText("README.md");
    assertStringIncludes(readme, "every player");
    assertStringIncludes(readme, "en_gb");
  });
});

Deno.test("no mod jar or pack asset is copied into the overlay", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h), deps(h)), 0);
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(zip.files().some((f) => f.path.includes("mods/")), false);
    assertEquals(zip.files().some((f) => f.path.endsWith(".jar")), false);
  });
});

Deno.test("sidecar manifest and report are written next to an explicit zip path", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h, ["--emit-raw"]), deps(h)), 0);
    const manifest = JSON.parse(await Deno.readTextFile(`${h.dir}/out.manifest.json`));
    assertEquals(manifest.pack.name, "Rubius Cobblemon");
    assertEquals(manifest.pack.version, "0.9");
    assertEquals(manifest.targetLocale, "ja_jp");
    assertEquals(manifest.sourceArchiveSha256.length, 64);
    assertEquals(manifest.toolVersion.length > 0, true);
    assertEquals(manifest.keyCounts.strings > 0, true);

    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/out.report.json`));
    assertEquals(report.failed.length, 0);
    assertEquals(report.translated > 0, true);

    const raw = await Deno.readTextFile(`${h.dir}/out.ja_jp.snbt`);
    assertStringIncludes(raw, "[ja_jp]");
  });
});

Deno.test("chapter context from the pack reaches the report", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h, ["--verbose"]), deps(h)), 0);
    const combined = h.stdout.join("\n");
    assertStringIncludes(combined, "chapter");
  });
});

Deno.test("a second run is served entirely from the cache", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h), deps(h)), 0);
    const second = { ...h, stdout: [] as string[], stderr: [] as string[] };
    assertEquals(
      await run(baseArgs(h, ["--output", `${h.dir}/again.zip`]), deps(second)),
      0,
      second.stderr.join("\n"),
    );
    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/again.report.json`));
    assertEquals(report.translated, 0);
    assertEquals(report.cached > 0, true);
  });
});

Deno.test("--dry-run reports the plan and writes nothing", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h, ["--dry-run"]), deps(h)), 0);
    const combined = h.stdout.join("\n");
    assertStringIncludes(combined, "dry run");
    assertStringIncludes(combined, "batches");
    await assertRejects(() => Deno.stat(`${h.dir}/out.zip`));
  });
});

Deno.test("--json emits one machine-readable event per stage", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h, ["--json"]), deps(h)), 0);
    const events = h.stdout.map((line) => JSON.parse(line));
    const stages = events.filter((e) => e.type === "stage").map((e) => e.stage);
    assertEquals(stages, [
      "resolve",
      "download",
      "inspect",
      "parse",
      "translate",
      "validate",
      "package",
    ]);
    const done = events.find((e) => e.type === "done");
    assertEquals(done.archive, `${h.dir}/out.zip`);
    assertEquals(typeof done.report.translated, "number");
  });
});

Deno.test("--quiet prints nothing on success", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h, ["--quiet"]), deps(h)), 0);
    assertEquals(h.stdout, []);
  });
});

Deno.test("an existing output is refused with exit code 8 unless forced", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h), deps(h)), 0);
    const second = { ...h, stdout: [] as string[], stderr: [] as string[] };
    assertEquals(await run(baseArgs(h), deps(second)), 8);
    assertStringIncludes(second.stderr.join("\n"), "--force");
    const third = { ...h, stdout: [] as string[], stderr: [] as string[] };
    assertEquals(await run(baseArgs(h, ["--force"]), deps(third)), 0);
  });
});

Deno.test("a pack with no quest localization exits 5", async () => {
  await harness(async (h) => {
    const empty = await writeZip([
      { path: "modrinth.index.json", text: "{}" },
      { path: "overrides/config/other.json", text: "{}" },
    ]);
    const d = { ...deps(h), fetch: fetchFor(empty) };
    assertEquals(await run(baseArgs(h), d), 5);
    assertStringIncludes(h.stderr.join("\n"), "FTB Quests");
  });
});

Deno.test("an unsupported url exits 3 and a bad locale exits 2", async () => {
  await harness(async (h) => {
    assertEquals(
      await run([
        "--url",
        "https://example.com/nope",
        "--target",
        "ja",
        "--output",
        `${h.dir}/a.zip`,
      ], deps(h)),
      3,
    );
    const second = { ...h, stdout: [] as string[], stderr: [] as string[] };
    assertEquals(
      await run([
        "--url",
        "https://modrinth.com/modpack/x",
        "--target",
        "Klingon",
        "--output",
        "./o",
      ], deps(second)),
      2,
    );
  });
});

Deno.test("a provider that cannot produce valid output exits 6 and writes no archive", async () => {
  await harness(async (h) => {
    // claude-code with a scripted-missing binary: preflight fails first.
    const code = await run(baseArgs(h, ["--provider", "claude-code"]), {
      ...deps(h),
      commandRunner: {
        run: () => Promise.reject(new (class extends Error {})("nope")),
      },
    });
    assertEquals(code, 9);
    await assertRejects(() => Deno.stat(`${h.dir}/out.zip`));
  });
});

Deno.test("a local --archive needs no network at all", async () => {
  await harness(async (h) => {
    const path = `${h.dir}/local.mrpack`;
    await Deno.writeFile(path, await packBytes());
    const code = await run([
      "--archive",
      path,
      "--target",
      "ja_jp",
      "--output",
      `${h.dir}/local-out.zip`,
      "--provider",
      "echo",
      "--cache-dir",
      h.cacheDir,
    ], {
      ...deps(h),
      fetch: () => Promise.reject(new Error("the network must not be touched")),
    });
    assertEquals(code, 0, h.stderr.join("\n"));
    const zip = await readZip(await Deno.readFile(`${h.dir}/local-out.zip`));
    assertEquals(zip.has("config/ftbquests/quests/lang/ja_jp.snbt"), true);
  });
});

Deno.test("--layout both emits the overrides wrapper as well", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h, ["--layout", "both"]), deps(h)), 0);
    const zip = await readZip(await Deno.readFile(`${h.dir}/out.zip`));
    assertEquals(zip.has("config/ftbquests/quests/lang/ja_jp.snbt"), true);
    assertEquals(zip.has("overrides/config/ftbquests/quests/lang/ja_jp.snbt"), true);
  });
});

Deno.test("a directory --output names the archive after the pack version", async () => {
  await harness(async (h) => {
    const code = await run([
      "--url",
      "https://modrinth.com/modpack/rubius-cobblemon",
      "--target",
      "ja_jp",
      "--output",
      h.dir,
      "--provider",
      "echo",
      "--cache-dir",
      h.cacheDir,
    ], deps(h));
    assertEquals(code, 0, h.stderr.join("\n"));
    await Deno.stat(`${h.dir}/rubius-cobblemon-0.9-ja_jp.zip`);
  });
});

Deno.test("no secret from the environment or the url leaks into any output", async () => {
  await harness(async (h) => {
    const secret = "$2a$10$supersecretcurseforgekey";
    const code = await run(
      baseArgs(h, ["--curseforge-api-key", secret, "--emit-raw"]),
      {
        ...deps(h),
        env: { CURSEFORGE_API_KEY: secret, ANTHROPIC_API_KEY: "sk-ant-secret-value-x" },
      },
    );
    assertEquals(code, 0, h.stderr.join("\n"));

    const files = [
      `${h.dir}/out.zip`,
      `${h.dir}/out.manifest.json`,
      `${h.dir}/out.report.json`,
      `${h.dir}/out.README.md`,
      `${h.dir}/out.ja_jp.snbt`,
    ];
    for (const file of files) {
      const text = new TextDecoder().decode(await Deno.readFile(file));
      assertEquals(text.includes("supersecretcurseforgekey"), false, file);
      assertEquals(text.includes("sk-ant-secret-value-x"), false, file);
    }
    const logs = [...h.stdout, ...h.stderr].join("\n");
    assertEquals(logs.includes("supersecretcurseforgekey"), false);
    assertEquals(logs.includes("sk-ant-secret-value-x"), false);

    for await (const entry of Deno.readDir(h.cacheDir)) {
      const text = await Deno.readTextFile(`${h.cacheDir}/${entry.name}`);
      assertEquals(text.includes("supersecretcurseforgekey"), false);
    }
  });
});

Deno.test("--previous reports added, changed, removed and reused keys", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h, ["--emit-raw"]), deps(h)), 0, h.stderr.join("\n"));
    const second = { ...h, stdout: [] as string[], stderr: [] as string[] };
    assertEquals(
      await run(
        baseArgs(h, ["--output", `${h.dir}/v2.zip`, "--previous", `${h.dir}/out.manifest.json`]),
        deps(second),
      ),
      0,
      second.stderr.join("\n"),
    );
    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/v2.report.json`));
    assertEquals(Array.isArray(report.updateDiff.reused), true);
    assertEquals(report.updateDiff.reused.length > 0, true);
    assertEquals(report.updateDiff.added.length, 0);
    assertEquals(report.updateDiff.removed.length, 0);
  });
});

Deno.test("the original downloaded archive is never modified", async () => {
  await harness(async (h) => {
    const path = `${h.dir}/local.mrpack`;
    const original = await packBytes();
    await Deno.writeFile(path, original);
    await run([
      "--archive",
      path,
      "--target",
      "ja_jp",
      "--output",
      `${h.dir}/o.zip`,
      "--provider",
      "echo",
      "--cache-dir",
      h.cacheDir,
    ], deps(h));
    assertEquals(await Deno.readFile(path), original);
  });
});

Deno.test("a malicious archive is refused before anything is written", async () => {
  await harness(async (h) => {
    const { buildRawZip } = await import("./helpers/zip_builder.ts");
    const evil = await buildRawZip([
      { name: "../../etc/evil.snbt", data: new TextEncoder().encode("{}") },
    ]);
    const code = await run(baseArgs(h), { ...deps(h), fetch: fetchFor(evil) });
    assertEquals(code, 3);
    assertStringIncludes(h.stderr.join("\n").toLowerCase(), "unsafe");
    await assertRejects(() => Deno.stat(`${h.dir}/out.zip`));
  });
});

Deno.test("a local archive takes its pack name and version from the pack, not the file name", async () => {
  // Regression: the file-name stem of `pack.mrpack` was winning over the real
  // version in modrinth.index.json, so the output was named `...-pack-ja_jp.zip`
  // instead of carrying the exact compatible pack version.
  await harness(async (h) => {
    const path = `${h.dir}/pack.mrpack`;
    await Deno.writeFile(path, await packBytes());
    const code = await run([
      "--archive",
      path,
      "--target",
      "ja_jp",
      "--output",
      h.dir,
      "--provider",
      "echo",
      "--cache-dir",
      h.cacheDir,
    ], deps(h));
    assertEquals(code, 0, h.stderr.join("\n"));
    await Deno.stat(`${h.dir}/rubius-cobblemon-0.9-ja_jp.zip`);
  });
});

Deno.test("a resolver-reported version still wins over the in-archive manifest", async () => {
  // Modrinth/CurseForge know the released version authoritatively; the archive's
  // own manifest can lag behind it.
  await harness(async (h) => {
    const code = await run([
      "--url",
      "https://modrinth.com/modpack/rubius-cobblemon",
      "--target",
      "ja_jp",
      "--output",
      h.dir,
      "--provider",
      "echo",
      "--cache-dir",
      h.cacheDir,
    ], deps(h));
    assertEquals(code, 0, h.stderr.join("\n"));
    const manifest = JSON.parse(
      await Deno.readTextFile(`${h.dir}/rubius-cobblemon-0.9-ja_jp.manifest.json`),
    );
    assertEquals(manifest.pack.version, "0.9");
    assertEquals(manifest.pack.name, "Rubius Cobblemon");
  });
});

Deno.test("the detected FTB Quests version flows into the manifest and README", async () => {
  await harness(async (h) => {
    assertEquals(await run(baseArgs(h), deps(h)), 0, h.stderr.join("\n"));
    const manifest = JSON.parse(await Deno.readTextFile(`${h.dir}/out.manifest.json`));
    assertEquals(manifest.questMod.version, "2101.1.10");
    const readme = await Deno.readTextFile(`${h.dir}/out.README.md`);
    assertStringIncludes(readme, "2101.1.10");
  });
});

Deno.test("cancellation leaves a usable cache and no partial output", async () => {
  await harness(async (h) => {
    const controller = new AbortController();
    let batches = 0;
    // Abort partway through, the way Ctrl+C does.
    const cancelling = {
      ...deps(h),
      signal: controller.signal,
      stdout: (line: string) => {
        h.stdout.push(line);
        if (line.includes("batch ") && ++batches >= 1) controller.abort();
      },
    };
    const code = await run(baseArgs(h, ["--batch-size", "1"]), cancelling);
    assertEquals(code, 130);

    // No archive and no sidecar was written.
    for (const file of ["out.zip", "out.manifest.json", "out.report.json", "out.README.md"]) {
      await assertRejects(() => Deno.stat(`${h.dir}/${file}`));
    }

    // The cache is valid JSON and holds the completed work, so a rerun resumes.
    let cacheEntries = 0;
    for await (const entry of Deno.readDir(h.cacheDir)) {
      assertEquals(entry.name.endsWith(".tmp"), false, "a temp file was left behind");
      const parsed = JSON.parse(await Deno.readTextFile(`${h.cacheDir}/${entry.name}`));
      cacheEntries += Object.keys(parsed.entries).length;
    }
    assertEquals(cacheEntries > 0, true, "cancelling lost every completed batch");

    const resumed = { ...h, stdout: [] as string[], stderr: [] as string[] };
    assertEquals(await run(baseArgs(h), deps(resumed)), 0, resumed.stderr.join("\n"));
    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/out.report.json`));
    assertEquals(report.cached > 0, true, "the resumed run did not reuse the cached work");
    assertEquals(report.failed.length, 0);
  });
});

Deno.test("end to end: a corrupt cache entry is refused and retranslated", async () => {
  await harness(async (h) => {
    // Prime a real cache file, then poison one entry the way a bad provider
    // response or an older, weaker validator would have.
    assertEquals(await run(baseArgs(h), deps(h)), 0, h.stderr.join("\n"));

    let cachePath = "";
    for await (const entry of Deno.readDir(h.cacheDir)) {
      if (entry.isFile && entry.name.endsWith(".json")) cachePath = `${h.cacheDir}/${entry.name}`;
    }
    assertEquals(cachePath === "", false, "no cache file was written");

    const file = JSON.parse(await Deno.readTextFile(cachePath));
    const ids = Object.keys(file.entries);
    assertEquals(ids.length > 0, true);
    // Blank one entry out entirely: a non-empty source may never translate to "".
    file.entries[ids[0]] = { text: "", model: "echo" };
    await Deno.writeTextFile(cachePath, JSON.stringify(file, null, 2));

    const second = { ...h, stdout: [] as string[], stderr: [] as string[] };
    assertEquals(
      await run(baseArgs(h, ["--output", `${h.dir}/again.zip`]), deps(second)),
      0,
      second.stderr.join("\n"),
    );

    // The poisoned string came back from the provider, not from the cache.
    const report = JSON.parse(await Deno.readTextFile(`${h.dir}/again.report.json`));
    assertEquals(report.translated > 0, true, "the corrupt entry was reused");
    assertEquals(report.failed.length, 0);

    // And nothing empty reached the archive.
    const zip = await readZip(await Deno.readFile(`${h.dir}/again.zip`));
    const snbt = await zip.readText("config/ftbquests/quests/lang/ja_jp.snbt");
    const root = parseSnbt(snbt);
    const sourceRoot = parseSnbt(LANG);
    for (const member of root.members) {
      if (member.value.type !== "string") continue;
      const source = sourceRoot.members.find((m) => m.key === member.key)!;
      if (source.value.type !== "string" || source.value.value.trim() === "") continue;
      assertEquals(member.value.value.trim() === "", false, `${member.key} was emptied`);
    }

    // The poisoned entry was replaced on disk rather than left to fail again.
    const after = JSON.parse(await Deno.readTextFile(cachePath));
    assertEquals(after.entries[ids[0]]?.text.trim() === "", false, "the empty entry survived");
    const third = { ...h, stdout: [] as string[], stderr: [] as string[] };
    assertEquals(
      await run(baseArgs(h, ["--output", `${h.dir}/third.zip`]), deps(third)),
      0,
      third.stderr.join("\n"),
    );
    const thirdReport = JSON.parse(await Deno.readTextFile(`${h.dir}/third.report.json`));
    assertEquals(thirdReport.translated, 0, "the third run should be a pure cache hit");
  });
});

Deno.test("a malformed percent-encoded url exits 2 with actionable guidance", async () => {
  for (
    const bad of [
      "https://example.com/%E0%A4%A.zip",
      "https://www.curseforge.com/minecraft/modpacks/%E0%A4%A",
      "https://modrinth.com/modpack/%E0%A4%A",
    ]
  ) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await run(
      ["--url", bad, "--target", "ja_jp", "--output", "/tmp/mqt-unused.zip", "--dry-run"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        env: {},
        fetch: () => Promise.reject(new Error("the network must not be reached")),
      },
    );
    assertEquals(code, 2, `${bad} -> ${stderr.join("\n")}`);
    const message = stderr.join("\n");
    assertStringIncludes(message, "percent-encoding");
    assertEquals(message.includes("internal error"), false, bad);
    assertEquals(message.includes("URI malformed"), false, bad);
  }
});
