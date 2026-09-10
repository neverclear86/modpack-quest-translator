import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { readZip } from "../src/archive/zip/reader.ts";
import { buildArtifact } from "../src/output/package.ts";
import type { OverlayMeta } from "../src/output/types.ts";
import { createDefaultRedactor } from "../src/util/redact.ts";
import { sha256Hex } from "../src/util/hash.ts";
import { buildInstallerBundle, type PackageBundleArgs } from "../src/packager/bundle.ts";
import { parsePackagerArgs } from "../src/packager/args.ts";
import { runPackager } from "../src/packager/run.ts";
import { parseBundleManifest } from "../src/installer/bundle.ts";
import { digestByKey } from "../src/quests/digest.ts";
import { ftbQuestsLangAdapter } from "../src/quests/ftbquests_lang.ts";
import { finishedRun } from "./helpers/translation_report.ts";
import { sourceArchiveOf } from "./helpers/source_archive.ts";
import { parseInstallerConf } from "../src/packager/scripts/conf.ts";
import { scriptLinuxLauncher, scriptWindowsLauncher } from "../src/packager/scripts/launchers.ts";
import { POSIX_INSTALLER_SCRIPT } from "../src/packager/scripts/posix.ts";
import { POWERSHELL_INSTALLER_SCRIPT } from "../src/packager/scripts/powershell.ts";

const JAPANESE = '{\n  quest.title: "空の冒険"\n  quest.desc: "飛行船を作る"\n}\n';
const ENGLISH = '{\n  quest.title: "Skyward Adventure"\n  quest.desc: "Build an airship"\n}\n';
const LANG = "config/ftbquests/quests/lang/en_us.snbt";
const ID = "aca-2.4-ja_jp-en_us-override";
const SOURCE = await sourceArchiveOf(ENGLISH);

function meta(): OverlayMeta {
  return {
    artifact: "snbt-overlay",
    toolVersion: "1.1.0",
    generatedAt: "2026-08-25T00:00:00.000Z",
    sourceUrl: "https://example.invalid/aca.zip",
    packName: "All of Create - Aeronautics",
    packVersion: "v2.4",
    sourceArchiveSha256: SOURCE.sha256,
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    overrideEnglish: true,
    provider: "echo",
    model: "haiku",
    fallbackModel: "sonnet",
    archiveFlavour: "curseforge",
    sourcePath: SOURCE.path,
    keyCounts: { keys: 2, strings: 2, translated: 2, cached: 0, skipped: 0, fallback: 0 },
    sourceKeyDigests: digestByKey(ftbQuestsLangAdapter.extract(ENGLISH).units),
  };
}

async function overlay(): Promise<Uint8Array> {
  return await buildArtifact({
    payload: JAPANESE,
    meta: meta(),
    report: finishedRun({ translated: 2 }),
    layout: "instance",
    redactor: createDefaultRedactor(),
  });
}

function args(bytes: Uint8Array, overrides: Partial<PackageBundleArgs> = {}): PackageBundleArgs {
  return {
    overlay: bytes,
    sourceArchive: SOURCE.bytes,
    bundleId: ID,
    toolVersion: "1.1.0",
    binaries: [],
    installer: "scripts",
    ...overrides,
  };
}

// ---- argument parsing ------------------------------------------------------

const REQUIRED = ["--overlay", "a.zip", "--output", "b.zip", "--source-archive", "pack.zip"];

Deno.test("--installer scripts selects the script-only bundle and needs no binaries", () => {
  const options = parsePackagerArgs([...REQUIRED, "--installer", "scripts"]);
  assertEquals(options.installer, "scripts");
  assertEquals(parsePackagerArgs(REQUIRED).installer, "binaries");
});

Deno.test("--installer scripts contradicts every binary flag, and unknown kinds are refused", () => {
  for (
    const extra of [
      ["--binaries", "dist/bin"],
      ["--linux-binary", "/l"],
      ["--windows-binary", "/w"],
      ["--no-binaries"],
    ]
  ) {
    const error = assertThrows(
      () => parsePackagerArgs([...REQUIRED, "--installer", "scripts", ...extra]),
      AppError,
    );
    assertEquals(error.code, "E_INVALID_INPUT");
    assertStringIncludes(error.message, "--installer scripts");
  }
  const unknown = assertThrows(
    () => parsePackagerArgs([...REQUIRED, "--installer", "python"]),
    AppError,
  );
  assertStringIncludes(unknown.message, "--installer");
});

