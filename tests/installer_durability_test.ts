/**
 * A backup that is not on the disk yet is not a backup.
 *
 * The install order is: capture the original, flush it, flush the directory
 * entry that names it, and only then replace the original. If any of those
 * cannot be established, the run has to stop *before* the replacement --
 * otherwise a power cut at the wrong moment leaves the instance holding the
 * translated file and nothing else, and the pack's own quest prose is gone.
 *
 * The flushes are injected so a filesystem that refuses one can be tested
 * without one.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { INSTALLER_DIR } from "../src/installer/backup.ts";
import { install, uninstall } from "../src/installer/operations.ts";
import { basenameOf } from "../src/util/fs.ts";
import { type Durability, durabilityFor } from "../src/util/durable.ts";
import {
  ENGLISH,
  fakeClock,
  type Fixture,
  JAPANESE,
  makeFixture,
} from "./helpers/installer_fixture.ts";

interface Recorder extends Durability {
  /** `file:<name>` and `dir:<name>`, in the order they were flushed. */
  readonly log: string[];
}

/** Wraps the real thing, so a passing test proves the real flushes happened. */
function recording(fail?: (kind: "file" | "dir", name: string) => boolean): Recorder {
  const real = durabilityFor("posix");
  const log: string[] = [];
  return {
    log,
    async syncFile(file, path) {
      const name = basenameOf(path);
      if (fail?.("file", name)) throw new Deno.errors.NotSupported(`refusing to flush ${name}`);
      await real.syncFile(file, path);
      log.push(`file:${name}`);
    },
    async syncDirectory(path) {
      const name = basenameOf(path);
      if (fail?.("dir", name)) throw new Deno.errors.NotSupported(`refusing to flush ${name}`);
      await real.syncDirectory(path);
      log.push(`dir:${name}`);
    },
  };
}

async function withFixture(
  fn: (fixture: Fixture) => Promise<void>,
  options: Parameters<typeof makeFixture>[0] = {},
): Promise<void> {
  const fixture = await makeFixture(options);
  try {
    await fn(fixture);
  } finally {
    await fixture.cleanup();
  }
}

function context(fixture: Fixture, durability: Durability, force = false) {
  return {
    bundleDir: fixture.bundleDir,
    instanceInput: fixture.instanceRoot,
    force,
    now: fakeClock(),
    durability,
  };
}

