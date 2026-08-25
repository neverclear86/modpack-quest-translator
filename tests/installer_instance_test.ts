import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { resolveInstanceRoot, resolveTargetPath } from "../src/installer/instance.ts";

/** A directory that looks like a Minecraft instance, with an awkward name. */
async function makeInstance(parent: string, name = "インスタンス 1"): Promise<string> {
  const root = `${parent}/${name}`;
  await Deno.mkdir(`${root}/mods`, { recursive: true });
  await Deno.mkdir(`${root}/config`, { recursive: true });
  await Deno.mkdir(`${root}/saves`, { recursive: true });
  return root;
}

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-instance-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function refuses(input: string, needle: string): Promise<void> {
  const error = await assertRejects(() => resolveInstanceRoot(input), AppError);
  assertEquals(error.code, "E_INSTANCE");
  assertStringIncludes(error.message, needle);
}

Deno.test("a directory with mods/ and config/ is accepted", async () => {
  await withTemp(async (dir) => {
    const root = await makeInstance(dir);
    const resolved = await resolveInstanceRoot(root);
    assertEquals(resolved.root, await Deno.realPath(root));
    assertEquals(resolved.descendedInto, undefined);
  });
});

Deno.test("a directory missing mods/ or config/ is refused by name", async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/only-config/config`, { recursive: true });
    await refuses(`${dir}/only-config`, "mods");
    await Deno.mkdir(`${dir}/only-mods/mods`, { recursive: true });
    await refuses(`${dir}/only-mods`, "config");
  });
});

Deno.test("a file where mods/ should be is refused", async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/inst/config`, { recursive: true });
    await Deno.writeTextFile(`${dir}/inst/mods`, "not a directory");
    await refuses(`${dir}/inst`, "mods");
  });
});

Deno.test("a symlinked config/ is refused even when it points somewhere real", async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/elsewhere`, { recursive: true });
    await Deno.mkdir(`${dir}/inst/mods`, { recursive: true });
    await Deno.symlink(`${dir}/elsewhere`, `${dir}/inst/config`);
    await refuses(`${dir}/inst`, "symbolic link");
  });
});

Deno.test("a launcher instance folder auto-descends one level into .minecraft", async () => {
  await withTemp(async (dir) => {
    const outer = `${dir}/aca`;
    await Deno.mkdir(outer, { recursive: true });
    await Deno.writeTextFile(`${outer}/instance.cfg`, "name=aca\n");
    const inner = await makeInstance(outer, ".minecraft");
    const resolved = await resolveInstanceRoot(outer);
    assertEquals(resolved.root, await Deno.realPath(inner));
    assertEquals(resolved.descendedInto, ".minecraft");
  });
});

Deno.test("a MultiMC instance folder auto-descends into minecraft", async () => {
  await withTemp(async (dir) => {
    const outer = `${dir}/aca`;
    await Deno.mkdir(outer, { recursive: true });
    const inner = await makeInstance(outer, "minecraft");
    const resolved = await resolveInstanceRoot(outer);
    assertEquals(resolved.root, await Deno.realPath(inner));
    assertEquals(resolved.descendedInto, "minecraft");
  });
});

Deno.test("the search never goes deeper than one level", async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/outer/deeper`, { recursive: true });
    await makeInstance(`${dir}/outer/deeper`, ".minecraft");
    await refuses(`${dir}/outer`, "mods");
  });
});

Deno.test("a path that is not a directory at all is refused", async () => {
  await withTemp(async (dir) => {
    await Deno.writeTextFile(`${dir}/file.txt`, "x");
    await refuses(`${dir}/file.txt`, "not a directory");
    await refuses(`${dir}/nope`, "does not exist");
  });
});

Deno.test("the target resolves inside the instance and its parents are created on write", async () => {
  await withTemp(async (dir) => {
    const root = await resolveInstanceRoot(await makeInstance(dir));
    const target = await resolveTargetPath(root.root, "config/ftbquests/quests/lang/en_us.snbt");
    assertEquals(target.path, `${root.root}/config/ftbquests/quests/lang/en_us.snbt`);
    assertEquals(target.existingAncestor, `${root.root}/config`);
  });
});

Deno.test("a symlink anywhere on the way to the target is refused", async () => {
  await withTemp(async (dir) => {
    const root = (await resolveInstanceRoot(await makeInstance(dir))).root;
    await Deno.mkdir(`${dir}/outside/lang`, { recursive: true });
    await Deno.mkdir(`${root}/config/ftbquests/quests`, { recursive: true });
    await Deno.symlink(`${dir}/outside/lang`, `${root}/config/ftbquests/quests/lang`);
    const error = await assertRejects(
      () => resolveTargetPath(root, "config/ftbquests/quests/lang/en_us.snbt"),
      AppError,
    );
    assertEquals(error.code, "E_INSTANCE");
    assertStringIncludes(error.message, "symbolic link");
  });
});

Deno.test("a symlinked target file is refused, and --force does not change that", async () => {
  await withTemp(async (dir) => {
    const root = (await resolveInstanceRoot(await makeInstance(dir))).root;
    await Deno.mkdir(`${root}/config/ftbquests/quests/lang`, { recursive: true });
    await Deno.writeTextFile(`${dir}/outside.snbt`, "x");
    await Deno.symlink(`${dir}/outside.snbt`, `${root}/config/ftbquests/quests/lang/en_us.snbt`);
    for (const force of [false, true]) {
      const error = await assertRejects(
        () => resolveTargetPath(root, "config/ftbquests/quests/lang/en_us.snbt", { force }),
        AppError,
      );
      assertEquals(error.code, "E_INSTANCE");
      assertStringIncludes(error.message, "symbolic link");
    }
  });
});

Deno.test("a file blocking a directory on the way to the target is refused", async () => {
  await withTemp(async (dir) => {
    const root = (await resolveInstanceRoot(await makeInstance(dir))).root;
    await Deno.writeTextFile(`${root}/config/ftbquests`, "a file, not a directory");
    const error = await assertRejects(
      () => resolveTargetPath(root, "config/ftbquests/quests/lang/en_us.snbt"),
      AppError,
    );
    assertEquals(error.code, "E_INSTANCE");
    assertStringIncludes(error.message, "not a directory");
  });
});

Deno.test("a target that resolves outside the instance root is refused", async () => {
  await withTemp(async (dir) => {
    const root = (await resolveInstanceRoot(await makeInstance(dir))).root;
    await assertRejects(
      () => resolveTargetPath(root, "../../../../etc/passwd"),
      AppError,
    );
  });
});
