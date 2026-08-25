/**
 * The publishing transaction on its own, without an installer around it.
 *
 * Two things are worth proving here rather than through a whole install. The
 * first is housekeeping: a transaction that succeeds leaves nothing beside the
 * target, so a leftover really does mean "a run was interrupted" and recovery
 * can act on that alone. The second is the refusal that keeps the protocol
 * honest -- a filesystem with no hard links cannot publish a name without
 * replacing what is there, and the only safe answer is to stop and say so
 * rather than to fall back to a rename and keep the race.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { listStaged, publishFile, recoverStaged, removeFile } from "../src/installer/publish.ts";
import { durabilityFor } from "../src/util/durable.ts";
import { sha256Hex } from "../src/util/hash.ts";

const durability = durabilityFor("posix");
const OLD = "the file that was there\n";
const NEW = "the file this run publishes\n";
const THEIRS = "the file another process published\n";

async function withDirectory(fn: (dir: string, path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-publish-" });
  try {
    await fn(dir, `${dir}/en_us.snbt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function names(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) found.push(entry.name);
  return found.sort();
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

Deno.test("publishing over a file leaves nothing behind but the file", async () => {
  await withDirectory(async (dir, path) => {
    await Deno.writeTextFile(path, OLD);
    await publishFile(bytes(NEW), { path, expected: await sha256Hex(bytes(OLD)), durability });
    assertEquals(await Deno.readTextFile(path), NEW);
    assertEquals(await names(dir), ["en_us.snbt"]);
  });
});

Deno.test("publishing where nothing is leaves nothing behind but the file", async () => {
  await withDirectory(async (dir, path) => {
    await publishFile(bytes(NEW), { path, expected: null, durability });
    assertEquals(await Deno.readTextFile(path), NEW);
    assertEquals(await names(dir), ["en_us.snbt"]);
  });
});

Deno.test("a file that is not what the plan was made for is put straight back", async () => {
  await withDirectory(async (dir, path) => {
    await Deno.writeTextFile(path, THEIRS);
    const old = await sha256Hex(bytes(OLD));
    const error = await assertRejects(
      () => publishFile(bytes(NEW), { path, expected: old, durability }),
      AppError,
    );
    assertEquals(error.code, "E_TARGET_MODIFIED");
    assertEquals(await Deno.readTextFile(path), THEIRS);
    assertEquals(await names(dir), ["en_us.snbt"]);
  });
});

Deno.test("deleting leaves a file created in the gap alone and says so", async () => {
  await withDirectory(async (_dir, path) => {
    await Deno.writeTextFile(path, OLD);
    const outcome = await removeFile({
      path,
      expected: await sha256Hex(bytes(OLD)),
      durability,
      gap: async (stage) => {
        if (stage === "after-move") await Deno.writeTextFile(path, THEIRS);
      },
    });
    assertEquals(outcome.keptForeignFile, true);
    assertEquals(await Deno.readTextFile(path), THEIRS);
  });
});

Deno.test("a filesystem that cannot publish without replacing is refused, not worked around", async () => {
  await withDirectory(async (dir, path) => {
    await Deno.writeTextFile(path, OLD);
    const old = await sha256Hex(bytes(OLD));
    const real = Deno.link.bind(Deno);
    // What a FAT32 stick does: hard links are simply not a thing it has.
    Object.defineProperty(Deno, "link", {
      configurable: true,
      value: () => Promise.reject(new Deno.errors.NotSupported("no hard links here")),
    });
    try {
      const error = await assertRejects(
        () => publishFile(bytes(NEW), { path, expected: old, durability }),
        AppError,
      );
      assertEquals(error.code, "E_WRITE");
      assertStringIncludes(error.hint ?? "", "hard links");
    } finally {
      Object.defineProperty(Deno, "link", { configurable: true, value: real });
    }

    // Refused, and the file it was about to replace is back at its own name --
    // put there by the same no-replace publish, once it worked again.
    assertEquals(await Deno.readTextFile(path), OLD);
    assertEquals(await names(dir), ["en_us.snbt"]);
  });
});

/**
 * What a power cut leaves: the target renamed aside and nothing else done.
 *
 * Built by hand rather than by interrupting a transaction, because an abort the
 * process survives puts the file back on its way out -- only a run that dies
 * between two syscalls can leave this, and that is exactly what is being
 * recovered from.
 */
async function interrupted(path: string, contents: string): Promise<string> {
  const staged = `${path}.mqt-staged-0123abcd`;
  await Deno.writeTextFile(path, contents);
  await Deno.rename(path, staged);
  return staged;
}

Deno.test("an interrupted transaction is visible, and recovering it puts the file back", async () => {
  await withDirectory(async (dir, path) => {
    const staged = await interrupted(path, OLD);
    assertEquals(await listStaged(path), [staged]);

    const recovered = await recoverStaged(path, { durability });
    assertEquals(recovered.map((entry) => entry.outcome), ["put-back"]);
    assertEquals(await Deno.readTextFile(path), OLD);
    assertEquals(await names(dir), ["en_us.snbt"]);
  });
});

Deno.test("recovery keeps a newer file and hands the captured bytes to the caller", async () => {
  await withDirectory(async (dir, path) => {
    await interrupted(path, OLD);
    // Something took the free name before the next run got to it.
    await Deno.writeTextFile(path, THEIRS);

    const kept: string[] = [];
    const recovered = await recoverStaged(path, {
      durability,
      rescue: (captured) => {
        kept.push(new TextDecoder().decode(captured));
        return Promise.resolve("backups/kept.bak");
      },
    });
    assertEquals(recovered, [{ outcome: "preserved", location: "backups/kept.bak" }]);
    assertEquals(kept, [OLD]);
    assertEquals(await Deno.readTextFile(path), THEIRS);
    assertEquals(await names(dir), ["en_us.snbt"]);
  });
});

Deno.test("a transaction that aborts puts the file back on its own way out", async () => {
  await withDirectory(async (dir, path) => {
    await Deno.writeTextFile(path, OLD);
    const old = await sha256Hex(bytes(OLD));
    await assertRejects(
      () =>
        publishFile(bytes(NEW), {
          path,
          expected: old,
          durability,
          gap: (stage) =>
            stage === "after-move"
              ? Promise.reject(new Error("something went wrong mid-transaction"))
              : Promise.resolve(),
        }),
      Error,
    );
    // A refusal has to leave the instance as it found it: no leftovers, and the
    // file back at its own name.
    assertEquals(await Deno.readTextFile(path), OLD);
    assertEquals(await names(dir), ["en_us.snbt"]);
  });
});
