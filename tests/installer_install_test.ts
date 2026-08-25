import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { INSTALLER_DIR } from "../src/installer/backup.ts";
import { install } from "../src/installer/operations.ts";
import { loadState } from "../src/installer/state.ts";
import { sha256Hex } from "../src/util/hash.ts";
import {
  ENGLISH,
  fakeClock,
  type Fixture,
  JAPANESE,
  makeFixture,
  TARGET_RELATIVE,
} from "./helpers/installer_fixture.ts";

async function run(
  fixture: Fixture,
  options: { bundleDir?: string; force?: boolean; now?: () => Date } = {},
) {
  return await install({
    bundleDir: options.bundleDir ?? fixture.bundleDir,
    instanceInput: fixture.instanceRoot,
    force: options.force ?? false,
    now: options.now ?? fakeClock(),
  });
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

async function backupsIn(fixture: Fixture): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (
      const entry of Deno.readDir(`${fixture.instanceRoot}/${INSTALLER_DIR}/backups`)
    ) {
      if (entry.name.endsWith(".bak")) names.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.sort();
}

async function stateOf(fixture: Fixture) {
  return (await loadState(`${fixture.instanceRoot}/${INSTALLER_DIR}`)).state;
}

Deno.test("a first install replaces the file and preserves the exact original", async () => {
  await withFixture(async (fixture) => {
    const result = await run(fixture);
    assertEquals(result.targets[0].status, "installed");
    assertEquals(await fixture.read(), JAPANESE);

    const backups = await backupsIn(fixture);
    assertEquals(backups.length, 1);
    assertEquals(
      await Deno.readTextFile(`${fixture.instanceRoot}/${INSTALLER_DIR}/backups/${backups[0]}`),
      ENGLISH,
    );

    const state = await stateOf(fixture);
    const record = state.installs[TARGET_RELATIVE];
    assertEquals(record.installedSha256, await sha256Hex(JAPANESE));
    assertEquals(record.originalSha256, await sha256Hex(ENGLISH));
    assertEquals(record.originalWasAbsent, false);
    assertEquals(record.originalBackup, `backups/${backups[0]}`);
  });
});

Deno.test("reinstalling the same bundle is idempotent and never re-backs-up", async () => {
  await withFixture(async (fixture) => {
    await run(fixture);
    const before = await backupsIn(fixture);

    const second = await run(fixture);
    assertEquals(second.targets[0].status, "already-installed");
    assertEquals(second.targets[0].backup, undefined);
    assertEquals(await fixture.read(), JAPANESE);
    assertEquals(await backupsIn(fixture), before);

    // The load-bearing assertion: the backup still holds English, not Japanese.
    assertEquals(
      await Deno.readTextFile(`${fixture.instanceRoot}/${INSTALLER_DIR}/backups/${before[0]}`),
      ENGLISH,
    );
  });
});

Deno.test("reinstalling with --force rewrites the same bytes and still takes no backup", async () => {
  await withFixture(async (fixture) => {
    await run(fixture);
    const before = await backupsIn(fixture);
    const forced = await run(fixture, { force: true });
    assertEquals(forced.targets[0].status, "reinstalled");
    assertEquals(await backupsIn(fixture), before);
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("a newer overlay upgrades in place without touching the original backup", async () => {
  await withFixture(async (fixture) => {
    await run(fixture);
    const before = await backupsIn(fixture);
    const originalPointer = (await stateOf(fixture)).installs[TARGET_RELATIVE].originalBackup;

    const updated = '{ quest.title: "空の冒険 2" }\n';
    const newer = await fixture.addBundle("bundle-2.5", { payload: updated });
    const result = await run(fixture, { bundleDir: newer });

    assertEquals(result.targets[0].status, "upgraded");
    assertEquals(await fixture.read(), updated);
    assertEquals(await backupsIn(fixture), before);
    const record = (await stateOf(fixture)).installs[TARGET_RELATIVE];
    assertEquals(record.originalBackup, originalPointer);
    assertEquals(record.originalSha256, await sha256Hex(ENGLISH));
  });
});

Deno.test("installing where no quest lang file exists records an absent sentinel", async () => {
  await withFixture(async (fixture) => {
    const result = await run(fixture);
    assertEquals(result.targets[0].status, "installed");
    assertEquals(result.targets[0].backup?.kind, "absent");
    assertEquals(await fixture.read(), JAPANESE);
    const record = (await stateOf(fixture)).installs[TARGET_RELATIVE];
    assertEquals(record.originalWasAbsent, true);
  }, { existing: null });
});

Deno.test("an interrupted run finishes without capturing a second backup", async () => {
  await withFixture(async (fixture) => {
    // A crash between capturing the backup and writing the payload: the backup
    // exists, the original is still in place, state.json was never written.
    await run(fixture);
    const backups = await backupsIn(fixture);
    await Deno.remove(`${fixture.instanceRoot}/${INSTALLER_DIR}/state.json`);
    await Deno.writeTextFile(fixture.targetPath, ENGLISH);

    const result = await run(fixture);
    assertEquals(result.targets[0].status, "installed");
    // The file was byte-for-byte the backup we already hold, so it is the
    // original -- not something to capture again, and not a modification.
    assertEquals(result.targets[0].backup, undefined);
    assertEquals(await backupsIn(fixture), backups);
    assertEquals(await fixture.read(), JAPANESE);
    assertEquals(
      (await stateOf(fixture)).installs[TARGET_RELATIVE].originalSha256,
      await sha256Hex(ENGLISH),
    );
  });
});

Deno.test("an install we never recorded is repaired rather than re-backed-up", async () => {
  await withFixture(async (fixture) => {
    await run(fixture);
    const backups = await backupsIn(fixture);
    await Deno.remove(`${fixture.instanceRoot}/${INSTALLER_DIR}/state.json`);

    const result = await run(fixture);
    assertEquals(result.targets[0].status, "already-installed");
    assertEquals(await backupsIn(fixture), backups);
    // The recovered record points back at the original English backup.
    const record = (await stateOf(fixture)).installs[TARGET_RELATIVE];
    assertEquals(record.originalSha256, await sha256Hex(ENGLISH));
  });
});

Deno.test("installing over our own edited file is refused, and --force keeps the edit", async () => {
  await withFixture(async (fixture) => {
    await run(fixture);
    const edited = `${JAPANESE}// my own note\n`;
    await Deno.writeTextFile(fixture.targetPath, edited);

    const error = await assertRejects(() => run(fixture), AppError);
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertStringIncludes(error.hint ?? "", "--force");
    assertEquals(await fixture.read(), edited);

    const result = await run(fixture, { force: true });
    assertEquals(result.targets[0].backup?.kind, "modified-install");
    assertEquals(await fixture.read(), JAPANESE);

    // The edit was preserved, and so was the English original.
    const texts = await Promise.all(
      (await backupsIn(fixture)).map((name) =>
        Deno.readTextFile(`${fixture.instanceRoot}/${INSTALLER_DIR}/backups/${name}`)
      ),
    );
    assertEquals(texts.sort(), [edited, ENGLISH].sort());
  });
});

Deno.test("a tampered bundle is refused before the instance is touched", async () => {
  await withFixture(async (fixture) => {
    await Deno.writeTextFile(
      `${fixture.bundleDir}/payload/${TARGET_RELATIVE}`,
      JAPANESE.replace("冒険", "危険"),
    );
    const error = await assertRejects(() => run(fixture), AppError);
    assertEquals(error.code, "E_BUNDLE");
    assertEquals(await fixture.read(), ENGLISH);
    assertEquals(await backupsIn(fixture), []);
    assertStringIncludes(error.hint ?? "", "download it again");
  });
});

Deno.test("--force does not override a tampered bundle", async () => {
  await withFixture(async (fixture) => {
    await Deno.writeTextFile(
      `${fixture.bundleDir}/payload/${TARGET_RELATIVE}`,
      "not the payload\n",
    );
    const error = await assertRejects(() => run(fixture, { force: true }), AppError);
    assertEquals(error.code, "E_BUNDLE");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("a directory that is not an instance is refused before any write", async () => {
  await withFixture(async (fixture) => {
    await Deno.remove(`${fixture.instanceRoot}/mods`, { recursive: true });
    const error = await assertRejects(() => run(fixture), AppError);
    assertEquals(error.code, "E_INSTANCE");
    assertEquals(await fixture.read(), ENGLISH);
    assertEquals(await backupsIn(fixture), []);
  });
});

Deno.test("the installed bytes are exactly the payload bytes", async () => {
  const payload = "空の冒険\r\nCRLF と\ttab と 末尾スペース \n";
  await withFixture(async (fixture) => {
    await run(fixture);
    assertEquals(await Deno.readFile(fixture.targetPath), new TextEncoder().encode(payload));
  }, { payload });
});

Deno.test("nothing is written outside the instance and the bundle", async () => {
  await withFixture(async (fixture) => {
    await run(fixture);
    const names: string[] = [];
    for await (const entry of Deno.readDir(fixture.dir)) names.push(entry.name);
    assertEquals(names.sort(), ["bundle", "インスタンス フォルダ"].sort());
  });
});

Deno.test("a second install after an upgrade still restores to the first original", async () => {
  await withFixture(async (fixture) => {
    await run(fixture);
    const newer = await fixture.addBundle("bundle-2.5", { payload: '{ a: "二" }\n' });
    await run(fixture, { bundleDir: newer });
    const newest = await fixture.addBundle("bundle-2.6", { payload: '{ a: "三" }\n' });
    await run(fixture, { bundleDir: newest });

    assertEquals((await backupsIn(fixture)).length, 1);
    const record = (await stateOf(fixture)).installs[TARGET_RELATIVE];
    assertEquals(record.originalSha256, await sha256Hex(ENGLISH));
    assertNotEquals(record.installedSha256, await sha256Hex(ENGLISH));
  });
});
