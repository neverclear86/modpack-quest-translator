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
import { install, type InterludeStage, uninstall } from "../src/installer/operations.ts";
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
