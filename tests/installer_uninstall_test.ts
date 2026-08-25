import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { INSTALLER_DIR } from "../src/installer/backup.ts";
import { install, uninstall } from "../src/installer/operations.ts";
import { loadState } from "../src/installer/state.ts";
import {
  ENGLISH,
  fakeClock,
  type Fixture,
  JAPANESE,
  makeFixture,
  TARGET_RELATIVE,
} from "./helpers/installer_fixture.ts";

function context(fixture: Fixture, force = false) {
  return {
    bundleDir: fixture.bundleDir,
    instanceInput: fixture.instanceRoot,
    force,
    now: fakeClock(),
  };
}

async function withInstalled(
  fn: (fixture: Fixture) => Promise<void>,
  options: Parameters<typeof makeFixture>[0] = {},
): Promise<void> {
  const fixture = await makeFixture(options);
  try {
    await install(context(fixture));
    await fn(fixture);
  } finally {
    await fixture.cleanup();
  }
}

async function backupsIn(fixture: Fixture): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${fixture.instanceRoot}/${INSTALLER_DIR}/backups`)) {
      if (entry.name.endsWith(".bak")) names.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.sort();
}

Deno.test("uninstall restores the exact original bytes", async () => {
  await withInstalled(async (fixture) => {
    const result = await uninstall(context(fixture));
    assertEquals(result.targets[0].status, "restored");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("the backup survives the restore, so it can be done again", async () => {
  await withInstalled(async (fixture) => {
    const before = await backupsIn(fixture);
    await uninstall(context(fixture));
    assertEquals(await backupsIn(fixture), before);

    // Install, uninstall, install, uninstall all end at the same English bytes.
    await install(context(fixture));
    assertEquals(await fixture.read(), JAPANESE);
    await uninstall(context(fixture));
    assertEquals(await fixture.read(), ENGLISH);
    assertEquals(await backupsIn(fixture), before);
  });
});

Deno.test("uninstalling twice reports that nothing of ours is installed", async () => {
  await withInstalled(async (fixture) => {
    await uninstall(context(fixture));
    const error = await assertRejects(() => uninstall(context(fixture)), AppError);
    assertEquals(error.code, "E_NOT_INSTALLED");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("uninstalling from an instance we never touched is E_NOT_INSTALLED", async () => {
  const fixture = await makeFixture();
  try {
    const error = await assertRejects(() => uninstall(context(fixture)), AppError);
    assertEquals(error.code, "E_NOT_INSTALLED");
    assertEquals(await fixture.read(), ENGLISH);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("an absent sentinel restores by deleting, leaving directories alone", async () => {
  await withInstalled(async (fixture) => {
    const result = await uninstall(context(fixture));
    assertEquals(result.targets[0].status, "deleted");
    assertEquals(await fixture.read(), null);
    const langDir = await Deno.stat(`${fixture.instanceRoot}/config/ftbquests/quests/lang`);
    assertEquals(langDir.isDirectory, true);
  }, { existing: null });
});

Deno.test("an edited installed file is not clobbered without --force", async () => {
  await withInstalled(async (fixture) => {
    const edited = `${JAPANESE}// my own note\n`;
    await Deno.writeTextFile(fixture.targetPath, edited);

    const error = await assertRejects(() => uninstall(context(fixture)), AppError);
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertStringIncludes(error.hint ?? "", "--force");
    assertEquals(await fixture.read(), edited);
    assertEquals((await backupsIn(fixture)).length, 1);
  });
});

Deno.test("--force keeps the edit as a backup before restoring the original", async () => {
  await withInstalled(async (fixture) => {
    const edited = `${JAPANESE}// my own note\n`;
    await Deno.writeTextFile(fixture.targetPath, edited);

    const result = await uninstall(context(fixture, true));
    assertEquals(result.targets[0].status, "restored");
    assertEquals(result.targets[0].keptModifiedAs !== undefined, true);
    assertEquals(await fixture.read(), ENGLISH);

    const texts = await Promise.all(
      (await backupsIn(fixture)).map((name) =>
        Deno.readTextFile(`${fixture.instanceRoot}/${INSTALLER_DIR}/backups/${name}`)
      ),
    );
    assertEquals(texts.sort(), [edited, ENGLISH].sort());
  });
});

