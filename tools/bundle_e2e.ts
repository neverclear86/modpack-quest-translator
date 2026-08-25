/**
 * End-to-end acceptance gate for the installer bundle, on the real filesystem
 * with the real compiled binaries.
 *
 * Deliberately not a `deno test`: the unit suite never spawns a process or
 * writes outside a temp directory, and this does both. Run it with
 * `deno task e2e:bundle`, optionally against an overlay a real translation run
 * produced: `deno task e2e:bundle --overlay ./dist/some-pack-ja.zip`.
 *
 * Every child process is spawned with `Deno.execPath()` -- the same Deno that
 * is running this script -- so an older `deno` earlier on PATH cannot quietly
 * take over a gate that is supposed to prove the latest Deno 2 works.
 *
 * What it proves, in order: the translator still emits an overlay; the packager
 * turns that overlay into a bundle; a third-party unzip can read the bundle and
 * gets the execute bits; the shell launcher installs, is idempotent, and
 * restores byte-for-byte; a tampered payload is refused; and the Windows
 * executable is a PE image. Windows *runtime* behaviour is not tested here and
 * no such claim is made.
 */
import { readZip } from "../src/archive/zip/reader.ts";
import { writeZip } from "../src/archive/zip/writer.ts";
import { sha256Hex } from "../src/util/hash.ts";

const ENGLISH_MARKER = "Welcome, Trainer! You have arrived in the world of Rubius.";
const TARGET_DIR = "config/ftbquests/quests/lang";
const INSTANCE_NAME = "インスタンス フォルダ";
/** The Deno running this script, never whichever one happens to be on PATH. */
const DENO = Deno.execPath();

/** `--overlay <zip>` packages an overlay that already exists, rather than translating one. */
function overlayArgument(): string | undefined {
  const index = Deno.args.indexOf("--overlay");
  if (index < 0) return undefined;
  const value = Deno.args[index + 1];
  if (value === undefined) throw new Error("--overlay needs a path to an overlay .zip");
  return value;
}

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` -- ${detail}` : ""}`);
}

function encoded(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Substring search over raw bytes, so a 100 MiB executable is never decoded. */
function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  for (let i = haystack.indexOf(needle[0]); i >= 0; i = haystack.indexOf(needle[0], i + 1)) {
    if (i + needle.length > haystack.length) return false;
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile) yield path;
  }
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; stdin?: string; expect?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command(command, {
    args,
    cwd: options.cwd,
    stdin: options.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  const output = await child.output();
  const result = {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
  const expected = options.expect ?? 0;
  if (result.code !== expected) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${command} ${args.join(" ")} exited ${result.code}, expected ${expected}`);
  }
  return result;
}