Deno.test("a backup whose bytes cannot be flushed never reaches the target", async () => {
  await withFixture(async (fixture) => {
    const durability = recording((kind, name) => kind === "file" && name.endsWith(".bak"));
    const error = await assertRejects(
      () => install(context(fixture, durability)),
      AppError,
    );
    assertEquals(error.code, "E_BACKUP");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("a sidecar that cannot be flushed never reaches the target", async () => {
  await withFixture(async (fixture) => {
    const durability = recording((kind, name) => kind === "file" && name.endsWith(".bak.json"));
    const error = await assertRejects(
      () => install(context(fixture, durability)),
      AppError,
    );
    assertEquals(error.code, "E_BACKUP");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("a backups directory that cannot be flushed never reaches the target", async () => {
  await withFixture(async (fixture) => {
    const durability = recording((kind, name) => kind === "dir" && name === "backups");
    const error = await assertRejects(
      () => install(context(fixture, durability)),
      AppError,
    );
    assertEquals(error.code, "E_BACKUP");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("a payload that cannot be flushed leaves the original in place", async () => {
  await withFixture(async (fixture) => {
    const durability = recording((kind, name) => kind === "file" && name.includes(".tmp"));
    const error = await assertRejects(
      () => install(context(fixture, durability)),
      AppError,
    );
    assertEquals(error.code, "E_WRITE");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("the backup and its directory are durable before the target is replaced", async () => {
  await withFixture(async (fixture) => {
    const durability = recording();
    await install(context(fixture, durability));
    assertEquals(await fixture.read(), JAPANESE);

    const log = durability.log;
    const backup = log.findIndex((entry) => entry.startsWith("file:") && entry.endsWith(".bak"));
    const sidecar = log.findIndex((entry) => entry.endsWith(".bak.json"));
    const backupsDir = log.indexOf("dir:backups");
    const langDir = log.indexOf("dir:lang");

    assertEquals(backup >= 0, true, `no backup flush in ${JSON.stringify(log)}`);
    assertEquals(sidecar > backup, true, `sidecar flushed before its backup: ${log}`);
    // The directory entry that names the backup has to be on disk before the
    // rename that replaces the original.
    assertEquals(backupsDir > sidecar, true, `backups/ flushed too early: ${log}`);
    assertEquals(langDir > backupsDir, true, `the target's directory flushed too early: ${log}`);
  });
});

Deno.test("a restore that cannot be flushed leaves the installed file in place", async () => {
  await withFixture(async (fixture) => {
    await install(context(fixture, durabilityFor("posix")));
    const durability = recording((kind, name) => kind === "file" && name.includes(".tmp"));

    const error = await assertRejects(
      () => uninstall(context(fixture, durability)),
      AppError,
    );
    assertEquals(error.code, "E_WRITE");
    assertEquals(await fixture.read(), JAPANESE);

    // The install record is untouched, so re-running finishes the job.
    const state = await Deno.readTextFile(`${fixture.instanceRoot}/${INSTALLER_DIR}/state.json`);
    assertEquals(state.includes("installs"), true);
    await uninstall(context(fixture, durabilityFor("posix")));
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("Windows has no directory flush, and says so rather than pretending", async () => {
  const windows = durabilityFor("windows");
  // NTFS journals directory metadata and there is no per-directory fsync to
  // call, so this is a documented no-op -- not a swallowed failure.
  await windows.syncDirectory("Z:\\nowhere\\at\\all");
});

Deno.test("a file flush failure is an error on both platforms", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqt-durable-" });
  try {
    const path = `${dir}/closed.txt`;
    const file = await Deno.open(path, { write: true, create: true });
    file.close();
    for (const os of ["posix", "windows"] as const) {
      const error = await assertRejects(() => durabilityFor(os).syncFile(file, path), AppError);
      assertEquals(error.code, "E_WRITE");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * The reviewer's sequence: a run that fails at the sidecar's flush, then a
 * re-run that finds the backup it left behind.
 *
 * The first run stops before the target is touched, which is right. What it
 * leaves on disk is a backup and a sidecar whose bytes reached the page cache
 * and nothing further. The second run verifies that backup by reading it --
 * through the same page cache -- finds it perfect, and reuses it. Reuse without
 * a fresh flush is the whole of the problem: the target gets replaced while its
 * only other copy is still one power cut away from never having existed.
 *
 * So every reused backup is re-established before it is trusted: its bytes, its
 * sidecar and the directory entries that name them.
 */
/** A run that gets the backup onto disk and then refuses to flush its sidecar. */
function leavesAnUnflushedBackup(): Recorder {
  return recording((kind, name) => kind === "file" && name.endsWith(".bak.json"));
}

Deno.test("a backup left unflushed by a failed run is re-synced before it is reused", async () => {
  await withFixture(async (fixture) => {
    const first = leavesAnUnflushedBackup();
    const failed = await assertRejects(() => install(context(fixture, first)), AppError);
    assertEquals(failed.code, "E_BACKUP");
    assertEquals(await fixture.read(), ENGLISH);
    assertEquals(first.log.includes("dir:backups"), false, "the directory was flushed anyway");

    // The second run finds the target still holding the original and a verified
    // backup of exactly those bytes, so it captures nothing new and adopts the
    // one that is there. That is the path the flush has to reach.
    const second = recording();
    const result = await install(context(fixture, second));
    assertEquals(result.targets[0].backup, undefined, "the second run captured a fresh backup");
    assertEquals(await fixture.read(), JAPANESE);

    const log = second.log;
    const backup = log.findIndex((entry) => entry.startsWith("file:") && entry.endsWith(".bak"));
    const sidecar = log.findIndex((entry) => entry.endsWith(".bak.json"));
    const backupsDir = log.indexOf("dir:backups");
    const langDir = log.indexOf("dir:lang");

    assertEquals(backup >= 0, true, `the reused backup was never re-flushed: ${log}`);
    assertEquals(sidecar >= 0, true, `the reused sidecar was never re-flushed: ${log}`);
    assertEquals(
      backupsDir > backup && backupsDir > sidecar,
      true,
      `backups/ was flushed before the files it names: ${log}`,
    );
    assertEquals(langDir > backupsDir, true, `the target was replaced too early: ${log}`);
  });
});

Deno.test("a reused backup that still cannot be flushed never reaches the target", async () => {
  await withFixture(async (fixture) => {
    const first = leavesAnUnflushedBackup();
    await assertRejects(() => install(context(fixture, first)), AppError);

    const second = leavesAnUnflushedBackup();
    const error = await assertRejects(() => install(context(fixture, second)), AppError);
    assertEquals(error.code, "E_BACKUP");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("a reused backup whose directory cannot be flushed never reaches the target", async () => {
  await withFixture(async (fixture) => {
    const first = leavesAnUnflushedBackup();
    await assertRejects(() => install(context(fixture, first)), AppError);

    const second = recording((kind, name) => kind === "dir" && name === "backups");
    const error = await assertRejects(() => install(context(fixture, second)), AppError);
    assertEquals(error.code, "E_BACKUP");
    assertEquals(await fixture.read(), ENGLISH);
  });
});
