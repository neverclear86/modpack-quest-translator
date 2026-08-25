import { assertEquals, assertRejects } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { install, status, uninstall } from "../src/installer/operations.ts";
import {
  fakeClock,
  type Fixture,
  JAPANESE,
  makeFixture,
  TARGET_RELATIVE,
} from "./helpers/installer_fixture.ts";

function context(fixture: Fixture) {
  return {
    bundleDir: fixture.bundleDir,
    instanceInput: fixture.instanceRoot,
    force: false,
    now: fakeClock(),
  };
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await makeFixture();
  try {
    await fn(fixture);
  } finally {
    await fixture.cleanup();
  }
}

Deno.test("status on an untouched instance reports nothing installed", async () => {
  await withFixture(async (fixture) => {
    const result = await status(context(fixture));
    assertEquals(result.targets[0].relativePath, TARGET_RELATIVE);
    assertEquals(result.targets[0].present, true);
    assertEquals(result.targets[0].matchesBundle, false);
    assertEquals(result.targets[0].recordedBundleId, undefined);
    assertEquals(result.targets[0].restorableFrom, undefined);
  });
});

Deno.test("status after install reports the bundle and a restorable backup", async () => {
  await withFixture(async (fixture) => {
    await install(context(fixture));
    const result = await status(context(fixture));
    assertEquals(result.targets[0].matchesBundle, true);
    assertEquals(result.targets[0].modified, false);
    assertEquals(result.targets[0].recordedBundleId, fixture.bundleId);
    assertEquals(typeof result.targets[0].restorableFrom, "string");
    assertEquals(result.targets[0].originalWasAbsent, false);
  });
});

Deno.test("status notices an edited install without changing anything", async () => {
  await withFixture(async (fixture) => {
    await install(context(fixture));
    const edited = `${JAPANESE}// note\n`;
    await Deno.writeTextFile(fixture.targetPath, edited);

    const result = await status(context(fixture));
    assertEquals(result.targets[0].matchesBundle, false);
    assertEquals(result.targets[0].modified, true);
    assertEquals(await fixture.read(), edited);
  });
});

Deno.test("status after uninstall reports the install gone but the backup kept", async () => {
  await withFixture(async (fixture) => {
    await install(context(fixture));
    await uninstall(context(fixture));
    const result = await status(context(fixture));
    assertEquals(result.targets[0].recordedBundleId, undefined);
    assertEquals(result.targets[0].matchesBundle, false);
    assertEquals(typeof result.targets[0].restorableFrom, "string");
  });
});

Deno.test("status refuses a directory that is not an instance", async () => {
  await withFixture(async (fixture) => {
    await Deno.remove(`${fixture.instanceRoot}/config`, { recursive: true });
    const error = await assertRejects(() => status(context(fixture)), AppError);
    assertEquals(error.code, "E_INSTANCE");
  });
});
