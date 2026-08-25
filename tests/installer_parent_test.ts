/**
 * The directory the transaction works in, swapped while it is working.
 *
 * Every guarantee in `publish.ts` is about a *name*: the digest of what was
 * captured, `link` refusing to replace, the private staged name nothing else
 * uses. All of them are resolved by the kernel from whichever directory is at
 * the parent's name at the instant each syscall runs, and none of them notices
 * when that stops being the directory the plan was made for.
 *
 * So the whole protocol can be pointed somewhere else. Rename `lang` aside,
 * drop a symbolic link to a directory of your own in its place, put a file
 * there with the bytes the installer expects and a copy of its temporary file's
 * name, and every check passes: the capture digests correctly because you
 * supplied the bytes, `link` publishes because you left the name free, and the
 * installer replaces *your* file with its payload and deletes the original on
 * its way out. Nothing it did was inside the instance at all.
 *
 * Deno has no `openat`, so a name lookup cannot be tied to a directory handle
 * and the gap between the two cannot be closed. What can be done is to bind the
 * transaction to the directory's identity -- device, inode, birthtime and what
 * the name resolves to -- and to prove it either side of every path operation:
 * before, so an operation that would land somewhere else never happens; and
 * after, because an operation that has already returned may have landed there
 * anyway, and then what it moved has to be put straight back.
 *
 * The swaps here are injected at the transaction's own gaps and, where the
 * point is a syscall that cannot be split, from inside monkeypatched
 * `Deno.rename` and `Deno.link` -- a race that is not deterministic is a test
 * that passes by luck.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { listStaged, publishFile, recoverStaged, removeFile } from "../src/installer/publish.ts";
import { durabilityFor } from "../src/util/durable.ts";
import { sha256Hex } from "../src/util/hash.ts";

const durability = durabilityFor("posix");

const ORIGINAL = "ORIGINAL SAME BYTES\n";
const PAYLOAD = "INSTALLER PAYLOAD\n";
const THEIRS = "the file that was in the directory that took its place\n";
const CANARY = "do not touch\n";

/** The digest of the file every plan below was made for. */
const WAS_ORIGINAL = await sha256Hex(new TextEncoder().encode(ORIGINAL));

interface Scene {
  /** The directory the transaction binds to, and the file it is asked about. */
  lang: string;
  target: string;
  /** Where the bound directory ends up once the attacker renames it away. */
  moved: string;
  /** A directory the transaction was never meant to reach. */
  outside: string;
}

async function withScene(fn: (scene: Scene) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "mqt-parent-" });
  const scene: Scene = {
    lang: `${root}/instance/lang`,
    target: `${root}/instance/lang/en_us.snbt`,
    moved: `${root}/instance/lang-old`,
    outside: `${root}/outside`,
  };
  await Deno.mkdir(scene.lang, { recursive: true });
  await Deno.mkdir(scene.outside);
  await Deno.writeTextFile(`${scene.outside}/canary.txt`, CANARY);
  try {
    await fn(scene);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function names(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) found.push(entry.name);
  return found.sort();
}

async function read(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw cause;
  }
}

/** Which file a name refers to, so "the same file" can mean the same file. */
async function inodeOf(path: string): Promise<number | null> {
  return (await Deno.lstat(path)).ino;
}

/** The temporary file a transaction has already written, by the name it chose. */
async function temporaryIn(dir: string): Promise<string> {
  for (const name of await names(dir)) if (name.includes(".mqt-new-")) return name;
  throw new Error(`no temporary file in ${dir}: the transaction had not written one yet`);
}

/** The bytes a transaction captured, wherever its directory ended up. */
async function capturedIn(dir: string): Promise<string | null> {
  for (const name of await names(dir)) {
    if (name.includes(".mqt-staged-")) return await read(`${dir}/${name}`);
  }
  return null;
}

/** Nothing this run did reached the directory it was pointed at. */
async function untouched(scene: Scene, extra: string[] = []): Promise<void> {
  assertEquals(await read(`${scene.outside}/canary.txt`), CANARY);
  assertEquals(await names(scene.outside), ["canary.txt", ...extra].sort());
}

