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
