/**
 * A retained backup is not an installation.
 *
 * Backups are kept forever, on purpose: uninstalling twice has to be safe. But
 * a backup left behind by an install that has already been undone says nothing
 * about the file that is there *now*. If the modpack updates its own English
 * quest file in between, the next install has to treat that file as the new
 * original -- not as "someone edited our translation", and certainly not as
 * something to be rolled back to a version of the pack the player no longer
 * runs.
 */
import { assertEquals } from "@std/assert";
import { install, uninstall } from "../src/installer/operations.ts";
import {
  ENGLISH,
  type Fixture,
  JAPANESE,
  makeFixture,
  TARGET_RELATIVE,
} from "./helpers/installer_fixture.ts";

/** What the pack ships after the player updates it. */
const PACK_UPDATE_ENGLISH = '{ quest.title: "Skyward Adventure", quest.subtitle: "Reforged" }\n';

/** One clock for a whole scenario, so backups order the way real ones do. */
function scenarioClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 25, 14, 22, 33) + tick++ * 60_000);
}

async function withFixture(
  fn: (fixture: Fixture, now: () => Date) => Promise<void>,
  options: Parameters<typeof makeFixture>[0] = {},
): Promise<void> {
  const fixture = await makeFixture(options);
  const now = scenarioClock();
  try {
    await fn(fixture, now);
  } finally {
    await fixture.cleanup();
  }
}

function context(fixture: Fixture, now: () => Date, force = false) {
  return { bundleDir: fixture.bundleDir, instanceInput: fixture.instanceRoot, force, now };
}

for (const force of [false, true]) {
  const flow = force ? "--force" : "the normal flow";

  Deno.test(`${flow}: a pack that adds an English file after an absent install keeps it`, async () => {
    await withFixture(async (fixture, now) => {
      await install(context(fixture, now));
      await uninstall(context(fixture, now));
      assertEquals(await fixture.read(), null);

      // The player updates the modpack, which now ships a quest lang file.
      await Deno.mkdir(`${fixture.instanceRoot}/config/ftbquests/quests/lang`, { recursive: true });
      await Deno.writeTextFile(fixture.targetPath, PACK_UPDATE_ENGLISH);

      const installed = await install(context(fixture, now, force));
      assertEquals(installed.targets[0].backup?.kind, "original");
      assertEquals(await fixture.read(), JAPANESE);

      const removed = await uninstall(context(fixture, now, force));
      assertEquals(removed.targets[0].status, "restored");
      assertEquals(await fixture.read(), PACK_UPDATE_ENGLISH);
    }, { existing: null });
  });

  Deno.test(`${flow}: a pack that updates its English file after an uninstall keeps it`, async () => {
    await withFixture(async (fixture, now) => {
      await install(context(fixture, now));
      await uninstall(context(fixture, now));
      assertEquals(await fixture.read(), ENGLISH);

      // The player updates the modpack, which rewrites the quest lang file.
      await Deno.writeTextFile(fixture.targetPath, PACK_UPDATE_ENGLISH);

      const installed = await install(context(fixture, now, force));
      assertEquals(installed.targets[0].backup?.kind, "original");
      assertEquals(await fixture.read(), JAPANESE);

      const removed = await uninstall(context(fixture, now, force));
      assertEquals(removed.targets[0].status, "restored");
      assertEquals(await fixture.read(), PACK_UPDATE_ENGLISH);
    });
  });
}

Deno.test("the newer original is what a later uninstall restores, byte for byte", async () => {
  await withFixture(async (fixture, now) => {
    await install(context(fixture, now));
    await uninstall(context(fixture, now));
    await Deno.writeTextFile(fixture.targetPath, PACK_UPDATE_ENGLISH);
    await install(context(fixture, now));

    // Both originals are still on disk; only the current one may be restored.
    const state = JSON.parse(
      await Deno.readTextFile(`${fixture.instanceRoot}/.mqt-installer/state.json`),
    );
    const record = state.installs[TARGET_RELATIVE];
    const pointed = await Deno.readTextFile(
      `${fixture.instanceRoot}/.mqt-installer/${record.originalBackup}`,
    );
    assertEquals(pointed, PACK_UPDATE_ENGLISH);
    assertEquals(record.originalWasAbsent, false);

    await uninstall(context(fixture, now));
    assertEquals(await fixture.read(), PACK_UPDATE_ENGLISH);
  });
});
