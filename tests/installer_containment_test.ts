/**
 * The installer's own bookkeeping is inside the instance, or it does not
 * happen.
 *
 * `.mqt-installer/`, `backups/`, the backup files, their sidecars and
 * `state.json` all get the same treatment the quest target gets: every
 * component is `lstat`-ed, a symbolic link anywhere along the way is refused
 * rather than followed, and the deepest component that exists has to resolve
 * back inside the instance root. `--force` does not override any of it.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { INSTALLER_DIR } from "../src/installer/backup.ts";
import { install, status, uninstall } from "../src/installer/operations.ts";
import { ENGLISH, fakeClock, type Fixture, makeFixture } from "./helpers/installer_fixture.ts";

const CANARY = "do not touch\n";

interface Outside {
  dir: string;
  /** Everything that appeared outside the instance during the run. */
  contents(): Promise<string[]>;
}

async function withFixture(
  fn: (fixture: Fixture, outside: Outside) => Promise<void>,
  options: Parameters<typeof makeFixture>[0] = {},
): Promise<void> {
  const fixture = await makeFixture(options);
  const dir = `${fixture.dir}/outside`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/canary.txt`, CANARY);
  try {
    await fn(fixture, {
      dir,
      async contents() {
        const names: string[] = [];
        for await (const entry of Deno.readDir(dir)) names.push(entry.name);
        return names.sort();
      },
    });
  } finally {
    await fixture.cleanup();
  }
}

function context(fixture: Fixture, force = false) {
  return {
    bundleDir: fixture.bundleDir,
    instanceInput: fixture.instanceRoot,
    force,
    now: fakeClock(),
  };
}

for (const force of [false, true]) {
  const flow = force ? "--force" : "the normal flow";

  Deno.test(`${flow}: a symlinked .mqt-installer is refused, not followed`, async () => {
    await withFixture(async (fixture, outside) => {
      await Deno.symlink(outside.dir, `${fixture.instanceRoot}/${INSTALLER_DIR}`);

      const error = await assertRejects(() => install(context(fixture, force)), AppError);
      assertEquals(error.code, "E_INSTANCE");
      assertStringIncludes(error.message, "symbolic link");

      assertEquals(await fixture.read(), ENGLISH);
      assertEquals(await outside.contents(), ["canary.txt"]);
      assertEquals(await Deno.readTextFile(`${outside.dir}/canary.txt`), CANARY);
    });
  });

  Deno.test(`${flow}: a symlinked backups directory is refused, not followed`, async () => {
    await withFixture(async (fixture, outside) => {
      await Deno.mkdir(`${fixture.instanceRoot}/${INSTALLER_DIR}`, { recursive: true });
      await Deno.symlink(outside.dir, `${fixture.instanceRoot}/${INSTALLER_DIR}/backups`);

      const error = await assertRejects(() => install(context(fixture, force)), AppError);
      assertEquals(error.code, "E_INSTANCE");

      assertEquals(await fixture.read(), ENGLISH);
      assertEquals(await outside.contents(), ["canary.txt"]);
    });
  });

  Deno.test(`${flow}: a symlinked state.json is refused, not written through`, async () => {
    await withFixture(async (fixture, outside) => {
      await Deno.mkdir(`${fixture.instanceRoot}/${INSTALLER_DIR}`, { recursive: true });
      await Deno.symlink(
        `${outside.dir}/canary.txt`,
        `${fixture.instanceRoot}/${INSTALLER_DIR}/state.json`,
      );

      const error = await assertRejects(() => install(context(fixture, force)), AppError);
      assertEquals(error.code, "E_INSTANCE");

      assertEquals(await Deno.readTextFile(`${outside.dir}/canary.txt`), CANARY);
    });
  });
}

Deno.test("a symlinked backup file is not restored through", async () => {
  await withFixture(async (fixture, outside) => {
    await install(context(fixture));

    // Swap the captured original for a link at something outside the instance.
    const backups = `${fixture.instanceRoot}/${INSTALLER_DIR}/backups`;
    const name = [...Deno.readDirSync(backups)].map((e) => e.name).find((n) => n.endsWith(".bak"))!;
    await Deno.remove(`${backups}/${name}`);
    await Deno.symlink(`${outside.dir}/canary.txt`, `${backups}/${name}`);

    const error = await assertRejects(() => uninstall(context(fixture)), AppError);
    assertEquals(error.code, "E_BACKUP");
    assertEquals(await Deno.readTextFile(`${outside.dir}/canary.txt`), CANARY);
  });
});

Deno.test("a symlinked sidecar is not read through", async () => {
  await withFixture(async (fixture, outside) => {
    await Deno.writeTextFile(`${outside.dir}/planted.bak.json`, "{}\n");
    await install(context(fixture));

    const backups = `${fixture.instanceRoot}/${INSTALLER_DIR}/backups`;
    await Deno.symlink(`${outside.dir}/planted.bak.json`, `${backups}/planted.bak.json`);

    const result = await status(context(fixture));
    assertEquals(
      result.warnings.some((warning) => warning.includes("symbolic link")),
      true,
      `expected a warning about the symlinked sidecar, got ${JSON.stringify(result.warnings)}`,
    );
  });
});
