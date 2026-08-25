/**
 * The file is read once, classified, backed up -- and only then replaced. Every
 * step in between is a window in which Minecraft, a sync client, an editor or
 * the modpack's own updater can rewrite `en_us.snbt`, and overwriting the newer
 * file with a payload chosen for the older one loses whatever it said.
 *
 * So the target is proved unchanged again at each destructive boundary: after
 * the backup is captured, before the replacement, and once more immediately
 * before the rename that publishes it. The same re-walk catches a parent
 * directory swapped for a symlink after the plan was made.
 *
 * The races are injected through `interlude`, because a race that is not
 * deterministic is a test that passes by luck.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { INSTALLER_DIR } from "../src/installer/backup.ts";
import { install, type InterludeStage, status, uninstall } from "../src/installer/operations.ts";
import { type Durability, durabilityFor } from "../src/util/durable.ts";
import { basenameOf, dirnameOf } from "../src/util/fs.ts";
import {
  ENGLISH,
  fakeClock,
  type Fixture,
  JAPANESE,
  makeFixture,
  TARGET_RELATIVE,
} from "./helpers/installer_fixture.ts";

/** What the concurrent writer puts there while the installer is working. */
const NEWER = '{ quest.title: "Skyward Adventure", quest.note: "hotfix" }\n';

const OTHER = "config/ftbquests/quests/lang/zz_zz.snbt";
const OTHER_ENGLISH = '{ quest.title: "Chapter Two" }\n';
const OTHER_JAPANESE = '{ quest.title: "第二章" }\n';

interface Options {
  force?: boolean;
  durability?: Durability;
  interlude?: (stage: InterludeStage, target: string) => Promise<void>;
}

function context(fixture: Fixture, options: Options = {}) {
  return {
    bundleDir: fixture.bundleDir,
    instanceInput: fixture.instanceRoot,
    force: options.force ?? false,
    now: fakeClock(),
    ...(options.durability ? { durability: options.durability } : {}),
    ...(options.interlude ? { interlude: options.interlude } : {}),
  };
}

