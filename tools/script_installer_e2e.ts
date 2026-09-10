/**
 * Integration gate for the script-only installer bundle.
 *
 * Deliberately not a `deno test`: it spawns real shells. It takes a script
 * bundle the packager built and the modpack archive the translation was made
 * from, extracts both, and drives `scripts/mqt-installer.sh` -- and, when a
 * `pwsh` is available, `scripts/mqt-installer.ps1` too -- through the success
 * path and every refusal the design promises, on a real instance tree whose
 * path carries a space and Japanese characters.
 *
 *   deno task e2e:scripts --bundle-zip <bundle>-scripts.zip --source-archive ./aca-v2.4.zip
 *                         [--pwsh /path/to/pwsh] [--sh dash|bash|busybox] [--keep]
 *
 * What a pwsh run on Linux proves and what it does not: the PowerShell script
 * parses and its logic behaves the same as the sh one on this filesystem.
 * Windows PowerShell 5.1, NTFS reparse points, `cmd.exe` and the `.cmd`
 * launchers are not exercised here and no claim is made about them.
 */
import { readZip } from "../src/archive/zip/reader.ts";
import { sha256Hex } from "../src/util/hash.ts";
import { parseInstallerConf } from "../src/packager/scripts/conf.ts";

const INSTANCE_NAME = "インスタンス フォルダ";
const STATE = ".mqt-installer-scripts";

function argument(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  if (index < 0) return undefined;
  const value = Deno.args[index + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
let engineLabel = "";
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name: `[${engineLabel}] ${name}`, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` -- ${detail}` : ""}`);
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  command: string,
  args: string[],
  options: { stdin?: string; cwd?: string } = {},
): Promise<Result> {
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
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function listBackups(instance: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${instance}/${STATE}/backups`)) out.push(entry.name);
  } catch {
    // none yet
  }
  return out.sort();
}

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

/** Every path under `root` with its mtime and digest: proof that a run wrote nothing. */
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

/** A copy of the bundle whose payload differs, as a later release of the same translation would. */
async function newerBundle(
  world: World,
  label: string,
): Promise<{ dir: string; payload: Uint8Array }> {
  const dir = `${world.root}/bundle ${label} ${world.counter}`;
  await run("cp", ["-r", world.bundleDir, dir]);
  const payload = new Uint8Array([...world.payload, ...new TextEncoder().encode("// v2\n")]);
  await Deno.writeFile(`${dir}/payload/${world.target}`, payload);
  const conf = await Deno.readTextFile(`${dir}/scripts/installer.conf`);
  await Deno.writeTextFile(
    `${dir}/scripts/installer.conf`,
    conf.replace(/payload\.1\.sha256=[0-9a-f]+/, `payload.1.sha256=${await sha256Hex(payload)}`)
      .replace(/payload\.1\.sizeBytes=\d+/, `payload.1.sizeBytes=${payload.byteLength}`),
  );
  return { dir, payload };
}

async function sameBytes(path: string, bytes: Uint8Array): Promise<boolean> {
  const got = await readOrNull(path);
  return got !== null && await sha256Hex(got) === await sha256Hex(bytes);
}

/** How to invoke one of the two installers. */
interface Engine {
  label: string;
  invoke(
    bundleDir: string,
    command: "install" | "uninstall" | "status",
    instance: string | undefined,
    flags: { force?: boolean; yes?: boolean; positional?: boolean },
    stdin?: string,
  ): Promise<Result>;
}

function shEngine(sh: string): Engine {
  return {
    label: `sh=${sh}`,
    invoke(bundleDir, command, instance, flags, stdin) {
      const args = [`${bundleDir}/scripts/mqt-installer.sh`, command, "--bundle", bundleDir];
      if (instance !== undefined) {
        if (flags.positional) args.push(instance);
        else args.push("--instance", instance);
      }
      if (flags.force) args.push("--force");
      if (flags.yes) args.push("--yes");
      return run(sh, args, { stdin });
    },
  };
}

function pwshEngine(pwsh: string): Engine {
  return {
    label: `pwsh=${pwsh}`,
    invoke(bundleDir, command, instance, flags, stdin) {
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        `${bundleDir}/scripts/mqt-installer.ps1`,
        command,
        "-BundleDir",
        bundleDir,
      ];
      if (instance !== undefined) {
        if (flags.positional) args.push(instance);
        else args.push("-Instance", instance);
      }
      if (flags.force) args.push("-Force");
      if (flags.yes) args.push("-Yes");
      return run(pwsh, args, { stdin });
    },
  };
}

interface World {
  root: string;
  bundleDir: string;
  bundleZip: string;
  target: string;
  payload: Uint8Array;
  english: Uint8Array;
  counter: number;
}