// ---- bundle layout ---------------------------------------------------------

Deno.test("a script bundle holds the scripts, the launchers and the conf, and no binaries", async () => {
  const built = await buildInstallerBundle(args(await overlay()));
  const entries = (await readZip(built.bytes)).entries.map((entry) => entry.path).sort();
  assertEquals(entries, [
    `${ID}/INSTALL-LINUX.sh`,
    `${ID}/INSTALL-WINDOWS.cmd`,
    `${ID}/README.md`,
    `${ID}/STATUS-LINUX.sh`,
    `${ID}/STATUS-WINDOWS.cmd`,
    `${ID}/UNINSTALL-LINUX.sh`,
    `${ID}/UNINSTALL-WINDOWS.cmd`,
    `${ID}/bundle-manifest.json`,
    `${ID}/payload/${LANG}`,
    `${ID}/scripts/installer.conf`,
    `${ID}/scripts/mqt-installer.ps1`,
    `${ID}/scripts/mqt-installer.sh`,
    `${ID}/translation-manifest.json`,
    `${ID}/translation-report.json`,
  ]);
});

Deno.test("a script bundle is byte-identical when built twice", async () => {
  const bytes = await overlay();
  const first = await buildInstallerBundle(args(bytes));
  const second = await buildInstallerBundle(args(bytes));
  assertEquals(await sha256Hex(first.bytes), await sha256Hex(second.bytes));
});

Deno.test("only the shell scripts carry the execute bit", async () => {
  const built = await buildInstallerBundle(args(await overlay()));
  for (const entry of (await readZip(built.bytes)).entries) {
    const expected = /\.sh$/.test(entry.path) ? 0o755 : 0o644;
    assertEquals(entry.unixMode, expected, `${entry.path} should be ${expected.toString(8)}`);
  }
});

Deno.test("the manifest says it is a script bundle, and the binary installer refuses it", async () => {
  const built = await buildInstallerBundle(args(await overlay()));
  const text = await (await readZip(built.bytes)).readText(`${ID}/bundle-manifest.json`);
  const raw = JSON.parse(text);
  assertEquals(raw.installer, "scripts");
  assertEquals(raw.binaries, []);
  assertEquals(raw.containsSourceProse, false);
  // The executable installer keeps its state in `.mqt-installer/`; the scripts
  // keep theirs elsewhere. One instance driven by both would have two
  // authorities on what the original file was, so the executable refuses.
  const error = assertThrows(() => parseBundleManifest(text), AppError);
  assertEquals(error.code, "E_BUNDLE");
  assertStringIncludes(error.message, "script");
  // And a binary bundle still parses, with or without the field.
  parseBundleManifest(JSON.stringify({ ...raw, installer: "binaries" }));
  const { installer: _dropped, ...without } = raw;
  parseBundleManifest(JSON.stringify(without));
});

Deno.test("installer.conf agrees with the manifest and pins the source file", async () => {
  const built = await buildInstallerBundle(args(await overlay()));
  const archive = await readZip(built.bytes);
  const conf = parseInstallerConf(await archive.readText(`${ID}/scripts/installer.conf`));
  assertEquals(conf.format, 1);
  assertEquals(conf.bundleId, ID);
  assertEquals(conf.stateDir, ".mqt-installer-scripts");
  assertEquals(conf.payloads.length, 1);
  assertEquals(conf.payloads[0].path, LANG);
  assertEquals(conf.payloads[0].sha256, built.manifest.payload[0].sha256);
  assertEquals(conf.payloads[0].sizeBytes, built.manifest.payload[0].sizeBytes);
  // The pack's own file, as read out of the source archive: the scripts refuse
  // to install over a file that is not it, which is how a wrong pack version
  // is caught. A digest is not prose.
  assertEquals(conf.payloads[0].sourceSha256, await sha256Hex(ENGLISH));
  assertEquals(conf.payloads[0].sourceSizeBytes, new TextEncoder().encode(ENGLISH).byteLength);
  assertEquals(conf.packName, "All of Create - Aeronautics");
  assertEquals(conf.packVersion, "v2.4");
  const text = await archive.readText(`${ID}/scripts/installer.conf`);
  assert(!text.includes("\r"), "the conf is LF-only, since sh reads it");
  assert(!text.includes("Skyward"), "the conf carries no source prose");
});