Deno.test("a deleted backup is an actionable error and nothing is written", async () => {
  await withInstalled(async (fixture) => {
    for (const name of await backupsIn(fixture)) {
      await Deno.remove(`${fixture.instanceRoot}/${INSTALLER_DIR}/backups/${name}`);
    }
    const error = await assertRejects(() => uninstall(context(fixture)), AppError);
    assertEquals(error.code, "E_BACKUP");
    assertStringIncludes(error.message, "missing");
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("a truncated backup is refused rather than restored", async () => {
  await withInstalled(async (fixture) => {
    for (const name of await backupsIn(fixture)) {
      await Deno.writeTextFile(
        `${fixture.instanceRoot}/${INSTALLER_DIR}/backups/${name}`,
        ENGLISH.slice(0, 5),
      );
    }
    const error = await assertRejects(() => uninstall(context(fixture)), AppError);
    assertEquals(error.code, "E_BACKUP");
    assertStringIncludes(error.message, "bytes");
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("--force does not restore from a corrupt backup", async () => {
  await withInstalled(async (fixture) => {
    for (const name of await backupsIn(fixture)) {
      await Deno.writeTextFile(
        `${fixture.instanceRoot}/${INSTALLER_DIR}/backups/${name}`,
        ENGLISH.replace("Skyward", "Skywerd"),
      );
    }
    const error = await assertRejects(() => uninstall(context(fixture, true)), AppError);
    assertEquals(error.code, "E_BACKUP");
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("uninstall works from the sidecars alone when state.json is gone", async () => {
  await withInstalled(async (fixture) => {
    await Deno.remove(`${fixture.instanceRoot}/${INSTALLER_DIR}/state.json`);
    const result = await uninstall(context(fixture));
    assertEquals(result.targets[0].status, "restored");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("a renamed backup is still found by the digest the record holds", async () => {
  await withInstalled(async (fixture) => {
    const installerDir = `${fixture.instanceRoot}/${INSTALLER_DIR}`;
    const state = (await loadState(installerDir)).state;
    state.installs[TARGET_RELATIVE].originalBackup = "backups/does-not-exist.bak";
    await Deno.writeTextFile(
      `${installerDir}/state.json`,
      JSON.stringify(state, null, 2),
    );
    // The path is dangling, but originalSha256 still names the exact bytes, and
    // a backup holding exactly those bytes restores an identical file whichever
    // copy it is read from. That is not a lineage guess.
    const result = await uninstall(context(fixture));
    assertEquals(result.targets[0].status, "restored");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("a record whose original cannot be matched at all is E_BACKUP", async () => {
  await withInstalled(async (fixture) => {
    const installerDir = `${fixture.instanceRoot}/${INSTALLER_DIR}`;
    const state = (await loadState(installerDir)).state;
    state.installs[TARGET_RELATIVE].originalBackup = "backups/does-not-exist.bak";
    state.installs[TARGET_RELATIVE].originalSha256 = "f".repeat(64);
    await Deno.writeTextFile(`${installerDir}/state.json`, JSON.stringify(state, null, 2));

    const error = await assertRejects(() => uninstall(context(fixture)), AppError);
    assertEquals(error.code, "E_BACKUP");
    assertStringIncludes(error.message, "missing");
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("uninstall clears the install record but keeps the history", async () => {
  await withInstalled(async (fixture) => {
    await uninstall(context(fixture));
    const state = (await loadState(`${fixture.instanceRoot}/${INSTALLER_DIR}`)).state;
    assertEquals(state.installs[TARGET_RELATIVE], undefined);
    assertEquals(state.history.some((event) => event.event === "uninstall"), true);
    assertEquals(state.history.some((event) => event.event === "install"), true);
  });
});

Deno.test("uninstall refuses a bundle that is not for this instance's install", async () => {
  await withInstalled(async (fixture) => {
    // A completely different bundle whose payload was never installed here.
    const other = await fixture.addBundle("other", { payload: '{ a: "別物" }\n' });
    await uninstall(context(fixture));
    const error = await assertRejects(
      () => uninstall({ ...context(fixture), bundleDir: other }),
      AppError,
    );
    assertEquals(error.code, "E_NOT_INSTALLED");
  });
});

Deno.test("--force writes nothing at all when no backup can be restored", async () => {
  await withInstalled(async (fixture) => {
    const edited = `${JAPANESE}// my own note\n`;
    await Deno.writeTextFile(fixture.targetPath, edited);
    for (const name of await backupsIn(fixture)) {
      await Deno.remove(`${fixture.instanceRoot}/${INSTALLER_DIR}/backups/${name}`);
    }
    const error = await assertRejects(() => uninstall(context(fixture, true)), AppError);
    assertEquals(error.code, "E_BACKUP");
    // Not even the user's edit was captured: the run is a no-op.
    assertEquals(await backupsIn(fixture), []);
    assertEquals(await fixture.read(), edited);
  });
});

Deno.test("a refusal on one target leaves every other target untouched", async () => {
  // A bundle can carry more than one quest lang file, and uninstall must be
  // all-or-nothing across them: restoring the first and then refusing on the
  // second would leave the instance in a state neither the player nor a later
  // run asked for.
  const other = "config/ftbquests/quests/lang/ja_jp.snbt";
  const fixture = await makeFixture({
    payloads: { [TARGET_RELATIVE]: JAPANESE, [other]: '{ quest.title: "第二章" }\n' },
  });
  try {
    await Deno.writeTextFile(
      `${fixture.instanceRoot}/${other}`,
      '{ quest.title: "Chapter Two" }\n',
    );
    await install(context(fixture));

    // The player edited the second installed file, but not the first.
    await Deno.writeTextFile(
      `${fixture.instanceRoot}/${other}`,
      '{ quest.title: "私の書き換え" }\n',
    );

    const error = await assertRejects(() => uninstall(context(fixture)), AppError);
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertEquals(await fixture.read(), JAPANESE);
    assertEquals(
      await Deno.readTextFile(`${fixture.instanceRoot}/${other}`),
      '{ quest.title: "私の書き換え" }\n',
    );
  } finally {
    await fixture.cleanup();
  }
});