/** A fresh instance under a path with a space and Japanese in it. */
async function makeInstance(
  world: World,
  existing: Uint8Array | null = world.english,
): Promise<string> {
  const instance = `${world.root}/${INSTANCE_NAME} ${++world.counter}`;
  await Deno.mkdir(`${instance}/mods`, { recursive: true });
  await Deno.mkdir(`${instance}/config/ftbquests/quests/lang`, { recursive: true });
  await Deno.mkdir(`${instance}/saves`, { recursive: true });
  if (existing !== null) await Deno.writeFile(`${instance}/${world.target}`, existing);
  return instance;
}

async function scenarios(engine: Engine, world: World): Promise<void> {
  engineLabel = engine.label;
  console.log(`\n==== ${engine.label} ====`);
  const B = world.bundleDir;
  const T = world.target;
  const i = (
    bundle: string,
    ...rest: Parameters<Engine["invoke"]> extends [unknown, ...infer R] ? R : never
  ) => engine.invoke(bundle, ...rest);

  // ---- the happy path -------------------------------------------------------
  {
    const inst = await makeInstance(world);
    const notInstance = await i(B, "install", world.root, { yes: true });
    check(
      "a directory that is not an instance is refused with 11",
      notInstance.code === 11,
      notInstance.stderr.trim(),
    );

    const first = await i(B, "install", inst, { yes: true });
    check(
      "fresh install exits 0",
      first.code === 0,
      first.stderr.trim() || first.stdout.trim().split("\n").pop(),
    );
    check("the payload landed byte for byte", await sameBytes(`${inst}/${T}`, world.payload));
    const backups = await listBackups(inst);
    check(
      "one original backup and its meta were captured",
      backups.length === 2 && backups.some((n) => n.endsWith(".original.bak")) &&
        backups.some((n) => n.endsWith(".original.bak.meta")),
      backups.join(", "),
    );
    const bak = backups.find((n) => n.endsWith(".original.bak")) ?? "missing.original.bak";
    check(
      "the backup holds the pack's own file",
      await sameBytes(`${inst}/${STATE}/backups/${bak}`, world.english),
    );
    const meta = new TextDecoder().decode(
      (await readOrNull(`${inst}/${STATE}/backups/${bak}.meta`)) ?? new Uint8Array(),
    );
    check(
      "the backup meta records kind, target and digest",
      meta.includes("kind=original") && meta.includes(`target=${T}`) &&
        meta.includes(`sha256=${await sha256Hex(world.english)}`),
    );
    check(
      "an install record was written",
      await exists(`${inst}/${STATE}/installed/en_us.snbt.meta`),
    );

    const again = await i(B, "install", inst, { yes: true });
    check(
      "reinstall is idempotent: exit 0, says already installed, no new backup",
      again.code === 0 && /Already installed|すでに導入済み/.test(again.stdout) &&
        (await listBackups(inst)).length === 2,
      again.stdout.trim().split("\n").pop(),
    );

    const status = await i(B, "status", inst, {});
    check(
      "status reports this bundle's translation and changes nothing",
      status.code === 0 && status.stdout.includes("this bundle's translation") &&
        await sameBytes(`${inst}/${T}`, world.payload),
      status.stdout.split("\n").find((l) => l.includes("file:")),
    );

    // Edited after install.
    const edited = new Uint8Array([...world.payload, ...new TextEncoder().encode("// my note\n")]);
    await Deno.writeFile(`${inst}/${T}`, edited);
    const editedInstall = await i(B, "install", inst, { yes: true });
    check(
      "install over an edited install is refused with 12 and the edit stays",
      editedInstall.code === 12 && await sameBytes(`${inst}/${T}`, edited),
    );
    const editedUninstall = await i(B, "uninstall", inst, { yes: true });
    check(
      "uninstall of an edited install is refused with 12 and the edit stays",
      editedUninstall.code === 12 && await sameBytes(`${inst}/${T}`, edited),
      editedUninstall.stderr.trim().split("\n")[0],
    );
    const forced = await i(B, "uninstall", inst, { yes: true, force: true });
    const afterForce = await listBackups(inst);
    check(
      "uninstall --force keeps the edit as a modified backup and restores the original byte for byte",
      forced.code === 0 && await sameBytes(`${inst}/${T}`, world.english) &&
        afterForce.some((n) => n.endsWith(".modified.bak")),
      forced.stderr.trim(),
    );
    check("the original backup survived the restore", afterForce.includes(bak));
    check(
      "the install record is gone",
      !(await exists(`${inst}/${STATE}/installed/en_us.snbt.meta`)),
    );

    const twice = await i(B, "uninstall", inst, { yes: true });
    check(
      "uninstalling twice is 14, not a second restore",
      twice.code === 14 && await sameBytes(`${inst}/${T}`, world.english),
    );

    const reinstall = await i(B, "install", inst, { yes: true });
    check(
      "reinstall after uninstall reuses the identical original backup",
      reinstall.code === 0 && reinstall.stdout.includes("reusing") &&
        (await listBackups(inst)).filter((n) => n.endsWith(".original.bak")).length === 1,
      reinstall.stdout.trim().split("\n").pop(),
    );
    const plainUninstall = await i(B, "uninstall", inst, { yes: true });
    check(
      "plain uninstall restores byte for byte",
      plainUninstall.code === 0 && await sameBytes(`${inst}/${T}`, world.english),
    );

    // Positional instance argument, and a redirected stdin with nothing to answer.
    const positional = await i(B, "status", inst, { positional: true });
    check("the instance can be given positionally", positional.code === 0);
    const noInstance = await i(B, "install", undefined, {});
    check(
      "no instance and no terminal is 2, not a hang",
      noInstance.code === 2,
      noInstance.stderr.trim(),
    );
  }

  // ---- the version gate -----------------------------------------------------
  {
    const other = new Uint8Array([
      ...world.english,
      ...new TextEncoder().encode("// a later release\n"),
    ]);
    const inst = await makeInstance(world, other);
    const refused = await i(B, "install", inst, { yes: true });
    check(
      "a quest file that is not the translation's source is refused with 15, untouched",
      refused.code === 15 && await sameBytes(`${inst}/${T}`, other) &&
        (await listBackups(inst)).length === 0,
      refused.stderr.trim().split("\n")[0],
    );
    const forced = await i(B, "install", inst, { yes: true, force: true });
    check(
      "--force installs anyway after backing the file up",
      forced.code === 0 && await sameBytes(`${inst}/${T}`, world.payload) &&
        (await listBackups(inst)).some((n) => n.endsWith(".original.bak")),
    );
    const back = await i(B, "uninstall", inst, { yes: true });
    check(
      "uninstall restores that file, not the pack's original",
      back.code === 0 && await sameBytes(`${inst}/${T}`, other),
    );
  }

  // ---- absent target --------------------------------------------------------
  {
    const inst = await makeInstance(world, null);
    const first = await i(B, "install", inst, { yes: true });
    check(
      "install with no file present records an absent sentinel",
      first.code === 0 && await sameBytes(`${inst}/${T}`, world.payload) &&
        (await listBackups(inst)).includes("en_us.snbt.absent.meta"),
      first.stderr.trim(),
    );
    const back = await i(B, "uninstall", inst, { yes: true });
    check(
      "uninstall then deletes the file rather than restoring one",
      back.code === 0 && !(await exists(`${inst}/${T}`)),
    );
    const lang = `${world.root}/lang-elsewhere-${world.counter}`;
    await Deno.mkdir(lang);
    await Deno.remove(`${inst}/config/ftbquests/quests/lang`);
    await Deno.symlink(lang, `${inst}/config/ftbquests/quests/lang`);
    const viaLink = await i(B, "install", inst, { yes: true });
    check(
      "a symlinked lang directory is refused with 11 and nothing is written through it",
      viaLink.code === 11 && !(await exists(`${lang}/en_us.snbt`)),
      viaLink.stderr.trim().split("\n")[0],
    );
  }

  // ---- symlinks and unsafe paths --------------------------------------------
  {
    const inst = await makeInstance(world);
    const elsewhere = `${world.root}/elsewhere-${world.counter}.snbt`;
    await Deno.writeFile(elsewhere, world.english);
    await Deno.remove(`${inst}/${T}`);
    await Deno.symlink(elsewhere, `${inst}/${T}`);
    const linked = await i(B, "install", inst, { yes: true });
    check(
      "a symlinked target is refused with 11, even with --force",
      linked.code === 11 && await sameBytes(elsewhere, world.english) &&
        (await i(B, "install", inst, { yes: true, force: true })).code === 11,
      linked.stderr.trim().split("\n")[0],
    );
    await Deno.remove(`${inst}/${T}`);
    await Deno.writeFile(`${inst}/${T}`, world.english);
    const stateElsewhere = `${world.root}/state-elsewhere-${world.counter}`;
    await Deno.mkdir(stateElsewhere);
    await Deno.symlink(stateElsewhere, `${inst}/${STATE}`);
    const stateLink = await i(B, "install", inst, { yes: true });
    check(
      "a symlinked state directory is refused with 11 before anything is written",
      stateLink.code === 11 && await sameBytes(`${inst}/${T}`, world.english) &&
        (await Array.fromAsync(Deno.readDir(stateElsewhere))).length === 0,
      stateLink.stderr.trim().split("\n")[0],
    );
    await Deno.remove(`${inst}/${STATE}`);
    // The launcher forms of the same thing, through a bundle path with a space and Japanese in it.
    if (engine.label.startsWith("sh")) {
      const viaLauncher = await run(`${B}/INSTALL-LINUX.sh`, [inst, "--yes"]);
      check(
        "INSTALL-LINUX.sh installs through the launcher",
        viaLauncher.code === 0 && await sameBytes(`${inst}/${T}`, world.payload),
        viaLauncher.stderr.trim(),
      );
      const statusLauncher = await run("sh", [`${B}/STATUS-LINUX.sh`, inst]);
      check(
        "STATUS-LINUX.sh works through sh without the execute bit mattering",
        statusLauncher.code === 0 && statusLauncher.stdout.includes("this bundle's translation"),
      );
      const cancelled = await run(`${B}/UNINSTALL-LINUX.sh`, [inst], { stdin: "n\n" });
      check(
        "a redirected 'n' is not a terminal, so no prompt: the uninstall proceeds",
        cancelled.code === 0 && await sameBytes(`${inst}/${T}`, world.english),
        cancelled.stdout.trim().split("\n").pop(),
      );
    }
  }

  // ---- damaged bundle -------------------------------------------------------
  {
    const inst = await makeInstance(world);
    const copy = `${world.root}/bundle copy ${world.counter}`;
    await run("cp", ["-r", B, copy]);
    const payloadPath = `${copy}/payload/${T}`;
    await Deno.writeFile(payloadPath, new Uint8Array([...world.payload, 10]));
    const tampered = await i(copy, "install", inst, { yes: true, force: true });
    check(
      "a payload edited without its conf is refused with 10, even with --force",
      tampered.code === 10 && await sameBytes(`${inst}/${T}`, world.english) &&
        !(await exists(`${inst}/${STATE}`)),
      tampered.stderr.trim().split("\n")[0],
    );
    await Deno.writeFile(payloadPath, world.payload);
    const conf = await Deno.readTextFile(`${copy}/scripts/installer.conf`);
    await Deno.writeTextFile(
      `${copy}/scripts/installer.conf`,
      conf.replace(`payload.1.path=${T}`, "payload.1.path=../../saves/level.dat"),
    );
    const traversal = await i(copy, "install", inst, { yes: true });
    check(
      "a conf naming a traversal path is refused with 10",
      traversal.code === 10,
      traversal.stderr.trim().split("\n")[0],
    );
    await Deno.writeTextFile(
      `${copy}/scripts/installer.conf`,
      conf.replace("stateDir=.mqt-installer-scripts", "stateDir=.mqt-installer"),
    );
    const stateDir = await i(copy, "install", inst, { yes: true });
    check(
      "a conf pointing at the executable installer's state directory is refused with 10",
      stateDir.code === 10,
    );
    await Deno.remove(`${copy}/scripts/installer.conf`);
    const noConf = await i(copy, "install", inst, { yes: true });
    check("a bundle without its conf is refused with 10", noConf.code === 10);
    const binaryBundle = await run("sh", [`${B}/INSTALL-LINUX.sh`, inst, "--yes"], {});
    check(
      "(control) the untouched bundle still installs into the same instance",
      binaryBundle.code === 0,
    );
  }

  // ---- damaged backups ------------------------------------------------------
  {
    const inst = await makeInstance(world);
    await i(B, "install", inst, { yes: true });
    const bak = (await listBackups(inst)).find((n) => n.endsWith(".original.bak"))!;
    const bakPath = `${inst}/${STATE}/backups/${bak}`;
    const bytes = await Deno.readFile(bakPath);
    await Deno.writeFile(bakPath, bytes.subarray(0, bytes.length - 10));
    const truncated = await i(B, "uninstall", inst, { yes: true, force: true });
    check(
      "a truncated backup is refused with 13 and the target is untouched",
      truncated.code === 13 && await sameBytes(`${inst}/${T}`, world.payload),
      truncated.stderr.trim().split("\n")[0],
    );
    await Deno.remove(bakPath);
    const missing = await i(B, "uninstall", inst, { yes: true });
    check(
      "a missing backup is refused with 13 and the target is untouched",
      missing.code === 13 && await sameBytes(`${inst}/${T}`, world.payload),
      missing.stderr.trim().split("\n")[0],
    );
    await Deno.writeFile(bakPath, bytes);
    const meta = `${bakPath}.meta`;
    await Deno.writeTextFile(
      meta,
      (await Deno.readTextFile(meta)).replace(/sha256=[0-9a-f]+/, `sha256=${"0".repeat(64)}`),
    );
    const wrongMeta = await i(B, "uninstall", inst, { yes: true });
    check(
      "a backup whose meta disagrees with the record is refused with 13",
      wrongMeta.code === 13 && await sameBytes(`${inst}/${T}`, world.payload),
    );
  }

  // ---- lost state -----------------------------------------------------------
  {
    const inst = await makeInstance(world);
    await i(B, "install", inst, { yes: true });
    await Deno.remove(`${inst}/${STATE}/installed/en_us.snbt.meta`);
    const status = await i(B, "status", inst, {});
    check(
      "status with a lost record still reports the file as this bundle's",
      status.code === 0 && status.stdout.includes("record: none"),
    );
    const back = await i(B, "uninstall", inst, { yes: true });
    check(
      "uninstall with a lost record adopts the single original backup and restores",
      back.code === 0 && await sameBytes(`${inst}/${T}`, world.english),
      back.stderr.trim(),
    );

    // Two originals on disk and no record: a guess between lineages is refused.
    const other = new Uint8Array([...world.english, 10]);
    await Deno.writeFile(`${inst}/${T}`, other);
    await i(B, "install", inst, { yes: true, force: true });
    await Deno.remove(`${inst}/${STATE}/installed/en_us.snbt.meta`);
    const guess = await i(B, "uninstall", inst, { yes: true });
    check(
      "two candidate originals and no record is 13, never a guess",
      guess.code === 13 && await sameBytes(`${inst}/${T}`, world.payload),
      guess.stderr.trim().split("\n")[0],
    );
    const adopt = await i(B, "install", inst, { yes: true });
    check(
      "install with the translation in place, no record and two originals is refused with 11",
      adopt.code === 11,
    );
  }

  // ---- migration from the executable installer ------------------------------
  {
    const inst = await makeInstance(world, world.payload);
    await Deno.mkdir(`${inst}/.mqt-installer/backups`, { recursive: true });
    await Deno.writeTextFile(
      `${inst}/.mqt-installer/state.json`,
      JSON.stringify(
        {
          formatVersion: 1,
          installs: {
            [T]: {
              bundleId: "old",
              installedSha256: await sha256Hex(world.payload),
              installedAt: "x",
              originalWasAbsent: false,
              toolVersion: "1.1.2",
            },
          },
          history: [],
        },
        null,
        2,
      ),
    );
    const install = await i(B, "install", inst, { yes: true, force: true });
    check(
      "an instance the executable installer set up is refused with 11 and told to uninstall with it",
      install.code === 11 && install.stderr.includes("UNINSTALL") &&
        !(await exists(`${inst}/${STATE}`)),
      install.stderr.trim().split("\n")[0],
    );
    const uninstall = await i(B, "uninstall", inst, { yes: true, force: true });
    check("so is uninstall", uninstall.code === 11 && uninstall.stderr.includes("UNINSTALL"));
    await Deno.writeFile(`${inst}/${T}`, world.english);
    const foreign = await i(B, "install", inst, { yes: true });
    check(
      "with the executable's record still naming the target, even the pack's own file is refused",
      foreign.code === 11,
    );
    // After the executable's uninstall the record is gone and its backups are retained: that is fine.
    await Deno.writeTextFile(
      `${inst}/.mqt-installer/state.json`,
      JSON.stringify({
        formatVersion: 1,
        installs: {},
        history: [{ event: "uninstall", target: T, at: "x" }],
      }),
    );
    const after = await i(B, "install", inst, { yes: true });
    check(
      "once the executable's record is gone, install proceeds and retained legacy backups are ignored",
      after.code === 0 && await sameBytes(`${inst}/${T}`, world.payload),
    );
    const status = await i(B, "status", inst, {});
    check(
      "status does not claim a legacy install any more",
      status.code === 0 && !status.stdout.includes("note:"),
    );
  }
  {
    const inst = await makeInstance(world, world.payload);
    const handCopied = await i(B, "install", inst, { yes: true });
    check(
      "the translation copied in by hand, with no backup anywhere, is refused with 11",
      handCopied.code === 11 && !(await exists(`${inst}/${STATE}/installed/en_us.snbt.meta`)),
      handCopied.stderr.trim().split("\n")[0],
    );
    const uninstallHand = await i(B, "uninstall", inst, { yes: true });
    check(
      "and uninstall refuses too rather than deleting it",
      uninstallHand.code === 11 && await sameBytes(`${inst}/${T}`, world.payload),
    );
  }

  // ---- crash leftovers ------------------------------------------------------
  {
    const inst = await makeInstance(world);
    await Deno.rename(`${inst}/${T}`, `${inst}/${T}.mqt-staged`);
    const status = await i(B, "status", inst, {});
    check(
      "status reports a staged leftover and does not touch it",
      status.code === 0 && status.stderr.includes("interrupted") &&
        await exists(`${inst}/${T}.mqt-staged`) && !(await exists(`${inst}/${T}`)),
    );
    const install = await i(B, "install", inst, { yes: true });
    check(
      "install puts the leftover back first, then installs over the recovered original",
      install.code === 0 && !(await exists(`${inst}/${T}.mqt-staged`)) &&
        await sameBytes(`${inst}/${T}`, world.payload) &&
        await sameBytes(
          `${inst}/${STATE}/backups/${
            (await listBackups(inst)).find((n) => n.endsWith(".original.bak"))
          }`,
          world.english,
        ),
      install.stderr.trim().split("\n")[0],
    );
    await Deno.writeFile(`${inst}/${T}.mqt-tmp-12345`, new Uint8Array([1, 2, 3]));
    const idem = await i(B, "install", inst, { yes: true });
    check(
      "a leftover temporary file is removed and the install stays idempotent",
      idem.code === 0 && !(await exists(`${inst}/${T}.mqt-tmp-12345`)),
    );
    await i(B, "uninstall", inst, { yes: true });
    // The name was taken while the leftover sat there: keep the leftover, never restore it silently.
    const newer = new Uint8Array([...world.english, ...new TextEncoder().encode("// newer\n")]);
    await Deno.writeFile(`${inst}/${T}.mqt-staged`, world.payload);
    await Deno.writeFile(`${inst}/${T}`, newer);
    const displaced = await i(B, "install", inst, { yes: true, force: true });
    const backups = await listBackups(inst);
    check(
      "a leftover whose name was taken is kept as a displaced backup, and the newer file is what gets backed up",
      displaced.code === 0 && backups.some((n) => n.endsWith(".displaced.bak")) &&
        !(await exists(`${inst}/${T}.mqt-staged`)),
      displaced.stderr.trim().split("\n")[0],
    );
    const back = await i(B, "uninstall", inst, { yes: true });
    check(
      "uninstall restores the newer file",
      back.code === 0 && await sameBytes(`${inst}/${T}`, newer),
    );
  }

  // ---- status writes nothing, leftovers included ------------------------------
  {
    const inst = await makeInstance(world);
    await i(B, "install", inst, { yes: true });
    await Deno.writeFile(`${inst}/${T}.mqt-tmp-777`, new Uint8Array([7, 7, 7]));
    await Deno.writeFile(`${inst}/${T}.mqt-tmp-778`, new Uint8Array([7, 7, 8]));
    await Deno.rename(`${inst}/${T}`, `${inst}/${T}.mqt-staged`);
    const before = await snapshot(inst);
    const status = await i(B, "status", inst, {});
    check(
      "status with temporary and staged leftovers reports both and writes nothing at all",
      status.code === 0 && status.stderr.includes("leftover temporary file") &&
        status.stderr.includes("interrupted") && await snapshot(inst) === before,
      status.stderr.trim().split("\n")[0],
    );
    const staged = await Deno.readFile(`${inst}/${T}.mqt-staged`);
    await Deno.writeFile(`${inst}/${T}`, staged);
    const beforeTaken = await snapshot(inst);
    const again = await i(B, "status", inst, {});
    check(
      "status with the name taken still writes nothing",
      again.code === 0 && await snapshot(inst) === beforeTaken &&
        await exists(`${inst}/${T}.mqt-tmp-777`) && await exists(`${inst}/${T}.mqt-staged`),
    );
    const install = await i(B, "install", inst, { yes: true, force: true });
    check(
      "the next install removes the temporary leftovers and files the staged one as displaced",
      install.code === 0 && !(await exists(`${inst}/${T}.mqt-tmp-777`)) &&
        !(await exists(`${inst}/${T}.mqt-tmp-778`)) && !(await exists(`${inst}/${T}.mqt-staged`)) &&
        (await listBackups(inst)).some((n) => n.endsWith(".displaced.bak")),
      install.stderr.trim().split("\n")[0],
    );
  }

  // ---- upgrade and reinstall verify the recorded original first ---------------
  {
    const inst = await makeInstance(world);
    await i(B, "install", inst, { yes: true });
    const bak = (await listBackups(inst)).find((n) => n.endsWith(".original.bak"))!;
    const bakPath = `${inst}/${STATE}/backups/${bak}`;
    const record = `${inst}/${STATE}/installed/en_us.snbt.meta`;
    const recordText = await Deno.readTextFile(record);
    const bytes = await Deno.readFile(bakPath);
    const v2 = await newerBundle(world, "v2-verify");

    await Deno.writeFile(bakPath, bytes.subarray(0, bytes.length - 10));
    const before = await snapshot(inst);
    const truncated = await i(v2.dir, "install", inst, { yes: true });
    check(
      "an upgrade over a truncated original backup is refused with 13 before any write",
      truncated.code === 13 && await snapshot(inst) === before,
      truncated.stderr.trim().split("\n")[0],
    );

    await Deno.remove(bakPath);
    const missing = await i(v2.dir, "install", inst, { yes: true });
    check(
      "an upgrade with the original backup missing is refused with 13 and the target is untouched",
      missing.code === 13 && await sameBytes(`${inst}/${T}`, world.payload),
      missing.stderr.trim().split("\n")[0],
    );
    const edited = new Uint8Array([...world.payload, ...new TextEncoder().encode("// edit\n")]);
    await Deno.writeFile(`${inst}/${T}`, edited);
    const beforeForce = await snapshot(inst);
    const forced = await i(v2.dir, "install", inst, { yes: true, force: true });
    check(
      "a forced reinstall over an edit with the original missing is 13: no modified backup, no record change",
      forced.code === 13 && await snapshot(inst) === beforeForce &&
        await Deno.readTextFile(record) === recordText,
      forced.stderr.trim().split("\n")[0],
    );
    await Deno.writeFile(`${inst}/${T}`, world.payload);
    await Deno.writeFile(bakPath, bytes);
    const meta = `${bakPath}.meta`;
    const metaText = await Deno.readTextFile(meta);
    await Deno.writeTextFile(meta, metaText.replace(`target=${T}`, "target=config/x.snbt"));
    const wrongMeta = await i(v2.dir, "install", inst, { yes: true });
    check(
      "an upgrade whose original meta names another target is refused with 13",
      wrongMeta.code === 13 && await sameBytes(`${inst}/${T}`, world.payload),
      wrongMeta.stderr.trim().split("\n")[0],
    );
    await Deno.writeTextFile(meta, metaText);
    const ok = await i(v2.dir, "install", inst, { yes: true });
    check(
      "with the original back in place the same upgrade goes through",
      ok.code === 0 && await sameBytes(`${inst}/${T}`, v2.payload),
      ok.stderr.trim(),
    );
    const back = await i(B, "uninstall", inst, { yes: true });
    check(
      "and the original is restored byte for byte afterwards",
      back.code === 0 && await sameBytes(`${inst}/${T}`, world.english),
    );

    // Adoption (translation in place, no record, one original on disk) verifies that original too.
    await Deno.writeFile(`${inst}/${T}`, world.payload);
    await Deno.writeFile(bakPath, bytes.subarray(0, bytes.length - 10));
    const beforeAdopt = await snapshot(inst);
    const adopt = await i(B, "install", inst, { yes: true });
    check(
      "adopting a hand-restored translation over a truncated original is refused with 13, no record written",
      adopt.code === 13 && await snapshot(inst) === beforeAdopt && !(await exists(record)),
      adopt.stderr.trim().split("\n")[0],
    );
    const adoptUninstall = await i(B, "uninstall", inst, { yes: true });
    check(
      "and so is uninstalling it",
      adoptUninstall.code === 13 && await snapshot(inst) === beforeAdopt,
    );
  }

  // ---- the absent sentinel is verified the same way ---------------------------
  {
    const inst = await makeInstance(world, null);
    await i(B, "install", inst, { yes: true });
    const meta = `${inst}/${STATE}/backups/en_us.snbt.absent.meta`;
    const good = await Deno.readTextFile(meta);
    const v2 = await newerBundle(world, "v2-absent");
    const cases: [string, string | null][] = [
      ["kind=original", good.replace("kind=absent", "kind=original")],
      ["another target", good.replace(`target=${T}`, "target=config/ftbquests/quests/lang/x.snbt")],
      ["missing", null],
    ];
    for (const [label, text] of cases) {
      if (text === null) await Deno.remove(meta);
      else await Deno.writeTextFile(meta, text);
      const before = await snapshot(inst);
      const upgrade = await i(v2.dir, "install", inst, { yes: true });
      const uninstall = await i(B, "uninstall", inst, { yes: true, force: true });
      check(
        `an absent sentinel that is ${label} refuses upgrade and uninstall with 13, writing nothing`,
        upgrade.code === 13 && uninstall.code === 13 && await snapshot(inst) === before,
        `${upgrade.stderr.trim().split("\n")[0]} / ${uninstall.stderr.trim().split("\n")[0]}`,
      );
    }
    await Deno.writeTextFile(meta, good);
    const upgrade = await i(v2.dir, "install", inst, { yes: true });
    const back = await i(B, "uninstall", inst, { yes: true });
    check(
      "with the sentinel intact the upgrade goes through and uninstall removes the file",
      upgrade.code === 0 && back.code === 0 && !(await exists(`${inst}/${T}`)),
      `${upgrade.stderr.trim()} ${back.stderr.trim()}`,
    );
  }

  // ---- upgrade to a different payload of ours -------------------------------
  {
    const inst = await makeInstance(world);
    await i(B, "install", inst, { yes: true });
    const { dir: v2, payload: newPayload } = await newerBundle(world, "v2");
    const upgrade = await i(v2, "install", inst, { yes: true });
    check(
      "a newer bundle upgrades in place without a second original backup",
      upgrade.code === 0 && await sameBytes(`${inst}/${T}`, newPayload) &&
        (await listBackups(inst)).filter((n) => n.endsWith(".original.bak")).length === 1,
      upgrade.stderr.trim(),
    );
    // The install record is shared by every bundle of this tool, as it is for
    // the executable installer: the old bundle restores the original the
    // record names rather than refusing a file it did not write.
    const oldUninstall = await i(B, "uninstall", inst, { yes: true });
    check(
      "the old bundle uninstalls the newer install and restores the first original",
      oldUninstall.code === 0 && await sameBytes(`${inst}/${T}`, world.english),
      oldUninstall.stderr.trim(),
    );
    const again = await i(v2, "uninstall", inst, { yes: true });
    check("the newer bundle then finds nothing installed (14)", again.code === 14);
  }
}