/** Rename `lang` away and leave a symbolic link to the outside in its place. */
async function symlinkOverParent(scene: Scene): Promise<void> {
  await Deno.rename(scene.lang, scene.moved);
  await Deno.symlink(scene.outside, scene.lang);
}

// ---------------------------------------------------------------------------
// The reviewer's reproduction, and the same attack at the other gap.
// ---------------------------------------------------------------------------

Deno.test("a parent swapped for a symlink cannot make the transaction overwrite a file outside", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    // The same bytes as the file the plan was made for, so the digest of
    // whatever gets captured cannot tell the two apart.
    await Deno.writeTextFile(`${scene.outside}/en_us.snbt`, ORIGINAL);
    let forged = "";

    const error = await assertRejects(
      () =>
        publishFile(bytes(PAYLOAD), {
          path: scene.target,
          expected: WAS_ORIGINAL,
          durability,
          gap: async (stage) => {
            if (stage !== "before-move") return;
            await symlinkOverParent(scene);
            // A file with the transaction's own temporary name, so the publish
            // would link the attacker's bytes over the outside file.
            forged = await temporaryIn(scene.moved);
            await Deno.writeTextFile(`${scene.outside}/${forged}`, PAYLOAD);
          },
        }),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertStringIncludes(error.message, scene.lang);

    // The outside file the symlink pointed the transaction at still says what
    // it said, and the forged temporary name is still there: the transaction's
    // own cleanup would otherwise have deleted it on the way out.
    assertEquals(await read(`${scene.outside}/en_us.snbt`), ORIGINAL);
    await untouched(scene, ["en_us.snbt", forged]);
    // And the directory it agreed to work in still holds the file it was asked
    // to replace, unread and unmoved.
    assertEquals(await read(`${scene.moved}/en_us.snbt`), ORIGINAL);
    assertEquals(await capturedIn(scene.moved), null);
  });
});

Deno.test("a parent swapped for a symlink after the capture is caught before the publish", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    await Deno.writeTextFile(`${scene.outside}/en_us.snbt`, THEIRS);

    const error = await assertRejects(
      () =>
        publishFile(bytes(PAYLOAD), {
          path: scene.target,
          expected: WAS_ORIGINAL,
          durability,
          gap: async (stage) => {
            if (stage === "after-move") await symlinkOverParent(scene);
          },
        }),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");

    assertEquals(await read(`${scene.outside}/en_us.snbt`), THEIRS);
    await untouched(scene, ["en_us.snbt"]);
    // The capture is where the transaction left it -- in the directory it came
    // from, under the name that says a run was interrupted.
    assertEquals(await capturedIn(scene.moved), ORIGINAL);
  });
});

// ---------------------------------------------------------------------------
// The same attack with a second real directory rather than a symlink.
// ---------------------------------------------------------------------------