Deno.test("a conf that cannot describe itself is refused", () => {
  const good = [
    "format=1",
    `bundleId=${ID}`,
    "tool=modpack-quest-translator",
    "toolVersion=1.1.0",
    "generatedAt=2026-08-25T00:00:00.000Z",
    "stateDir=.mqt-installer-scripts",
    "sourceLocale=en_us",
    "targetLocale=ja_jp",
    "payloadCount=1",
    `payload.1.path=${LANG}`,
    `payload.1.sha256=${"a".repeat(64)}`,
    "payload.1.sizeBytes=10",
    `payload.1.sourceSha256=${"b".repeat(64)}`,
    "payload.1.sourceSizeBytes=12",
  ];
  parseInstallerConf(good.join("\n") + "\n");
  const broken = (replace: string, by: string) =>
    good.map((line) => (line.startsWith(replace) ? by : line)).join("\n") + "\n";
  for (
    const [line, by] of [
      ["payload.1.path=", "payload.1.path=../../saves/level.dat"],
      ["payload.1.path=", "payload.1.path=mods/evil.jar"],
      ["payload.1.sha256=", "payload.1.sha256=nope"],
      ["payload.1.sizeBytes=", "payload.1.sizeBytes=-1"],
      ["format=", "format=2"],
      ["bundleId=", "bundleId=../x"],
      ["stateDir=", "stateDir=.mqt-installer"],
    ]
  ) {
    const error = assertThrows(() => parseInstallerConf(broken(line, by)), AppError);
    assertEquals(error.code, "E_BUNDLE", `${by} should be refused`);
  }
});

// ---- the scripts themselves ------------------------------------------------

Deno.test("the PowerShell script is shipped as UTF-8 with BOM and CRLF, for 5.1", async () => {
  const built = await buildInstallerBundle(args(await overlay()));
  const bytes = await (await readZip(built.bytes)).read(`${ID}/scripts/mqt-installer.ps1`);
  assertEquals([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes.subarray(3));
  assertEquals(text.split("\n").length, text.split("\r\n").length);
  assertStringIncludes(text, "#Requires -Version 5");
  // Nothing persistent: the only policy handling is the launcher's -ExecutionPolicy Bypass.
  assert(!/Set-ExecutionPolicy/i.test(text));
  assert(!/Unblock-File/i.test(text));
  // Every path goes through -LiteralPath, so brackets and wildcards in a path are literal.
  assert(!/\s-Path\s+\$/.test(text), "use -LiteralPath, never -Path with a variable");
  // No downloads, no processes.
  assert(!/Invoke-WebRequest|Invoke-RestMethod|Start-Process|Net\.WebClient/i.test(text));
});

Deno.test("the POSIX script is LF-only sh with documented tools", async () => {
  const built = await buildInstallerBundle(args(await overlay()));
  const text = await (await readZip(built.bytes)).readText(`${ID}/scripts/mqt-installer.sh`);
  assertEquals(text, POSIX_INSTALLER_SCRIPT);
  assert(text.startsWith("#!/bin/sh\n"));
  assert(!text.includes("\r"));
  assertStringIncludes(text, "set -eu");
  assertStringIncludes(text, "sha256sum");
  assert(!/\bcurl\b|\bwget\b/.test(text));
  // The PowerShell source is the same logic; it too is what the bundle ships.
  assert(POWERSHELL_INSTALLER_SCRIPT.length > 0);
});

/** Names of `%VAR%` / `%~dp0` expansions that appear outside double quotes. */
function unquotedBatchExpansions(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      if (line[i] !== "%") continue;
      const match = /^%(~[\w~]*|[A-Za-z_][\w]*%)/.exec(line.slice(i));
      if (!match) continue;
      if (!quoted) found.push(match[1].replace(/%$/, ""));
      i += match[0].length - 1;
    }
  }
  return found;
}

