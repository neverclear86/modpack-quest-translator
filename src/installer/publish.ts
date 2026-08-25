import { AppError } from "../errors.ts";
import type { Durability } from "../util/durable.ts";
import { sha256Hex } from "../util/hash.ts";

/**
 * Replacing and deleting a file without ever overwriting one.
 *
 * Checking the target and then renaming over it is two operations on a
 * pathname, and a pathname is not a lock. Everything the installer does to
 * prove the file is still what it planned for happens *before* the rename, and
 * the modpack's own updater, a sync client or an editor can publish its own
 * file into the gap between them with a rename of its own. The loser of that
 * race is whoever writes second, and writing second is exactly what an
 * installer that re-checks first does. The same is true of `Deno.remove`: it
 * deletes whatever the name refers to at the instant it runs, not the file that
 * was proved a moment earlier.
 *
 * So the destructive steps are not "check, then write over". They are:
 *
 *   1. write the new bytes to a temporary file beside the target and flush
 *      them, so publishing is one operation and not a window;
 *   2. `rename` whatever is at the target *aside*, to a name nothing else uses.
 *      That is atomic, and it captures whatever bytes were there at that
 *      instant -- including a write that landed a microsecond earlier;
 *   3. digest what was captured. It cannot change now: it has a private name.
 *      If it is not what the plan was made for, put it back and refuse;
 *   4. publish into the target, which is now an absent name, with `Deno.link`.
 *      `link` fails with `AlreadyExists` rather than replacing, so a file
 *      another process created during step 2-4 wins and is never touched.
 *
 * Deleting is the same protocol with step 4 left out: once the name has been
 * renamed aside, only the captured copy is ever removed, so a file created at
 * the target afterwards cannot be deleted by us.
 *
 * `link` is the load-bearing primitive, because it is the only cross-platform
 * one Deno offers that publishes a name *without* replacing what is there.
 * Filesystems that cannot provide it -- FAT32 on a USB stick, for instance --
 * cannot host this protocol, and the run stops and says so rather than falling
 * back to a rename and keeping the race.
 *
 * A run interrupted between steps 2 and 4 leaves the captured file beside the
 * target, under a name that says what it is. `recoverStaged` puts it back if
 * the target is still absent, and preserves it if something else has since
 * taken the name.
 */

/** The two instants inside a transaction another process's write can land in. */
export type PublishGap =
  /** Before the target is renamed aside: the file is still at its own name. */
  | "before-move"
  /** After it is aside and before the new bytes are published: the name is free. */
  | "after-move";

export interface PublishContext {
  durability: Durability;
  /**
   * Awaited at each gap, and nowhere else. This is the only way to put another
   * process's write inside the window on purpose rather than by luck. Nothing
   * passes it in production, so nothing calls it.
   */
  gap?: (stage: PublishGap) => Promise<void>;
  /**
   * Somewhere to keep bytes that were captured and cannot be put back, because
   * another process has taken the name in the meantime. Returns a location to
   * name in the message. Without it, the captured file is left beside the
   * target rather than discarded.
   */
  rescue?: (bytes: Uint8Array) => Promise<string>;
}

export interface PublishOptions extends PublishContext {
  /** The file to replace, restore or delete. Its directory must exist. */
  path: string;
  /**
   * Digest of the file the plan was made for, or null when the plan was made
   * for there being no file at all.
   */
  expected: string | null;
}

export interface PublishOutcome {
  /**
   * True when the transaction found a file at the target it had not put there,
   * and left it alone. Only reachable on the delete path, which has nothing to
   * publish and so cannot refuse.
   */
  keptForeignFile: boolean;
}

const STAGED = ".mqt-staged-";
const STAGED_NAME = /^(.+)\.mqt-staged-[0-9a-f]{8}$/;

function targetChanged(path: string, detail: string, rescued?: string): AppError {
  return new AppError("E_TARGET_MODIFIED", `${path} ${detail}`, {
    hint: rescued === undefined
      ? "Nothing was overwritten -- the newer file is still there. Close Minecraft and any " +
        "editor or sync client holding the file, then run the command again."
      : `Nothing was overwritten -- the newer file is still there, and the file this run had ` +
        `moved aside was kept at ${rescued}. Close Minecraft and any editor or sync client ` +
        `holding the file, then run the command again.`,
  });
}