for (const stage of ["before-move", "after-move"] as const) {
  Deno.test(`a parent swapped for another real directory at ${stage} is refused`, async () => {
    await withScene(async (scene) => {
      await Deno.writeTextFile(scene.target, ORIGINAL);
      const incoming = `${scene.outside}/incoming`;
      await Deno.mkdir(incoming);
      await Deno.writeTextFile(`${incoming}/en_us.snbt`, THEIRS);

      const error = await assertRejects(
        () =>
          publishFile(bytes(PAYLOAD), {
            path: scene.target,
            expected: WAS_ORIGINAL,
            durability,
            gap: async (reached) => {
              if (reached !== stage) return;
              await Deno.rename(scene.lang, scene.moved);
              await Deno.rename(incoming, scene.lang);
            },
          }),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");

      // The directory that took the name kept its own file, and nothing this
      // run wrote is in it.
      assertEquals(await read(`${scene.lang}/en_us.snbt`), THEIRS);
      assertEquals(await names(scene.lang), ["en_us.snbt"]);
      // Before the move nothing was captured; after it, the capture is in the
      // directory it came from and the target's name there is free.
      assertEquals(
        await read(`${scene.moved}/en_us.snbt`),
        stage === "before-move" ? ORIGINAL : null,
      );
      assertEquals(await capturedIn(scene.moved), stage === "before-move" ? null : ORIGINAL);
    });
  });
}

// ---------------------------------------------------------------------------
// Swaps that land inside a syscall, where checking first cannot help.
// ---------------------------------------------------------------------------

/** Swap the parent from inside the call that moves the target aside. */
function swapInsideRename(
  scene: Scene,
  incoming: string,
): { done: () => boolean; undo: () => void } {
  const rename = Deno.rename.bind(Deno);
  let swapped = false;
  Object.defineProperty(Deno, "rename", {
    configurable: true,
    value: async (from: string, to: string) => {
      // The transaction proves the directory, then calls this. There is nothing
      // in between to observe, so the swap happens inside the call itself.
      if (!swapped && String(to).includes(".mqt-staged-")) {
        swapped = true;
        await rename(scene.lang, scene.moved);
        await rename(incoming, scene.lang);
      }
      return await rename(from, to);
    },
  });
  return {
    done: () => swapped,
    undo: () => Object.defineProperty(Deno, "rename", { configurable: true, value: rename }),
  };
}

Deno.test("a parent swapped inside the rename puts the stranger's file straight back", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    const incoming = `${scene.outside}/incoming`;
    await Deno.mkdir(incoming);
    // The same bytes as the file the plan was made for, so digesting what the
    // rename captured cannot tell the two apart: only the directory's identity
    // can, and only after the call that used it has already returned.
    await Deno.writeTextFile(`${incoming}/en_us.snbt`, ORIGINAL);
    const stranger = await inodeOf(`${incoming}/en_us.snbt`);

    const attack = swapInsideRename(scene, incoming);
    try {
      const error = await assertRejects(
        () =>
          publishFile(bytes(PAYLOAD), {
            path: scene.target,
            expected: WAS_ORIGINAL,
            durability,
          }),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
    } finally {
      attack.undo();
    }

    assertEquals(attack.done(), true);
    // The rename really did resolve both of its names in the directory that
    // took the bound one's place -- and what it moved is back at its own name,
    // the same file it always was rather than a copy or a payload.
    assertEquals(await read(`${scene.lang}/en_us.snbt`), ORIGINAL);
    assertEquals(await inodeOf(`${scene.lang}/en_us.snbt`), stranger);
    assertEquals(await names(scene.lang), ["en_us.snbt"]);
    // The bound directory never had its file touched.
    assertEquals(await read(`${scene.moved}/en_us.snbt`), ORIGINAL);
  });
});

Deno.test("a capture from a replacement directory that cannot go back is left where it is", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    const incoming = `${scene.outside}/incoming`;
    await Deno.mkdir(incoming);
    await Deno.writeTextFile(`${incoming}/en_us.snbt`, ORIGINAL);
    const stranger = await inodeOf(`${incoming}/en_us.snbt`);

    const attack = swapInsideRename(scene, incoming);
    // ...and putting it back is not possible either: something takes the name
    // in the meantime.
    const link = Deno.link.bind(Deno);
    Object.defineProperty(Deno, "link", {
      configurable: true,
      value: (from: string, to: string) =>
        attack.done() && to === scene.target
          ? Promise.reject(new Deno.errors.AlreadyExists(to))
          : link(from, to),
    });

    const rescued: string[] = [];
    try {
      const error = await assertRejects(
        () =>
          publishFile(bytes(PAYLOAD), {
            path: scene.target,
            expected: WAS_ORIGINAL,
            durability,
            rescue: (captured) => {
              rescued.push(new TextDecoder().decode(captured));
              return Promise.resolve("backups/kept.bak");
            },
          }),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
      // Loudly: the message says where the bytes it could not put back are.
      assertStringIncludes(error.hint ?? "", ".mqt-staged-");
    } finally {
      attack.undo();
      Object.defineProperty(Deno, "link", { configurable: true, value: link });
    }

    // Not rescued into this run's backups: moving a stranger's file into the
    // instance's backup directory is the loss this path exists to avoid. It is
    // left in the directory it came from, under the name recovery looks for.
    assertEquals(rescued, []);
    const [left] = await listStaged(scene.target);
    assertEquals(await inodeOf(left), stranger);
    assertEquals((await listStaged(scene.target)).length, 1);
    assertEquals(await read(`${scene.moved}/en_us.snbt`), ORIGINAL);
  });
});