async function main(): Promise<void> {
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "mqt-bundle-e2e-" });
  const external = overlayArgument();
  console.log(`workspace: ${root}`);
  console.log(`deno:      ${DENO} (${Deno.version.deno})`);
  console.log(external ? `overlay:   ${external} (given)\n` : "overlay:   translated here\n");

  // The pack's own English file. It is what lands in the instance as the file
  // the installer has to preserve, and its marker is what proves the bundle
  // carries no source prose -- true whether the overlay was made here or given.
  const lang = await Deno.readTextFile("tests/fixtures/snbt/lang_en_us.snbt");

  // ---- build everything ---------------------------------------------------
  console.log("building the installers...");
  await run(DENO, ["task", "build:installers"]);
  const windowsExe = "dist/bin/mqt-installer-windows-x86_64.exe";
  const header = (await Deno.readFile(windowsExe)).subarray(0, 0x100);
  const lfanew = new DataView(header.buffer, header.byteOffset).getUint32(0x3c, true);
  const full = await Deno.readFile(windowsExe);
  check(
    "the Windows installer is a PE image (build check only, never run here)",
    header[0] === 0x4d && header[1] === 0x5a && full[lfanew] === 0x50 && full[lfanew + 1] === 0x45,
    `${(full.byteLength / 1024 / 1024).toFixed(1)} MiB`,
  );
  const linuxExe = await Deno.readFile("dist/bin/mqt-installer-linux-x86_64");
  check(
    "the Linux installer is an ELF image",
    linuxExe[0] === 0x7f && linuxExe[1] === 0x45 && linuxExe[2] === 0x4c && linuxExe[3] === 0x46,
    `${(linuxExe.byteLength / 1024 / 1024).toFixed(1)} MiB`,
  );

  // ---- the overlay to package ---------------------------------------------
  let overlay: string;
  if (external !== undefined) {
    overlay = external;
    check(
      "the overlay given on the command line is readable",
      (await Deno.stat(overlay)).isFile,
      overlay,
    );
  } else {
    console.log("\ntranslating with the offline echo provider...");
    const chapter = await Deno.readTextFile("tests/fixtures/snbt/chapter_rubius_main.snbt");
    const pack = `${root}/fixture-pack.zip`;
    await Deno.writeFile(
      pack,
      await writeZip([
        {
          path: "modrinth.index.json",
          text: JSON.stringify({
            name: "Rubius Cobblemon",
            versionId: "0.9",
            dependencies: { minecraft: "1.21.1", neoforge: "21.1.228" },
            files: [{ path: "mods/ftb-quests-neoforge-2101.1.10.jar", downloads: [] }],
          }),
        },
        { path: "overrides/config/ftbquests/quests/lang/en_us.snbt", text: lang },
        { path: "overrides/config/ftbquests/quests/chapters/rubius_main.snbt", text: chapter },
        { path: "overrides/mods/SomeMod-1.0.jar", text: "not really a jar" },
      ]),
    );
    await run(DENO, [
      "run",
      "-A",
      "src/cli/main.ts",
      "--archive",
      pack,
      "--target",
      "ja_jp",
      "--override-en-us",
      "--provider",
      "echo",
      "--no-cache",
      "--quiet",
      "--output",
      `${root}/overlay`,
    ]);
    const overlays: string[] = [];
    for await (const entry of Deno.readDir(`${root}/overlay`)) {
      if (entry.name.endsWith(".zip")) overlays.push(`${root}/overlay/${entry.name}`);
    }
    check("the translator wrote exactly one overlay archive", overlays.length === 1, overlays[0]);
    overlay = overlays[0];
  }

  // ---- package ------------------------------------------------------------
  console.log("\npackaging the bundle...");
  const packaged = await run(DENO, [
    "task",
    "package-installer",
    "--overlay",
    overlay,
    "--output",
    `${root}/bundle.zip`,
    "--binaries",
    "dist/bin",
    "--json",
  ]);
  const report = JSON.parse(packaged.stdout.slice(packaged.stdout.indexOf("{")));
  // Whatever the overlay was for, the payload is a quest lang file and nothing
  // else: that allowlist is the guarantee the whole feature rests on.
  const target: string = report.payload[0].path;
  check(
    "packaging reported exactly one quest lang payload and nothing else",
    report.payload.length === 1 && target.startsWith(`${TARGET_DIR}/`) && target.endsWith(".snbt"),
    target,
  );

  await run(DENO, [
    "task",
    "package-installer",
    "--overlay",
    overlay,
    "--output",
    `${root}/bundle-again.zip`,
    "--binaries",
    "dist/bin",
    "--quiet",
  ]);
  check(
    "packaging the same overlay twice is byte-identical",
    await sha256Hex(await Deno.readFile(`${root}/bundle.zip`)) ===
      await sha256Hex(await Deno.readFile(`${root}/bundle-again.zip`)),
  );

  // ---- extract with a third-party unzip ----------------------------------
  // The bundle is read back through /usr/bin/unzip rather than our own reader:
  // that reader exists to survive hostile pack archives and caps entries at
  // 64 MiB, which our own 100 MiB installer executable is legitimately above.
  // What matters here is what the player's unzip produces anyway.
  console.log("\nextracting with /usr/bin/unzip...");
  const listed = (await run("unzip", ["-Z1", `${root}/bundle.zip`])).stdout
    .split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort();
  const expected = [
    "INSTALL-LINUX.sh",
    "INSTALL-WINDOWS.cmd",
    "README.md",
    "UNINSTALL-LINUX.sh",
    "UNINSTALL-WINDOWS.cmd",
    "bin/mqt-installer-linux-x86_64",
    "bin/mqt-installer-windows-x86_64.exe",
    "bundle-manifest.json",
    `payload/${target}`,
    "translation-manifest.json",
    "translation-report.json",
  ].map((name) => `${report.bundleId}/${name}`).sort();
  check(
    "the bundle holds exactly the expected entries under one top-level directory",
    listed.length === expected.length && listed.every((name, i) => name === expected[i]),
    listed.filter((name) => !expected.includes(name)).join(", "),
  );

  await run("unzip", ["-q", `${root}/bundle.zip`, "-d", `${root}/extracted`]);
  const bundleDir = `${root}/extracted/${report.bundleId}`;

  // Everything except payload/, which is the translation run's own output and
  // is checked against the overlay instead. (The offline echo provider prefixes
  // rather than translates, so its payload legitimately still reads English.)
  const carrying: string[] = [];
  for await (const file of walk(`${root}/extracted`)) {
    if (file.startsWith(`${bundleDir}/payload/`)) continue;
    if (bytesContain(await Deno.readFile(file), encoded(ENGLISH_MARKER))) carrying.push(file);
  }
  check(
    "nothing outside payload/ carries the pack's own English prose",
    carrying.length === 0,
    carrying.join(", "),
  );

  const overlayArchive = await readZip(await Deno.readFile(overlay));
  const overlayEntry = overlayArchive.entries
    .map((entry) => entry.path)
    .find((path) => path === target || path === `overrides/${target}`);
  check(
    "payload/ holds the translation run's own file, byte for byte, and nothing else",
    overlayEntry !== undefined &&
      await sha256Hex(await overlayArchive.read(overlayEntry)) ===
        await sha256Hex(await Deno.readFile(`${bundleDir}/payload/${target}`)),
    overlayEntry,
  );
  const modes: Record<string, number> = {};
  for (
    const name of [
      "INSTALL-LINUX.sh",
      "UNINSTALL-LINUX.sh",
      "README.md",
      "bundle-manifest.json",
      "bin/mqt-installer-linux-x86_64",
    ]
  ) {
    modes[name] = ((await Deno.stat(`${bundleDir}/${name}`)).mode ?? 0) & 0o777;
  }
  check(
    "unzip restored the execute bits",
    modes["INSTALL-LINUX.sh"] === 0o755 && modes["UNINSTALL-LINUX.sh"] === 0o755 &&
      modes["bin/mqt-installer-linux-x86_64"] === 0o755 && modes["README.md"] === 0o644 &&
      modes["bundle-manifest.json"] === 0o644,
    JSON.stringify(modes),
  );

  // ---- install into a real instance --------------------------------------
  const instance = `${root}/${INSTANCE_NAME}`;
  await Deno.mkdir(`${instance}/mods`, { recursive: true });
  await Deno.mkdir(`${instance}/config/ftbquests/quests/lang`, { recursive: true });
  await Deno.mkdir(`${instance}/saves`, { recursive: true });
  await Deno.writeTextFile(`${instance}/${target}`, lang);
  const originalDigest = await sha256Hex(lang);

  console.log("\ninstalling via ./INSTALL-LINUX.sh...");
  await run(`${bundleDir}/INSTALL-LINUX.sh`, [instance]);
  const installed = await Deno.readTextFile(`${instance}/${target}`);
  const payloadText = await Deno.readTextFile(`${bundleDir}/payload/${target}`);
  check("the launcher installed the payload byte for byte", installed === payloadText);
  check("the installed file is not the English original", installed !== lang);

  const backups: string[] = [];
  for await (const entry of Deno.readDir(`${instance}/.mqt-installer/backups`)) {
    if (entry.name.endsWith(".bak")) backups.push(entry.name);
  }
  check("exactly one backup was captured", backups.length === 1, backups.join(", "));
  check(
    "the backup holds the original English file",
    await sha256Hex(await Deno.readFile(`${instance}/.mqt-installer/backups/${backups[0]}`)) ===
      originalDigest,
  );

  console.log("\ninstalling a second time...");
  const second = await run(`${bundleDir}/INSTALL-LINUX.sh`, [instance]);
  const backupsAfter: string[] = [];
  for await (const entry of Deno.readDir(`${instance}/.mqt-installer/backups`)) {
    if (entry.name.endsWith(".bak")) backupsAfter.push(entry.name);
  }
  check(
    "a reinstall is idempotent and captures no second backup",
    second.code === 0 && backupsAfter.length === 1 &&
      await Deno.readTextFile(`${instance}/${target}`) === payloadText,
  );
  check(
    "the reinstall said there was nothing to do",
    second.stdout.includes("Already installed"),
  );

  console.log("\nasking the installed bundle for its status...");
  const reported = JSON.parse(
    (await run(`${bundleDir}/bin/mqt-installer-linux-x86_64`, [
      "status",
      "--bundle",
      bundleDir,
      "--instance",
      instance,
      "--json",
    ])).stdout,
  );
  check(
    "status reports this bundle installed, unmodified, with a restorable backup",
    reported.ok === true && reported.targets.length === 1 &&
      reported.targets[0].matchesBundle === true && reported.targets[0].modified === false &&
      typeof reported.targets[0].restorableFrom === "string",
    JSON.stringify(reported.targets?.[0]?.restorableFrom),
  );

  // ---- refusals -----------------------------------------------------------
  console.log("\nchecking the refusals...");
  const payloadPath = `${bundleDir}/payload/${target}`;
  const goodPayload = await Deno.readFile(payloadPath);
  await Deno.writeTextFile(payloadPath, `${payloadText}// tampered\n`);
  const tampered = await run(`${bundleDir}/bin/mqt-installer-linux-x86_64`, [
    "install",
    "--bundle",
    bundleDir,
    "--instance",
    instance,
    "--force",
  ], { expect: 10 });
  check(
    "a tampered payload is refused with E_BUNDLE, even under --force",
    tampered.code === 10 && tampered.stderr.includes("E_BUNDLE"),
  );
  await Deno.writeFile(payloadPath, goodPayload);

  const notAnInstance = await run(`${bundleDir}/bin/mqt-installer-linux-x86_64`, [
    "install",
    "--bundle",
    bundleDir,
    "--instance",
    root,
  ], { expect: 11 });
  check(
    "a directory that is not an instance is refused with E_INSTANCE",
    notAnInstance.code === 11,
  );

  await Deno.writeTextFile(`${instance}/${target}`, `${payloadText}// my own note\n`);
  const edited = await run(`${bundleDir}/UNINSTALL-LINUX.sh`, [instance], { expect: 12 });
  check("an edited install is refused with E_TARGET_MODIFIED", edited.code === 12);
  await Deno.writeTextFile(`${instance}/${target}`, payloadText);

  const movedBackups = `${instance}/.mqt-installer/backups-moved`;
  await Deno.rename(`${instance}/.mqt-installer/backups`, movedBackups);
  const noBackup = await run(`${bundleDir}/UNINSTALL-LINUX.sh`, [instance], { expect: 13 });
  check(
    "a missing backup is refused with E_BACKUP and nothing is written",
    noBackup.code === 13 && await Deno.readTextFile(`${instance}/${target}`) === payloadText,
  );
  await Deno.rename(movedBackups, `${instance}/.mqt-installer/backups`);

  const cancelled = await run(`${bundleDir}/INSTALL-LINUX.sh`, []);
  check(
    "a prompt with nothing on stdin is a cancellation, not a crash",
    cancelled.code === 0 && cancelled.stdout.includes("Cancelled") &&
      await Deno.readTextFile(`${instance}/${target}`) === payloadText,
    cancelled.stdout.trim().split("\n").pop(),
  );

  // ---- uninstall ----------------------------------------------------------
  console.log("\nuninstalling via ./UNINSTALL-LINUX.sh, answering the prompt on stdin...");
  await run(`${bundleDir}/UNINSTALL-LINUX.sh`, [], { stdin: `${instance}\n` });
  check(
    "the original English file came back byte for byte",
    await sha256Hex(await Deno.readFile(`${instance}/${target}`)) === originalDigest,
  );
  const kept: string[] = [];
  for await (const entry of Deno.readDir(`${instance}/.mqt-installer/backups`)) {
    if (entry.name.endsWith(".bak")) kept.push(entry.name);
  }
  check("the backup survived the restore", kept.length === 1);

  const again = await run(`${bundleDir}/UNINSTALL-LINUX.sh`, [instance], { expect: 14 });
  check("uninstalling twice is E_NOT_INSTALLED, not a second restore", again.code === 14);

  // ---- summary ------------------------------------------------------------
  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    for (const entry of failed) console.error(`FAILED: ${entry.name}`);
    Deno.exit(1);
  }
  console.log(`workspace kept at ${root}`);
}

await main();