function writeError(message: string, hint: string, cause?: unknown): AppError {
  return new AppError("E_WRITE", message, { hint, cause });
}

const NO_LINK_HINT =
  "This filesystem cannot publish a file without replacing whatever is already there, and " +
  "replacing it blindly is how a modpack update gets overwritten. Move the instance to a " +
  "filesystem that supports hard links (NTFS, ext4, APFS, btrfs) and try again.";

function suffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

interface Located {
  directory: string;
  base: string;
  /** A sibling of the target, in whichever separator the path already uses. */
  sibling(name: string): string;
}

/** Split a path without deciding for it which separator the platform uses. */
function locate(path: string): Located {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return { directory: ".", base: path, sibling: (name) => name };
  const separator = path[index];
  const directory = index === 0 ? separator : path.slice(0, index);
  return {
    directory,
    base: path.slice(index + 1),
    sibling: (name) => `${directory}${separator}${name}`,
  };
}

/**
 * Write the bytes beside the target and get them onto the disk.
 *
 * `createNew`, so the temporary file can never be one somebody else is using,
 * and the flush happens here rather than after publishing: the whole point of
 * publishing with a single atomic operation is that there is nothing left to do
 * afterwards that could fail.
 */
async function prewrite(
  at: Located,
  bytes: Uint8Array,
  durability: Durability,
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const temp = at.sibling(`${at.base}.mqt-new-${suffix()}.tmp`);
    let file: Deno.FsFile;
    try {
      file = await Deno.open(temp, { write: true, createNew: true });
    } catch (cause) {
      if (cause instanceof Deno.errors.AlreadyExists) continue;
      throw writeError(
        `Could not create a temporary file in ${at.directory}`,
        "The instance directory has to be writable; nothing was changed.",
        cause,
      );
    }
    try {
      let written = 0;
      while (written < bytes.byteLength) written += await file.write(bytes.subarray(written));
      await durability.syncFile(file, temp);
    } catch (cause) {
      file.close();
      await Deno.remove(temp).catch(() => {});
      if (cause instanceof AppError) throw cause;
      throw writeError(
        `Could not write the new contents of ${at.sibling(at.base)}`,
        "The disk may be full or read-only; nothing was changed.",
        cause,
      );
    } finally {
      file.close();
    }
    return temp;
  }
  throw writeError(
    `Could not find a free temporary name in ${at.directory}`,
    "Something is creating files there faster than they can be used.",
  );
}

/**
 * Rename the target to a private name, capturing whatever is there right then.
 *
 * The name is reserved with `createNew` before the rename, so two runs cannot
 * pick the same one and the second cannot silently clobber the first's capture.
 */
async function moveAside(path: string, at: Located): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const staged = at.sibling(`${at.base}${STAGED}${suffix()}`);
    try {
      (await Deno.open(staged, { write: true, createNew: true })).close();
    } catch (cause) {
      if (cause instanceof Deno.errors.AlreadyExists) continue;
      throw writeError(
        `Could not reserve a name in ${at.directory} to move ${at.base} aside`,
        "The instance directory has to be writable; nothing was changed.",
        cause,
      );
    }
    try {
      // Replaces the empty file just reserved, and nothing else: the name was
      // ours from the instant `createNew` returned.
      await Deno.rename(path, staged);
    } catch (cause) {
      await Deno.remove(staged).catch(() => {});
      if (cause instanceof Deno.errors.NotFound) {
        throw targetChanged(path, "was deleted while the installer was working");
      }
      throw writeError(
        `Could not move ${path} aside`,
        "Close Minecraft and any editor holding the file, then try again. Nothing was changed.",
        cause,
      );
    }
    return staged;
  }
  throw writeError(
    `Could not find a free name in ${at.directory} to move ${at.base} aside`,
    "Something is creating files there faster than they can be used.",
  );
}