async function main(): Promise<void> {
  const bundleZip = argument("--bundle-zip");
  const sourceArchive = argument("--source-archive");
  if (!bundleZip || !sourceArchive) {
    throw new Error(
      "usage: --bundle-zip <bundle>-scripts.zip --source-archive <pack>.zip [--pwsh <path>] [--sh <shell>] [--keep]",
    );
  }
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "mqt-scripts-e2e " });
  console.log(`workspace: ${root}`);

  const extractTo = `${root}/展開 先`;
  const unzipped = await run("unzip", ["-q", bundleZip, "-d", extractTo]);
  if (unzipped.code !== 0) throw new Error(unzipped.stderr);
  const dirs = await Array.fromAsync(Deno.readDir(extractTo));
  if (dirs.length !== 1) throw new Error("the bundle should extract to one top-level directory");
  const bundleDir = `${extractTo}/${dirs[0].name}`;
  const conf = parseInstallerConf(await Deno.readTextFile(`${bundleDir}/scripts/installer.conf`));
  const target = conf.payloads[0].path;
  const payload = await Deno.readFile(`${bundleDir}/payload/${target}`);

  const archive = await readZip(await Deno.readFile(sourceArchive));
  const sourceEntry = archive.entries.map((e) => e.path).find((p) =>
    p === `overrides/${target}` || p === target
  );
  if (!sourceEntry) throw new Error(`${sourceArchive} holds no ${target}`);
  const english = await archive.read(sourceEntry);
  engineLabel = "setup";
  check(
    "the source archive's quest file is the one installer.conf pins",
    await sha256Hex(english) === conf.payloads[0].sourceSha256,
  );
  check(
    "the payload is the one installer.conf pins",
    await sha256Hex(payload) === conf.payloads[0].sha256,
  );
  check(
    "the payload is not the pack's own file",
    await sha256Hex(payload) !== await sha256Hex(english),
  );
  check(
    "scripts carry their execute bit after unzip",
    (((await Deno.stat(`${bundleDir}/scripts/mqt-installer.sh`)).mode ?? 0) & 0o111) !== 0,
  );
  const ps1 = await Deno.readFile(`${bundleDir}/scripts/mqt-installer.ps1`);
  check(
    "the PowerShell script starts with a UTF-8 BOM",
    ps1[0] === 0xef && ps1[1] === 0xbb && ps1[2] === 0xbf,
  );

  const world: World = { root, bundleDir, bundleZip, target, payload, english, counter: 0 };

  const shells = argument("--sh") ? [argument("--sh")!] : ["dash", "bash"];
  for (const sh of shells) {
    if ((await run(sh, ["-c", "true"])).code !== 0) {
      console.log(`skipping ${sh}: not runnable here`);
      continue;
    }
    await scenarios(shEngine(sh), world);
  }

  const pwsh = argument("--pwsh") ?? "pwsh";
  const probe = await run(pwsh, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"])
    .catch(() => null);
  if (probe && probe.code === 0) {
    console.log(
      `\npwsh ${probe.stdout.trim()} found at ${pwsh}: running the PowerShell script on Linux (not Windows PowerShell 5.1, not Windows)`,
    );
    await scenarios(pwshEngine(pwsh), world);
  } else {
    console.log("\nno pwsh available: the PowerShell script was not executed");
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  for (const entry of failed) {
    console.error(`FAILED: ${entry.name}${entry.detail ? ` -- ${entry.detail}` : ""}`);
  }
  if (Deno.args.includes("--keep")) console.log(`workspace kept at ${root}`);
  else await Deno.remove(root, { recursive: true });
  if (failed.length > 0) Deno.exit(1);
}

await main();