/** Swap the parent from inside the call that publishes the payload. */
function swapInsidePublishingLink(scene: Scene, incoming: string): { undo: () => void } {
  const rename = Deno.rename.bind(Deno);
  const link = Deno.link.bind(Deno);
  let swapped = false;
  Object.defineProperty(Deno, "link", {
    configurable: true,
    value: async (from: string, to: string) => {
      if (!swapped && to === scene.target) {
        swapped = true;
        await rename(scene.lang, scene.moved);
        await rename(incoming, scene.lang);
        // The link's source name resolves in the new directory too, so the
        // attacker supplies a file there for it to publish.
        await Deno.writeTextFile(`${scene.lang}/${await temporaryIn(scene.moved)}`, PAYLOAD);
      }
      return await link(from, to);
    },
  });
  return { undo: () => Object.defineProperty(Deno, "link", { configurable: true, value: link }) };
}

Deno.test("a parent swapped inside the publishing link takes the published name back off", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    // Nothing at `en_us.snbt`, so `link` has a free name and really publishes.
    const incoming = `${scene.outside}/incoming`;
    await Deno.mkdir(incoming);

    const attack = swapInsidePublishingLink(scene, incoming);
    try {
      const error = await assertRejects(
        () =>
          publishFile(bytes(PAYLOAD), {
            path: scene.target,
            expected: WAS_ORIGINAL,
            durability,
          }),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
    } finally {
      attack.undo();
    }

    // `link` only ever publishes into a free name, so taking it back off again
    // leaves that directory exactly as it was found.
    assertEquals(await read(`${scene.lang}/en_us.snbt`), null);
    assertEquals((await names(scene.lang)).filter((name) => !name.includes(".mqt-new-")), []);
    // The capture is still in the directory it came from.
    assertEquals(await capturedIn(scene.moved), ORIGINAL);
  });
});

Deno.test("a parent swapped inside the publishing link leaves an occupied name alone", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    const incoming = `${scene.outside}/incoming`;
    await Deno.mkdir(incoming);
    await Deno.writeTextFile(`${incoming}/en_us.snbt`, THEIRS);

    const attack = swapInsidePublishingLink(scene, incoming);
    try {
      const error = await assertRejects(
        () =>
          publishFile(bytes(PAYLOAD), {
            path: scene.target,
            expected: WAS_ORIGINAL,
            durability,
          }),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
    } finally {
      attack.undo();
    }

    assertEquals(await read(`${scene.lang}/en_us.snbt`), THEIRS);
    assertEquals(await capturedIn(scene.moved), ORIGINAL);
  });
});

/** Swap the parent from inside a `Deno.open` whose path matches. */
function swapInsideOpen(scene: Scene, incoming: string, marker: string): { undo: () => void } {
  const open = Deno.open.bind(Deno);
  const rename = Deno.rename.bind(Deno);
  let swapped = false;
  Object.defineProperty(Deno, "open", {
    configurable: true,
    value: async (path: string, options?: Deno.OpenOptions) => {
      const file = await open(path, options);
      if (!swapped && String(path).includes(marker)) {
        swapped = true;
        await rename(scene.lang, scene.moved);
        await rename(incoming, scene.lang);
      }
      return file;
    },
  });
  return { undo: () => Object.defineProperty(Deno, "open", { configurable: true, value: open }) };
}

Deno.test("a parent swapped around the temporary file's creation never receives the payload", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    const incoming = `${scene.outside}/incoming`;
    await Deno.mkdir(incoming);
    await Deno.writeTextFile(`${incoming}/en_us.snbt`, THEIRS);

    const attack = swapInsideOpen(scene, incoming, ".mqt-new-");
    try {
      const error = await assertRejects(
        () =>
          publishFile(bytes(PAYLOAD), {
            path: scene.target,
            expected: WAS_ORIGINAL,
            durability,
          }),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
    } finally {
      attack.undo();
    }

    // The handle was opened in the bound directory and the swap landed before a
    // byte went through it, so the payload is in the directory that was renamed
    // away. Nothing of it is in the one that took the name.
    assertEquals(await read(`${scene.lang}/en_us.snbt`), THEIRS);
    assertEquals(await names(scene.lang), ["en_us.snbt"]);
    assertEquals(await read(`${scene.moved}/${await temporaryIn(scene.moved)}`), "");
  });
});