/**
 * Prove the directory can publish a name without replacing what is there,
 * before anything is moved aside.
 *
 * Done up front rather than discovered half way through: a filesystem that
 * cannot do this cannot host the protocol at all, and finding that out with the
 * player's file already renamed aside is the one outcome worth avoiding.
 */
async function assertCanPublish(at: Located): Promise<void> {
  const source = at.sibling(`${at.base}.mqt-probe-${suffix()}.tmp`);
  try {
    (await Deno.open(source, { write: true, createNew: true })).close();
  } catch (cause) {
    throw writeError(
      `Could not create a temporary file in ${at.directory}`,
      "The instance directory has to be writable; nothing was changed.",
      cause,
    );
  }
  const published = at.sibling(`${at.base}.mqt-probe-${suffix()}.tmp`);
  try {
    await Deno.link(source, published);
  } catch (cause) {
    throw writeError(
      `Could not publish a file in ${at.directory} without replacing what is already there`,
      NO_LINK_HINT,
      cause,
    );
  } finally {
    await Deno.remove(source).catch(() => {});
    await Deno.remove(published).catch(() => {});
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
}

/** Publish `from` as `to`, or fail because `to` already exists. */
async function linkNoReplace(from: string, to: string): Promise<"published" | "taken"> {
  try {
    await Deno.link(from, to);
    return "published";
  } catch (cause) {
    if (cause instanceof Deno.errors.AlreadyExists) return "taken";
    throw writeError(
      `Could not publish ${to} without replacing what is there`,
      NO_LINK_HINT,
      cause,
    );
  }
}

/**
 * Put a captured file back, or preserve it if the name has been taken.
 *
 * Taken means another process created its own file at the target while this one
 * held the captured copy. That file is newer than anything this run has, so it
 * stays, and the captured bytes go somewhere they are not lost instead.
 */
async function putBack(
  staged: string,
  path: string,
  at: Located,
  context: PublishContext,
): Promise<string | undefined> {
  if (await linkNoReplace(staged, path) === "published") {
    await Deno.remove(staged).catch(() => {});
    await context.durability.syncDirectory(at.directory).catch(() => {});
    return undefined;
  }
  return await preserve(staged, at, context);
}

/** Hand captured bytes to the caller's keeping, or leave them where they are. */
async function preserve(staged: string, at: Located, context: PublishContext): Promise<string> {
  if (context.rescue === undefined) return staged;
  let kept: string;
  try {
    kept = await context.rescue(await Deno.readFile(staged));
  } catch {
    return staged;
  }
  await Deno.remove(staged).catch(() => {});
  await context.durability.syncDirectory(at.directory).catch(() => {});
  return kept;
}

/**
 * Replace, restore or create a file without ever overwriting one.
 *
 * `expected` is the digest the plan was made for; null means the plan was made
 * for there being no file, in which case there is nothing to move aside and
 * publishing no-replace is the entire transaction.
 */
export async function publishFile(
  bytes: Uint8Array,
  options: PublishOptions,
): Promise<PublishOutcome> {
  const at = locate(options.path);
  await assertCanPublish(at);
  const temp = await prewrite(at, bytes, options.durability);

  try {
    await options.gap?.("before-move");

    if (options.expected === null) {
      await options.gap?.("after-move");
      if (await linkNoReplace(temp, options.path) === "taken") {
        throw targetChanged(
          options.path,
          "was created by something else while the installer was working",
        );
      }
      await options.durability.syncDirectory(at.directory);
      return { keptForeignFile: false };
    }

    const staged = await moveAside(options.path, at);
    try {
      const captured = await Deno.readFile(staged);
      if (await sha256Hex(captured) !== options.expected) {
        // Whatever landed between the plan and the move is now safely aside and
        // provably not what this run agreed to replace. It goes straight back.
        const kept = await putBack(staged, options.path, at, options);
        throw targetChanged(options.path, "changed while the installer was working", kept);
      }

      await options.gap?.("after-move");

      if (await linkNoReplace(temp, options.path) === "taken") {
        // Someone published their own file into the name while it was free. It
        // is newer than the payload and newer than what was captured, so it
        // stays, and the captured bytes are preserved rather than forced over
        // it.
        const kept = await preserve(staged, at, options);
        throw targetChanged(
          options.path,
          "was created by something else while the installer was working",
          kept,
        );
      }
    } catch (failure) {
      // Anything at all going wrong between the move and the publish leaves the
      // target's name free and its contents under a private one. Put them back
      // if nothing has taken the name, and let the original failure through: a
      // run that refuses has to leave the instance as it found it.
      if (await exists(staged)) {
        await putBack(staged, options.path, at, options).catch(() => {});
      }
      throw failure;
    }

    // Published. The captured copy has served its purpose: its bytes are the
    // pre-image the caller has already backed up or can reproduce.
    await Deno.remove(staged).catch(() => {});
    await options.durability.syncDirectory(at.directory);
    return { keptForeignFile: false };
  } finally {
    await Deno.remove(temp).catch(() => {});
  }
}

/**
 * Delete a file without ever deleting one this run did not prove.
 *
 * The name is renamed aside first, so the only thing that is ever removed is
 * the captured copy under its private name. A file another process creates at
 * the target afterwards is simply a file this run never saw.
 */
export async function removeFile(options: PublishOptions): Promise<PublishOutcome> {
  if (options.expected === null) {
    throw writeError(
      `Refusing to delete ${options.path} without knowing what is supposed to be there`,
      "This is a bug; nothing was changed.",
    );
  }
  const at = locate(options.path);
  await assertCanPublish(at);
  await options.gap?.("before-move");

  const staged = await moveAside(options.path, at);
  try {
    const captured = await Deno.readFile(staged);
    if (await sha256Hex(captured) !== options.expected) {
      const kept = await putBack(staged, options.path, at, options);
      throw targetChanged(options.path, "changed while the installer was working", kept);
    }

    await options.gap?.("after-move");

    try {
      await Deno.remove(staged);
    } catch (cause) {
      throw writeError(
        `Could not remove ${options.path}`,
        "Close Minecraft and any editor holding the file, then try again.",
        cause,
      );
    }
  } catch (failure) {
    if (await exists(staged)) {
      await putBack(staged, options.path, at, options).catch(() => {});
    }
    throw failure;
  }
  await options.durability.syncDirectory(at.directory);

  let keptForeignFile = false;
  try {
    await Deno.lstat(options.path);
    keptForeignFile = true;
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
  return { keptForeignFile };
}

export interface StagedRecovery {
  /** What happened to the file left behind. */
  outcome: "put-back" | "preserved";
  /** Where the bytes ended up. */
  location: string;
}

/**
 * Finish a transaction a crash interrupted between the move and the publish.
 *
 * The captured file sits beside the target under a name derived from it, so
 * nothing else has to have been recorded for this to work: a run that died
 * between two syscalls left the evidence in the one directory that matters.
 *
 * If the target is still absent, the captured file is what was there and goes
 * back. If something has taken the name since, that file is newer than anything
 * the dead run held, so it stays and the captured bytes are preserved instead.
 */
export async function recoverStaged(
  path: string,
  context: PublishContext,
): Promise<StagedRecovery[]> {
  const at = locate(path);
  const recovered: StagedRecovery[] = [];
  for (const staged of await listStaged(path)) {
    const kept = await putBack(staged, path, at, context);
    recovered.push(
      kept === undefined
        ? { outcome: "put-back", location: path }
        : { outcome: "preserved", location: kept },
    );
  }
  return recovered;
}

/**
 * Files a previous run left captured beside this target, newest-name-last.
 *
 * Read-only, so `status` can say a run was interrupted without being the thing
 * that finishes it.
 */
export async function listStaged(path: string): Promise<string[]> {
  const at = locate(path);
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(at.directory)) {
      if (entry.isSymlink || !entry.isFile) continue;
      const match = STAGED_NAME.exec(entry.name);
      if (match && match[1] === at.base) names.push(entry.name);
    }
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return [];
    throw cause;
  }
  // The suffix is random, so the order carries no meaning -- but a stable one
  // keeps a run with two leftovers reporting the same way twice.
  return names.sort().map((name) => at.sibling(name));
}