/** Rewrites the target once, the first time the named stage is reached. */
function racerAt(fixture: Fixture, stage: InterludeStage, bytes = NEWER) {
  let done = false;
  return async (reached: InterludeStage) => {
    if (done || reached !== stage) return;
    done = true;
    await Deno.mkdir(dirnameOf(fixture.targetPath), { recursive: true });
    await Deno.writeTextFile(fixture.targetPath, bytes);
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

for (const stage of ["after-capture", "before-replace"] as const) {
  Deno.test(`install: a target rewritten ${stage} keeps the newer bytes`, async () => {
    await withFixture(async (fixture) => {
      const error = await assertRejects(
        () => install(context(fixture, { interlude: racerAt(fixture, stage) })),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
      assertEquals(await fixture.read(), NEWER);
    });
  });

  Deno.test(`install --force: a target rewritten ${stage} keeps the newer bytes`, async () => {
    await withFixture(async (fixture) => {
      const error = await assertRejects(
        () => install(context(fixture, { force: true, interlude: racerAt(fixture, stage) })),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
      assertEquals(await fixture.read(), NEWER);
    });
  });
}

Deno.test("install: a target created between the plan and the write is not overwritten", async () => {
  await withFixture(async (fixture) => {
    const error = await assertRejects(
      () => install(context(fixture, { interlude: racerAt(fixture, "after-capture") })),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertEquals(await fixture.read(), NEWER);
  }, { existing: null });
});

Deno.test("install: a parent swapped for a symlink after the plan is refused", async () => {
  await withFixture(async (fixture) => {
    const outside = `${fixture.dir}/outside`;
    await Deno.mkdir(outside, { recursive: true });
    const lang = `${fixture.instanceRoot}/config/ftbquests/quests/lang`;

    const error = await assertRejects(
      () =>
        install(context(fixture, {
          async interlude(stage) {
            if (stage !== "after-capture") return;
            await Deno.remove(lang, { recursive: true });
            await Deno.symlink(outside, lang);
          },
        })),
      AppError,
    );
    assertEquals(error.code, "E_INSTANCE");

    const outsideNames: string[] = [];
    for await (const entry of Deno.readDir(outside)) outsideNames.push(entry.name);
    assertEquals(outsideNames, []);
  });
});

Deno.test("uninstall: a target rewritten before the restore keeps the newer bytes", async () => {
  await withFixture(async (fixture) => {
    await install(context(fixture));
    const error = await assertRejects(
      () => uninstall(context(fixture, { interlude: racerAt(fixture, "before-replace") })),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertEquals(await fixture.read(), NEWER);
  });
});

Deno.test("uninstall: a target rewritten before the delete is not deleted", async () => {
  await withFixture(async (fixture) => {
    await install(context(fixture));
    const error = await assertRejects(
      () => uninstall(context(fixture, { interlude: racerAt(fixture, "before-replace") })),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertEquals(await fixture.read(), NEWER);
  }, { existing: null });
});

Deno.test("a restore that fails part-way puts back what it had already changed", async () => {
  // Uninstall is all-or-nothing across targets at plan time. A write that fails
  // half way through has to be all-or-nothing too, or the instance is left in a
  // state neither the player nor a later run asked for.
  const fixture = await makeFixture({
    payloads: { [TARGET_RELATIVE]: JAPANESE, [OTHER]: OTHER_JAPANESE },
  });
  try {
    await Deno.writeTextFile(`${fixture.instanceRoot}/${OTHER}`, OTHER_ENGLISH);
    await install(context(fixture));
    assertEquals(await fixture.read(), JAPANESE);

    // The second target's write fails; the first has already been restored.
    const real = durabilityFor("posix");
    const durability: Durability = {
      syncFile(file, path) {
        if (basenameOf(path).startsWith("zz_zz.snbt")) {
          return Promise.reject(new Deno.errors.NotSupported("no"));
        }
        return real.syncFile(file, path);
      },
      syncDirectory: (path) => real.syncDirectory(path),
    };

    const error = await assertRejects(() => uninstall(context(fixture, { durability })), AppError);
    assertEquals(error.code, "E_WRITE");

    // Both targets are back to how the run found them.
    assertEquals(await fixture.read(), JAPANESE);
    assertEquals(await Deno.readTextFile(`${fixture.instanceRoot}/${OTHER}`), OTHER_JAPANESE);

    // And the install is still on the books, so re-running finishes the job.
    const state = JSON.parse(
      await Deno.readTextFile(`${fixture.instanceRoot}/${INSTALLER_DIR}/state.json`),
    );
    assertEquals(Object.keys(state.installs).sort(), [TARGET_RELATIVE, OTHER].sort());

    await uninstall(context(fixture));
    assertEquals(await fixture.read(), ENGLISH);
    assertEquals(await Deno.readTextFile(`${fixture.instanceRoot}/${OTHER}`), OTHER_ENGLISH);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("an install that fails part-way puts back what it had already replaced", async () => {
  const fixture = await makeFixture({
    payloads: { [TARGET_RELATIVE]: JAPANESE, [OTHER]: OTHER_JAPANESE },
  });
  try {
    await Deno.writeTextFile(`${fixture.instanceRoot}/${OTHER}`, OTHER_ENGLISH);

    const real = durabilityFor("posix");
    const durability: Durability = {
      syncFile(file, path) {
        if (basenameOf(path).startsWith("zz_zz.snbt.")) {
          return Promise.reject(new Deno.errors.NotSupported("no"));
        }
        return real.syncFile(file, path);
      },
      syncDirectory: (path) => real.syncDirectory(path),
    };

    await assertRejects(() => install(context(fixture, { durability })), AppError);

    assertEquals(await fixture.read(), ENGLISH);
    assertEquals(await Deno.readTextFile(`${fixture.instanceRoot}/${OTHER}`), OTHER_ENGLISH);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * The last window of all: the target has been renamed aside and its name is
 * free, and the payload has not been published yet.
 *
 * A check followed by a rename cannot close this -- the check is over by the
 * time the rename runs. What closes it is publishing with an operation that
 * refuses to replace anything: whoever got there first keeps the name, and this
 * run finds out by being told no.
 */
const IN_GAP: InterludeStage = "in-gap";

/**
 * What a power cut leaves mid-transaction: the target renamed aside, and
 * nothing else done.
 *
 * Built by hand rather than by interrupting a run, because a run that survives
 * its own failure puts the file back on the way out. Only a process that dies
 * between two syscalls can leave this, and this is what recovery is for.
 */
async function interruptedMidTransaction(fixture: Fixture): Promise<string> {
  const staged = `${fixture.targetPath}.mqt-staged-0123abcd`;
  await Deno.rename(fixture.targetPath, staged);
  return staged;
}

async function stagedFilesIn(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.includes(".mqt-staged-")) names.push(`${directory}/${entry.name}`);
  }
  return names.sort();
}

async function backupTexts(fixture: Fixture): Promise<string[]> {
  const texts: string[] = [];
  const directory = `${fixture.instanceRoot}/${INSTALLER_DIR}/backups`;
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.endsWith(".bak")) {
      texts.push(await Deno.readTextFile(`${directory}/${entry.name}`));
    }
  }
  return texts.sort();
}

for (const force of [false, true]) {
  const flow = force ? "install --force" : "install";

  Deno.test(`${flow}: a file published into the final gap is kept, not overwritten`, async () => {
    await withFixture(async (fixture) => {
      const error = await assertRejects(
        () => install(context(fixture, { force, interlude: racerAt(fixture, IN_GAP) })),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
      assertEquals(await fixture.read(), NEWER);
      // And the file this run had moved aside was not thrown away with it.
      assertEquals((await backupTexts(fixture)).includes(ENGLISH), true);
    });
  });
}

Deno.test("install: a file published into the final gap of a first install is kept", async () => {
  await withFixture(async (fixture) => {
    // Nothing was there when the plan was made, so there is nothing to move
    // aside and publishing no-replace is the whole transaction.
    const error = await assertRejects(
      () => install(context(fixture, { interlude: racerAt(fixture, IN_GAP) })),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertEquals(await fixture.read(), NEWER);
  }, { existing: null });
});

Deno.test("uninstall: a file published into the final gap of a restore is kept", async () => {
  await withFixture(async (fixture) => {
    await install(context(fixture));
    const error = await assertRejects(
      () => uninstall(context(fixture, { interlude: racerAt(fixture, IN_GAP) })),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertEquals(await fixture.read(), NEWER);
    // The installed payload this run had moved aside is preserved, not lost.
    assertEquals((await backupTexts(fixture)).includes(JAPANESE), true);
  });
});

Deno.test("uninstall: a file created in the final gap of a delete is not deleted", async () => {
  await withFixture(async (fixture) => {
    await install(context(fixture));
    // The delete has nothing to publish, so it cannot lose a race: it removes
    // the copy it captured under a private name, never the target's name.
    const result = await uninstall(context(fixture, { interlude: racerAt(fixture, IN_GAP) }));
    assertEquals(result.targets[0].status, "deleted");
    assertEquals(await fixture.read(), NEWER);
    assertEquals(
      result.warnings.some((warning) => warning.includes("recreated by something else")),
      true,
      JSON.stringify(result.warnings),
    );
  }, { existing: null });
});

Deno.test("a run killed inside the transaction is finished by the next one", async () => {
  await withFixture(async (fixture) => {
    const staged = await interruptedMidTransaction(fixture);
    assertEquals(await fixture.read(), null);
    assertEquals(await Deno.readTextFile(staged), ENGLISH);

    const result = await install(context(fixture));
    assertEquals(
      result.warnings.some((warning) => warning.includes("put back")),
      true,
      JSON.stringify(result.warnings),
    );
    assertEquals(await fixture.read(), JAPANESE);
    assertEquals(await stagedFilesIn(dirnameOf(fixture.targetPath)), []);

    // And the file the dead run had moved aside is the original a later
    // uninstall puts back, not something classified as somebody's edit.
    await uninstall(context(fixture));
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("a killed run whose target was taken since keeps the newer file", async () => {
  await withFixture(async (fixture) => {
    await interruptedMidTransaction(fixture);
    // Between the crash and the next run, the modpack's updater writes its own
    // file into the name the dead run had left free.
    await Deno.writeTextFile(fixture.targetPath, NEWER);

    const result = await install(context(fixture));
    assertEquals(
      result.warnings.some((warning) => warning.includes("created a file there")),
      true,
      JSON.stringify(result.warnings),
    );
    assertEquals(await fixture.read(), JAPANESE);
    assertEquals(await stagedFilesIn(dirnameOf(fixture.targetPath)), []);
    // The updater's file became the original; the older one was kept rather
    // than discarded.
    const backups = await backupTexts(fixture);
    assertEquals(backups.includes(ENGLISH), true, backups.join(" | "));
    assertEquals(backups.includes(NEWER), true, backups.join(" | "));

    await uninstall(context(fixture));
    assertEquals(await fixture.read(), NEWER);
  });
});

Deno.test("status reports an interrupted run without being the thing that finishes it", async () => {
  await withFixture(async (fixture) => {
    await install(context(fixture));
    const staged = await interruptedMidTransaction(fixture);

    const reported = await status(context(fixture));
    assertEquals(reported.targets[0].present, false);
    assertEquals(
      reported.warnings.some((warning) => warning.includes("moved aside")),
      true,
      JSON.stringify(reported.warnings),
    );
    // Reporting changed nothing.
    assertEquals(await Deno.readTextFile(staged), JAPANESE);
    assertEquals(await fixture.read(), null);
  });
});