Deno.test("a parent swapped around the staged name's reservation leaves it nothing", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    const incoming = `${scene.outside}/incoming`;
    await Deno.mkdir(incoming);
    await Deno.writeTextFile(`${incoming}/en_us.snbt`, THEIRS);

    const attack = swapInsideOpen(scene, incoming, ".mqt-staged-");
    try {
      const error = await assertRejects(
        () =>
          publishFile(bytes(PAYLOAD), {
            path: scene.target,
            expected: WAS_ORIGINAL,
            durability,
          }),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
    } finally {
      attack.undo();
    }

    // The reservation was made in the bound directory, so the rename that would
    // have followed it never ran: the target is still at its own name.
    assertEquals(await read(`${scene.lang}/en_us.snbt`), THEIRS);
    assertEquals(await names(scene.lang), ["en_us.snbt"]);
    assertEquals(await read(`${scene.moved}/en_us.snbt`), ORIGINAL);
  });
});

Deno.test("a parent swapped around the hard-link probe is a swap, not a missing primitive", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    const incoming = `${scene.outside}/incoming`;
    await Deno.mkdir(incoming);
    await Deno.writeTextFile(`${incoming}/en_us.snbt`, THEIRS);

    const link = Deno.link.bind(Deno);
    const rename = Deno.rename.bind(Deno);
    Object.defineProperty(Deno, "link", {
      configurable: true,
      value: async (from: string, to: string) => {
        if (String(to).includes(".mqt-probe-")) {
          await rename(scene.lang, scene.moved);
          await rename(incoming, scene.lang);
        }
        return await link(from, to);
      },
    });
    try {
      const error = await assertRejects(
        () =>
          publishFile(bytes(PAYLOAD), {
            path: scene.target,
            expected: WAS_ORIGINAL,
            durability,
          }),
        AppError,
      );
      // Not `E_WRITE` about hard links: the probe failed because it was pointed
      // at a different directory, and saying "this filesystem cannot do hard
      // links" would send the player off to reformat a disk that is fine.
      assertEquals(error.code, "E_TARGET_MODIFIED");
    } finally {
      Object.defineProperty(Deno, "link", { configurable: true, value: link });
    }

    assertEquals(await names(scene.lang), ["en_us.snbt"]);
    assertEquals(await read(`${scene.moved}/en_us.snbt`), ORIGINAL);
  });
});

// ---------------------------------------------------------------------------
// The other two transactions: creating where nothing is, and deleting.
// ---------------------------------------------------------------------------