Deno.test("the Windows launcher runs PowerShell with a process-scoped policy only", () => {
  for (const command of ["install", "uninstall", "status"] as const) {
    const text = scriptWindowsLauncher(command);
    assert(text.includes("\r\n"));
    assertEquals(text.split("\n").length, text.split("\r\n").length);
    assertStringIncludes(text, "chcp 65001");
    assertStringIncludes(text, "-NoProfile");
    assertStringIncludes(text, "-ExecutionPolicy Bypass");
    assertStringIncludes(text, "-File");
    assertStringIncludes(text, 'set "MQT_PS1=%~dp0scripts\\mqt-installer.ps1"');
    assertStringIncludes(text, `-File "%MQT_PS1%" ${command} -BundleDir`);
    assert(!/Set-ExecutionPolicy/i.test(text));
    assert(!/-Command\b/.test(text), "-Command re-parses its argument; -File does not");
    assertStringIncludes(text, "exit /b %MQT_CODE%");
    for (const line of text.split(/\r?\n/)) {
      assert(!/^\s*(cd|chdir|pushd)\b/i.test(line), `unexpected directory change: ${line}`);
    }
    assertEquals(unquotedBatchExpansions(text), ["MQT_CODE"]);
    // Every launcher, STATUS included, passes the instance path in the same
    // quoted way, so every one needs the trailing-backslash fix-up before it.
    const fix = 'if "%MQT_INSTANCE:~-1%"=="\\" set "MQT_INSTANCE=%MQT_INSTANCE%."';
    assertStringIncludes(text, fix, `${command} launcher lacks the trailing-backslash fix`);
    assert(
      text.indexOf(fix) < text.indexOf("powershell.exe"),
      "the fix-up must run before PowerShell is invoked",
    );
  }
  assertStringIncludes(scriptWindowsLauncher("install"), "pause");
});

Deno.test("the Linux launcher runs the script through sh and forwards its arguments", () => {
  for (const command of ["install", "uninstall", "status"] as const) {
    const text = scriptLinuxLauncher(command);
    assert(text.startsWith("#!/bin/sh\n"));
    assert(!text.includes("\r"));
    assertStringIncludes(text, "set -eu");
    assertStringIncludes(text, 'BUNDLE_DIR=$(cd -- "$(dirname -- "$0")" && pwd)');
    assertStringIncludes(
      text,
      `exec sh "$BUNDLE_DIR/scripts/mqt-installer.sh" ${command} --bundle "$BUNDLE_DIR" "$@"`,
    );
    assertStringIncludes(text, "exit 10");
  }
});

Deno.test("the script bundle README is Japanese and says what Windows cannot promise", async () => {
  const built = await buildInstallerBundle(args(await overlay()));
  const text = await (await readZip(built.bytes)).readText(`${ID}/README.md`);
  assertStringIncludes(text, "Minecraft を終了");
  assertStringIncludes(text, "ExecutionPolicy");
  assertStringIncludes(text, "-ExecutionPolicy Bypass");
  assertStringIncludes(text, "PowerShell 5.1");
  assertStringIncludes(text, ".mqt-installer-scripts");
  // Migration from the executable bundle: refuse, and say to uninstall with it first.
  assertStringIncludes(text, "UNINSTALL");
  assertStringIncludes(text, ".mqt-installer/");
  assert(!text.includes("Skyward"), "the README carries no source prose");
  assertStringIncludes(text, "All of Create - Aeronautics v2.4");
  // Recovery is described as it is: a staged file can be left with the target
  // absent, and only the next install/uninstall repairs it. No "always original
  // or installed" promise, and the untested surface is named.
  assert(!text.includes("途中の状態にはなりません"), "no absolute power-loss promise");
  assertStringIncludes(text, "en_us.snbt.mqt-staged");
  assertStringIncludes(text, "中間状態");
  assertStringIncludes(text, "displaced");
  assertStringIncludes(text, "何も書きません");
  assertStringIncludes(text, "Windows PowerShell 5.1");
  assertStringIncludes(text, "自動テストしていません");
  assertStringIncludes(text, "同時に");
  assertStringIncludes(text, "not on\nreal Windows, Windows PowerShell 5.1");
  assertStringIncludes(text, "concurrent or malicious writers");
  assertStringIncludes(text, "STATUS only reports\nthem and writes nothing");
});

// ---- the sh script, run for real ---------------------------------------------

/** Extracts a freshly built script bundle and a minimal instance into a temp dir. */
async function scriptFixture(): Promise<
  { dir: string; bundle: string; instance: string; target: string; english: Uint8Array }
> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-scripts-sh-" });
  const built = await buildInstallerBundle(args(await overlay()));
  const archive = await readZip(built.bytes);
  for (const entry of archive.entries) {
    const path = `${dir}/${entry.path}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, await archive.read(entry.path));
  }
  const instance = `${dir}/instance`;
  await Deno.mkdir(`${instance}/mods`, { recursive: true });
  await Deno.mkdir(`${instance}/config/ftbquests/quests/lang`, { recursive: true });
  const english = new TextEncoder().encode(ENGLISH);
  await Deno.writeFile(`${instance}/${LANG}`, english);
  return { dir, bundle: `${dir}/${ID}`, instance, target: `${instance}/${LANG}`, english };
}

async function sh(
  bundle: string,
  command: string,
  instance: string,
  ...flags: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("sh", {
    args: [
      `${bundle}/scripts/mqt-installer.sh`,
      command,
      "--bundle",
      bundle,
      "--instance",
      instance,
      ...flags,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Every path under `root` with its mtime and digest, so a read-only run can be proven so. */
async function snapshot(root: string): Promise<string> {
  const lines: string[] = [];
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      const info = await Deno.lstat(path);
      const digest = entry.isFile ? await sha256Hex(await Deno.readFile(path)) : "-";
      lines.push(`${path.slice(root.length)} ${info.mtime?.toISOString()} ${digest}`);
      if (entry.isDirectory) await walk(path);
    }
  }
  await walk(root);
  return lines.sort().join("\n");
}

const HAS_SH = (await new Deno.Command("sh", { args: ["-c", "true"] }).output().catch(() => null))
  ?.code === 0;

Deno.test({
  name: "status is strictly read-only, even with staged and temporary leftovers to report",
  ignore: !HAS_SH,
  async fn() {
    const f = await scriptFixture();
    try {
      assertEquals((await sh(f.bundle, "install", f.instance, "--yes")).code, 0);
      await Deno.writeFile(`${f.target}.mqt-tmp-4242`, new Uint8Array([1, 2, 3]));
      await Deno.rename(f.target, `${f.target}.mqt-staged`);
      const before = await snapshot(f.instance);
      const status = await sh(f.bundle, "status", f.instance);
      assertEquals(status.code, 0, status.stderr);
      assertStringIncludes(status.stderr, "leftover temporary file");
      assertStringIncludes(status.stderr, "interrupted");
      assertEquals(await snapshot(f.instance), before, "status changed the instance");
      // The next install does the cleaning up.
      const install = await sh(f.bundle, "install", f.instance, "--yes");
      assertEquals(install.code, 0, install.stderr);
      assertStringIncludes(install.stderr, "removed a leftover temporary file");
      assertEquals(await snapshot(f.instance).then((s) => s.includes(".mqt-tmp-4242")), false);
    } finally {
      await Deno.remove(f.dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "an upgrade or forced reinstall refuses before writing when the recorded original is unusable",
  ignore: !HAS_SH,
  async fn() {
    const f = await scriptFixture();
    try {
      assertEquals((await sh(f.bundle, "install", f.instance, "--yes")).code, 0);
      const backups = `${f.instance}/.mqt-installer-scripts/backups`;
      const bak = (await Array.fromAsync(Deno.readDir(backups)))
        .map((e) => e.name).find((n) => n.endsWith(".original.bak"))!;
      const record = `${f.instance}/.mqt-installer-scripts/installed/en_us.snbt.meta`;
      // A "newer" bundle: same payload path, different bytes.
      const v2 = `${f.dir}/v2`;
      await new Deno.Command("cp", { args: ["-r", f.bundle, v2] }).output();
      const newPayload = new Uint8Array([
        ...await Deno.readFile(`${f.bundle}/payload/${LANG}`),
        10,
      ]);
      await Deno.writeFile(`${v2}/payload/${LANG}`, newPayload);
      const conf = await Deno.readTextFile(`${v2}/scripts/installer.conf`);
      await Deno.writeTextFile(
        `${v2}/scripts/installer.conf`,
        conf.replace(
          /payload\.1\.sha256=[0-9a-f]+/,
          `payload.1.sha256=${await sha256Hex(newPayload)}`,
        )
          .replace(/payload\.1\.sizeBytes=\d+/, `payload.1.sizeBytes=${newPayload.byteLength}`),
      );
      const installed = await Deno.readFile(f.target);
      const recordText = await Deno.readTextFile(record);

      // Truncated original.
      const bytes = await Deno.readFile(`${backups}/${bak}`);
      await Deno.writeFile(`${backups}/${bak}`, bytes.subarray(0, bytes.length - 5));
      const before = await snapshot(f.instance);
      const truncated = await sh(v2, "install", f.instance, "--yes");
      assertEquals(truncated.code, 13, truncated.stderr);
      assertStringIncludes(truncated.stderr, "truncated");
      assertEquals(await snapshot(f.instance), before, "a refused upgrade changed the instance");

      // Missing original, with an edited target and --force: no modified backup is captured either.
      await Deno.remove(`${backups}/${bak}`);
      await Deno.writeFile(f.target, new Uint8Array([...installed, 33]));
      const beforeForce = await snapshot(f.instance);
      const missing = await sh(v2, "install", f.instance, "--yes", "--force");
      assertEquals(missing.code, 13, missing.stderr);
      assertStringIncludes(missing.stderr, "missing");
      assertEquals(await snapshot(f.instance), beforeForce);
      assertEquals(await Deno.readTextFile(record), recordText, "the record was rewritten");

      // Put the original back: the upgrade goes through, and the old bundle restores.
      await Deno.writeFile(`${backups}/${bak}`, bytes);
      await Deno.writeFile(f.target, installed);
      const ok = await sh(v2, "install", f.instance, "--yes");
      assertEquals(ok.code, 0, ok.stderr);
      assertEquals(await sha256Hex(await Deno.readFile(f.target)), await sha256Hex(newPayload));
      const back = await sh(f.bundle, "uninstall", f.instance, "--yes");
      assertEquals(back.code, 0, back.stderr);
      assertEquals(await sha256Hex(await Deno.readFile(f.target)), await sha256Hex(f.english));
    } finally {
      await Deno.remove(f.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "a malformed or missing absent sentinel refuses upgrade and uninstall before any write",
  ignore: !HAS_SH,
  async fn() {
    const f = await scriptFixture();
    try {
      await Deno.remove(f.target);
      assertEquals((await sh(f.bundle, "install", f.instance, "--yes")).code, 0);
      const meta = `${f.instance}/.mqt-installer-scripts/backups/en_us.snbt.absent.meta`;
      const good = await Deno.readTextFile(meta);
      const v2 = `${f.dir}/v2`;
      await new Deno.Command("cp", { args: ["-r", f.bundle, v2] }).output();
      const newPayload = new Uint8Array([
        ...await Deno.readFile(`${f.bundle}/payload/${LANG}`),
        10,
      ]);
      await Deno.writeFile(`${v2}/payload/${LANG}`, newPayload);
      const conf = await Deno.readTextFile(`${v2}/scripts/installer.conf`);
      await Deno.writeTextFile(
        `${v2}/scripts/installer.conf`,
        conf.replace(
          /payload\.1\.sha256=[0-9a-f]+/,
          `payload.1.sha256=${await sha256Hex(newPayload)}`,
        )
          .replace(/payload\.1\.sizeBytes=\d+/, `payload.1.sizeBytes=${newPayload.byteLength}`),
      );
      for (
        const bad of [
          good.replace("kind=absent", "kind=original"),
          good.replace(`target=${LANG}`, "target=config/ftbquests/quests/lang/other.snbt"),
          null,
        ]
      ) {
        if (bad === null) await Deno.remove(meta);
        else await Deno.writeTextFile(meta, bad);
        const before = await snapshot(f.instance);
        const upgrade = await sh(v2, "install", f.instance, "--yes");
        assertEquals(upgrade.code, 13, `upgrade: ${upgrade.stderr}`);
        const uninstall = await sh(f.bundle, "uninstall", f.instance, "--yes", "--force");
        assertEquals(uninstall.code, 13, `uninstall: ${uninstall.stderr}`);
        assertEquals(await snapshot(f.instance), before, "a refused run changed the instance");
      }
      await Deno.writeTextFile(meta, good);
      const back = await sh(f.bundle, "uninstall", f.instance, "--yes");
      assertEquals(back.code, 0, back.stderr);
      assertEquals(await Deno.lstat(f.target).catch(() => null), null);
    } finally {
      await Deno.remove(f.dir, { recursive: true });
    }
  },
});

// ---- the CLI ---------------------------------------------------------------

Deno.test("the CLI writes <bundle-id>-scripts.zip into a directory in scripts mode", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqt-scripts-" });
  try {
    await Deno.writeFile(`${dir}/pack.zip`, SOURCE.bytes);
    await Deno.writeFile(`${dir}/${ID}.zip`, await overlay());
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runPackager([
      "--overlay",
      `${dir}/${ID}.zip`,
      "--source-archive",
      `${dir}/pack.zip`,
      "--output",
      dir,
      "--installer",
      "scripts",
      "--json",
    ], { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
    assertEquals(code, 0, stderr.join("\n"));
    const body = JSON.parse(stdout.join("\n"));
    assertEquals(body.installer, "scripts");
    assertEquals(body.output, `${dir}/${ID}-scripts.zip`);
    const archive = await readZip(await Deno.readFile(body.output));
    assert(archive.has(`${ID}/scripts/mqt-installer.sh`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