Deno.test("creating a file refuses rather than create it in a directory that took the name", async () => {
  await withScene(async (scene) => {
    const error = await assertRejects(
      () =>
        publishFile(bytes(PAYLOAD), {
          path: scene.target,
          expected: null,
          durability,
          gap: async (stage) => {
            if (stage === "after-move") await symlinkOverParent(scene);
          },
        }),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");
    await untouched(scene);
    // The payload was written before the swap, so it is in the directory that
    // was renamed away -- and it is still there, because removing a name from
    // whatever took its place is not cleanup, it is a deletion.
    assertEquals(await read(`${scene.moved}/${await temporaryIn(scene.moved)}`), PAYLOAD);
  });
});

for (const stage of ["before-move", "after-move"] as const) {
  Deno.test(`deleting deletes nothing outside when the parent is swapped at ${stage}`, async () => {
    await withScene(async (scene) => {
      await Deno.writeTextFile(scene.target, ORIGINAL);
      await Deno.writeTextFile(`${scene.outside}/en_us.snbt`, THEIRS);

      const error = await assertRejects(
        () =>
          removeFile({
            path: scene.target,
            expected: WAS_ORIGINAL,
            durability,
            gap: async (reached) => {
              if (reached === stage) await symlinkOverParent(scene);
            },
          }),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");

      assertEquals(await read(`${scene.outside}/en_us.snbt`), THEIRS);
      await untouched(scene, ["en_us.snbt"]);
      // Either still at its own name, or captured beside it -- never deleted.
      assertEquals(
        await read(`${scene.moved}/en_us.snbt`) ?? await capturedIn(scene.moved),
        ORIGINAL,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// The windows where something else goes wrong at the same time.
// ---------------------------------------------------------------------------

Deno.test("a gap that throws after swapping the parent still puts nothing back through it", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    await Deno.writeTextFile(`${scene.outside}/en_us.snbt`, THEIRS);

    await assertRejects(
      () =>
        publishFile(bytes(PAYLOAD), {
          path: scene.target,
          expected: WAS_ORIGINAL,
          durability,
          gap: async (stage) => {
            if (stage !== "after-move") return;
            await symlinkOverParent(scene);
            throw new Error("and then the run died mid-transaction");
          },
        }),
      Error,
      "died mid-transaction",
    );

    // The rollback would have published the capture at the target's name --
    // which now leads outside. It did not run.
    assertEquals(await read(`${scene.outside}/en_us.snbt`), THEIRS);
    await untouched(scene, ["en_us.snbt"]);
    assertEquals(await capturedIn(scene.moved), ORIGINAL);
  });
});

Deno.test("recovery stops finishing an interrupted run once the parent has been swapped", async () => {
  await withScene(async (scene) => {
    // What a power cut leaves: two files captured, the target's name free.
    for (const suffix of ["0123abcd", "89abcdef"]) {
      await Deno.writeTextFile(`${scene.target}.mqt-staged-${suffix}`, ORIGINAL);
    }
    await Deno.writeTextFile(`${scene.outside}/en_us.snbt`, THEIRS);

    const link = Deno.link.bind(Deno);
    let put = 0;
    Object.defineProperty(Deno, "link", {
      configurable: true,
      value: async (from: string, to: string) => {
        const result = await link(from, to);
        // The parent goes away between one leftover and the next, which is the
        // only window recovery has.
        if (++put === 1) await symlinkOverParent(scene);
        return result;
      },
    });
    try {
      const error = await assertRejects(
        () => recoverStaged(scene.target, { durability }),
        AppError,
      );
      assertEquals(error.code, "E_TARGET_MODIFIED");
    } finally {
      Object.defineProperty(Deno, "link", { configurable: true, value: link });
    }

    // The first leftover was put back before the swap; the second is still in
    // the directory it belongs to, and the outside file was never considered.
    assertEquals(await read(`${scene.outside}/en_us.snbt`), THEIRS);
    await untouched(scene, ["en_us.snbt"]);
    assertEquals(await read(`${scene.moved}/en_us.snbt`), ORIGINAL);
    assertEquals(await capturedIn(scene.moved), ORIGINAL);
  });
});

// ---------------------------------------------------------------------------
// What must keep working.
// ---------------------------------------------------------------------------

Deno.test("a parent that was already a symlink when the transaction started is fine", async () => {
  await withScene(async (scene) => {
    const real = `${scene.outside}/real`;
    await Deno.mkdir(real);
    await Deno.writeTextFile(`${real}/en_us.snbt`, ORIGINAL);
    const through = `${scene.outside}/through`;
    await Deno.symlink(real, through);

    await publishFile(bytes(PAYLOAD), {
      path: `${through}/en_us.snbt`,
      expected: WAS_ORIGINAL,
      durability,
    });
    assertEquals(await read(`${real}/en_us.snbt`), PAYLOAD);
    assertEquals(await names(real), ["en_us.snbt"]);
  });
});

Deno.test("a file published into the free name in the final gap is still kept, not replaced", async () => {
  await withScene(async (scene) => {
    await Deno.writeTextFile(scene.target, ORIGINAL);
    const rescued: string[] = [];

    const error = await assertRejects(
      () =>
        publishFile(bytes(PAYLOAD), {
          path: scene.target,
          expected: WAS_ORIGINAL,
          durability,
          rescue: (captured) => {
            rescued.push(new TextDecoder().decode(captured));
            return Promise.resolve("backups/kept.bak");
          },
          // Same directory, same identity: an ordinary race, and the answer is
          // still that the newer file wins.
          gap: async (stage) => {
            if (stage === "after-move") await Deno.writeTextFile(scene.target, THEIRS);
          },
        }),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertEquals(await read(scene.target), THEIRS);
    assertEquals(rescued, [ORIGINAL]);
    assertEquals(await names(scene.lang), ["en_us.snbt"]);
  });
});
