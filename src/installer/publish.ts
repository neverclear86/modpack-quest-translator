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
 *
 * All four steps name a file *inside a directory*, and every one of those names
 * is resolved by the kernel from whichever directory is at the parent's name at
 * the instant the syscall runs. Rename the parent aside and put your own
 * directory -- or a symbolic link to one -- in its place, and each step is
 * still perfectly well-behaved while doing all of its work somewhere the
 * installer was never pointed. So the parent is an identity the transaction
 * binds to, not just a string it prepends; see `Anchor`.
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

const SWAP_HINT = "Close Minecraft and any editor or sync client, make sure nothing else is " +
  "moving the instance's folders about, then run the command again.";

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
 * The directory a transaction agreed to work in, so it can tell when it is no
 * longer working in it.
 *
 * Deno has no `openat`: a name cannot be resolved against a directory handle,
 * so the lookup and the syscall that follows it can never be made one
 * operation. What Deno does have is `stat`, and a directory's device and inode
 * number are an identity that a rename cannot forge and a symbolic link does
 * not share. The transaction records that identity once, at the start, and
 * re-proves it either side of every path operation:
 *
 *   - **before**, so an operation that would resolve its names in somebody
 *     else's directory never happens at all. This is what catches the parent
 *     being swapped in one of the gaps;
 *   - **after**, because an operation that has already returned may have
 *     resolved them there anyway. Nothing can prevent that, but the transaction
 *     can find out, and then put back whatever it moved.
 *
 * Cleanup is the one thing that is never retried through a changed parent.
 * `Deno.remove` deletes whatever a name refers to when it runs, so tidying away
 * "our" temporary file in a directory that is not ours is not housekeeping, it
 * is a deletion of somebody else's file that happens to be called that. A
 * transaction that finds the parent replaced leaves its leftovers behind and
 * says so.
 */
interface Anchor {
  readonly directory: string;
  /** What was there when the transaction started; see `identityOf`. */
  readonly identity: string;
}

/**
 * Everything about the directory at a name that whatever replaces it cannot
 * copy.
 *
 * `stat` describes the directory the names will resolve *in*; `lstat` describes
 * the entry sitting at the name, so a real directory replaced by a symbolic
 * link -- even one leading straight back to it -- reads as a change rather than
 * a match, and a link introduced mid-transaction is never followed. Device and
 * inode number are the strong part, and are what Linux and macOS provide;
 * `birthtime` is what Windows provides instead, and a directory created a
 * moment ago to stand in for one that was renamed away does not share it.
 * `realPath` comes last and proves least -- it catches a link that leads
 * somewhere else, and nothing more.
 *
 * Nothing here is the directory's *contents*: creating a file changes a
 * directory's size and modification time, and every transaction does that to
 * its own directory on purpose.
 *
 * Null when there is nothing at the name at all, which is itself an answer.
 */
async function identityOf(directory: string): Promise<string | null> {
  let target: Deno.FileInfo;
  let entry: Deno.FileInfo;
  try {
    entry = await Deno.lstat(directory);
    target = entry.isSymlink ? await Deno.stat(directory) : entry;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw cause;
  }
  let realPath: string;
  try {
    realPath = await Deno.realPath(directory);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    // Some platforms and permission sets have no answer here. The rest of the
    // identity does not depend on it.
    realPath = "";
  }
  return [
    target.isDirectory ? "directory" : "not-a-directory",
    stamp(target),
    entry.isSymlink ? "through-a-symlink" : "named-directly",
    stamp(entry),
    realPath,
  ].join("|");
}

/** Device, inode and birth time, as far as this platform reports them. */
function stamp(info: Deno.FileInfo): string {
  return `${info.dev ?? "?"}:${info.ino ?? "?"}:${info.birthtime?.getTime() ?? "?"}`;
}

/** Bind to the directory that is there now. It has to be one. */
async function anchorOn(directory: string): Promise<Anchor> {
  const identity = await identityOf(directory);
  if (identity === null) {
    throw writeError(
      `The directory ${directory} is not there`,
      "The instance directory has to exist and be writable; nothing was changed.",
    );
  }
  return { directory, identity };
}

/** Is the bound directory still the one at that name? Answers rather than throws. */
async function stillAnchored(anchor: Anchor): Promise<boolean> {
  try {
    return await identityOf(anchor.directory) === anchor.identity;
  } catch {
    return false;
  }
}

/** Prove it, or stop before the next syscall resolves a name somewhere else. */
async function assertAnchored(anchor: Anchor, detail: string): Promise<void> {
  if (!await stillAnchored(anchor)) throw parentReplaced(anchor, detail);
}

function parentReplaced(anchor: Anchor, detail: string, kept?: string): AppError {
  return new AppError(
    "E_TARGET_MODIFIED",
    `${anchor.directory} is no longer the directory the installer started working in -- it was ` +
      `renamed away, or replaced by another directory or a symbolic link, ${detail}`,
    {
      hint: kept === undefined
        ? `Nothing in whatever took its place was overwritten, and nothing was followed out of ` +
          `it. ${SWAP_HINT}`
        : `Nothing in whatever took its place was overwritten, and the file this run had moved ` +
          `aside is still at ${kept}. ${SWAP_HINT}`,
    },
  );
}

/**
 * Write the bytes beside the target and get them onto the disk.
 *
 * `createNew`, so the temporary file can never be one somebody else is using,
 * and the flush happens here rather than after publishing: the whole point of
 * publishing with a single atomic operation is that there is nothing left to do
 * afterwards that could fail.
 *
 * The directory is proved again between creating the file and writing a byte
 * into it, so a parent swapped around the `open` costs a stranger's directory
 * an empty file and never the payload.
 */
async function prewrite(
  at: Located,
  anchor: Anchor,
  bytes: Uint8Array,
  durability: Durability,
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    await assertAnchored(anchor, "before the new contents could be written beside the target");
    const temp = at.sibling(`${at.base}.mqt-new-${suffix()}.tmp`);
    let file: Deno.FsFile;
    try {
      file = await Deno.open(temp, { write: true, createNew: true });
    } catch (cause) {
      if (cause instanceof Deno.errors.AlreadyExists) continue;
      await assertAnchored(anchor, "while a temporary file was being created in it");
      throw writeError(
        `Could not create a temporary file in ${at.directory}`,
        "The instance directory has to be writable; nothing was changed.",
        cause,
      );
    }
    if (!await stillAnchored(anchor)) {
      file.close();
      throw parentReplaced(anchor, `while ${temp} was being created; nothing was written into it`);
    }
    try {
      let written = 0;
      while (written < bytes.byteLength) written += await file.write(bytes.subarray(written));
      await durability.syncFile(file, temp);
    } catch (cause) {
      file.close();
      await removeOurs(temp, anchor);
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
 * Remove a name this transaction created, but only while the directory is still
 * the one it created it in.
 *
 * This is the whole of the cleanup policy. Every leftover this file makes has a
 * random name in its own namespace, so removing it from the bound directory is
 * housekeeping -- and removing that same name from whatever has taken the
 * directory's place is a deletion of a stranger's file.
 */
async function removeOurs(path: string, anchor: Anchor): Promise<void> {
  if (await stillAnchored(anchor)) await Deno.remove(path).catch(() => {});
}

/**
 * Rename the target to a private name, capturing whatever is there right then.
 *
 * The name is reserved with `createNew` before the rename, so two runs cannot
 * pick the same one and the second cannot silently clobber the first's capture.
 *
 * The reservation proves the name was free *in the bound directory*, which is
 * the only directory it can prove anything about. A swap that lands inside the
 * rename itself resolves both names in whatever arrived instead, where `rename`
 * would replace a file of the same name rather than refuse -- so the guarantee
 * there rests on the name: eight random hex digits behind the target's own,
 * generated moments earlier. The capture is put straight back either way.
 */
async function moveAside(path: string, at: Located, anchor: Anchor): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    await assertAnchored(anchor, "before a name could be reserved to move the target aside");
    const staged = at.sibling(`${at.base}${STAGED}${suffix()}`);
    try {
      (await Deno.open(staged, { write: true, createNew: true })).close();
    } catch (cause) {
      if (cause instanceof Deno.errors.AlreadyExists) continue;
      await assertAnchored(anchor, "while a name was being reserved in it");
      throw writeError(
        `Could not reserve a name in ${at.directory} to move ${at.base} aside`,
        "The instance directory has to be writable; nothing was changed.",
        cause,
      );
    }
    // Proving it here is also the proof the rename below needs: nothing happens
    // in between.
    if (!await stillAnchored(anchor)) {
      await undoReservation(staged);
      throw parentReplaced(anchor, `while the name ${staged} was being reserved`);
    }
    try {
      // Replaces the empty file just reserved, and nothing else: the name was
      // ours from the instant `createNew` returned.
      await Deno.rename(path, staged);
    } catch (cause) {
      await removeOurs(staged, anchor);
      await assertAnchored(anchor, "while the target was being moved aside");
      if (cause instanceof Deno.errors.NotFound) {
        throw targetChanged(path, "was deleted while the installer was working");
      }
      throw writeError(
        `Could not move ${path} aside`,
        "Close Minecraft and any editor holding the file, then try again. Nothing was changed.",
        cause,
      );
    }
    // The rename has already happened. If the directory changed underneath it,
    // both of its names resolved somewhere this transaction never agreed to
    // touch, and what it moved is a stranger's file.
    if (!await stillAnchored(anchor)) throw await putStrangerBack(staged, path, anchor);
    return staged;
  }
  throw writeError(
    `Could not find a free name in ${at.directory} to move ${at.base} aside`,
    "Something is creating files there faster than they can be used.",
  );
}

/**
 * Take back a name reserved a moment ago in a directory that turns out not to
 * be the bound one.
 *
 * `createNew` proved the name was free, and nothing has been written through
 * it, so a zero-length plain file under a name generated at random moments ago
 * is this transaction's own reservation. Anything else -- a symbolic link, a
 * directory, a file with bytes in it -- belongs to somebody and stays exactly
 * where it is.
 */
async function undoReservation(staged: string): Promise<void> {
  try {
    const info = await Deno.lstat(staged);
    if (info.isFile && !info.isSymlink && info.size === 0) await Deno.remove(staged);
  } catch {
    // A spare empty name is a much smaller problem than a wrong removal.
  }
}

/**
 * Put back a file this transaction moved aside in a directory it was not
 * working in.
 *
 * Nothing else here can help those bytes: they are not what the plan was made
 * for, they are not backed up anywhere, and the caller does not know the
 * directory exists. So the rename is simply undone, with `link` rather than
 * `rename` so that a file which has appeared at the name meanwhile is never
 * replaced by one this transaction had no business touching.
 *
 * When even that cannot be done, the capture is *left where it is* -- in the
 * directory it came from, under a name that says a run was interrupted, which
 * is exactly what `recoverStaged` looks for. It is deliberately not handed to
 * `rescue`: that would move a stranger's file into this run's backup
 * directory, which is the loss this path exists to avoid.
 */
async function putStrangerBack(staged: string, path: string, anchor: Anchor): Promise<AppError> {
  try {
    if (await linkNoReplace(staged, path) === "published") {
      await Deno.remove(staged).catch(() => {});
      return parentReplaced(
        anchor,
        "and a file in whatever took its place was moved aside and put straight back",
      );
    }
  } catch {
    // Could not be put back at all. Nothing was replaced trying.
  }
  return parentReplaced(
    anchor,
    "and a file in whatever took its place was moved aside and could not be put back",
    staged,
  );
}

/**
 * Take back a name published in a directory that turns out not to be the bound
 * one -- but only when it really was published *there*.
 *
 * A check made after the call cannot say whether the swap landed before the
 * syscall or after it, and the two want opposite things done. If `link`
 * resolved in the directory that took the name, then `from` and `to` are two
 * names for one file in it, and removing `to` leaves it as it was found --
 * `link` publishes only into a name nothing was using, so nothing is lost. If
 * `link` resolved in the bound directory, then `to` now names something in the
 * other one that this run has never touched, and removing it would be exactly
 * the deletion this file exists to prevent.
 *
 * Asking what the two names refer to *now* tells them apart: hard links to one
 * file share a device and an inode, and nothing else does. Where the platform
 * reports no inode -- Windows -- they cannot be told apart at all, so the name
 * stays. A spare name in somebody's directory is a much smaller problem than a
 * wrong removal from it.
 */
async function undoForeignLink(from: string, to: string): Promise<void> {
  try {
    const published = await Deno.lstat(to);
    const source = await Deno.lstat(from);
    if (!published.isFile || published.isSymlink || published.ino === null) return;
    if (published.dev !== source.dev || published.ino !== source.ino) return;
    await Deno.remove(to);
  } catch {
    // Nothing provable, so nothing removed.
  }
}

/**
 * Prove the directory can publish a name without replacing what is there,
 * before anything is moved aside.
 *
 * Done up front rather than discovered half way through: a filesystem that
 * cannot do this cannot host the protocol at all, and finding that out with the
 * player's file already renamed aside is the one outcome worth avoiding.
 */
async function assertCanPublish(at: Located, anchor: Anchor): Promise<void> {
  await assertAnchored(anchor, "before the filesystem could be tested");
  const source = at.sibling(`${at.base}.mqt-probe-${suffix()}.tmp`);
  try {
    (await Deno.open(source, { write: true, createNew: true })).close();
  } catch (cause) {
    await assertAnchored(anchor, "while the filesystem was being tested");
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
    await assertAnchored(anchor, "while the filesystem was being tested");
    throw writeError(
      `Could not publish a file in ${at.directory} without replacing what is already there`,
      NO_LINK_HINT,
      cause,
    );
  } finally {
    await removeOurs(source, anchor);
    await removeOurs(published, anchor);
  }
  await assertAnchored(anchor, "while the filesystem was being tested");
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
 *
 * A parent that has been replaced stops all of it. Publishing this run's
 * capture through a name that now leads into somebody else's directory is the
 * very overwrite the protocol exists to prevent, and the capture is safer where
 * it already is: in the directory it came from, under the name recovery looks
 * for.
 */
async function putBack(
  staged: string,
  path: string,
  at: Located,
  anchor: Anchor,
  context: PublishContext,
): Promise<string | undefined> {
  if (!await stillAnchored(anchor)) return staged;
  if (await linkNoReplace(staged, path) === "published") {
    if (!await stillAnchored(anchor)) {
      await undoForeignLink(staged, path);
      throw parentReplaced(anchor, "while the file it had moved aside was being put back");
    }
    await Deno.remove(staged).catch(() => {});
    await context.durability.syncDirectory(at.directory).catch(() => {});
    return undefined;
  }
  return await preserve(staged, at, anchor, context);
}

/** Hand captured bytes to the caller's keeping, or leave them where they are. */
async function preserve(
  staged: string,
  at: Located,
  anchor: Anchor,
  context: PublishContext,
): Promise<string> {
  if (context.rescue === undefined || !await stillAnchored(anchor)) return staged;
  let kept: string;
  try {
    kept = await context.rescue(await Deno.readFile(staged));
  } catch {
    return staged;
  }
  await removeOurs(staged, anchor);
  if (await stillAnchored(anchor)) {
    await context.durability.syncDirectory(at.directory).catch(() => {});
  }
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
  const anchor = await anchorOn(at.directory);
  await assertCanPublish(at, anchor);
  const temp = await prewrite(at, anchor, bytes, options.durability);

  try {
    await options.gap?.("before-move");
    await assertAnchored(anchor, "while the transaction was in its first gap");

    if (options.expected === null) {
      await options.gap?.("after-move");
      await assertAnchored(anchor, "while the new file was waiting to be published");
      if (await publish(temp, options.path, anchor) === "taken") {
        throw targetChanged(
          options.path,
          "was created by something else while the installer was working",
        );
      }
      await options.durability.syncDirectory(at.directory);
      return { keptForeignFile: false };
    }

    const staged = await moveAside(options.path, at, anchor);
    try {
      const captured = await Deno.readFile(staged);
      if (await sha256Hex(captured) !== options.expected) {
        // Whatever landed between the plan and the move is now safely aside and
        // provably not what this run agreed to replace. It goes straight back.
        await assertAnchored(anchor, "while the file it had moved aside was being checked");
        const kept = await putBack(staged, options.path, at, anchor, options);
        throw targetChanged(options.path, "changed while the installer was working", kept);
      }

      await options.gap?.("after-move");
      await assertAnchored(anchor, "while the transaction was in its second gap");

      if (await publish(temp, options.path, anchor) === "taken") {
        // Someone published their own file into the name while it was free. It
        // is newer than the payload and newer than what was captured, so it
        // stays, and the captured bytes are preserved rather than forced over
        // it.
        const kept = await preserve(staged, at, anchor, options);
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
      if (await stillAnchored(anchor) && await exists(staged)) {
        await putBack(staged, options.path, at, anchor, options).catch(() => {});
      }
      throw failure;
    }

    // Published. The captured copy has served its purpose: its bytes are the
    // pre-image the caller has already backed up or can reproduce.
    await assertAnchored(anchor, "immediately after the new file was published");
    await Deno.remove(staged).catch(() => {});
    await options.durability.syncDirectory(at.directory);
    return { keptForeignFile: false };
  } finally {
    await removeOurs(temp, anchor);
  }
}

/**
 * The publishing `link`, with the directory proved on the far side of it.
 *
 * `link` copies no bytes, and it resolves both of its names in the same
 * directory, so a swap that lands inside the call cannot carry this run's
 * payload anywhere: the source name resolves in the new directory too. What it
 * can do is add a name there, and only where nothing was using it -- so taking
 * that name back off again leaves the directory as it was found.
 */
async function publish(
  temp: string,
  path: string,
  anchor: Anchor,
): Promise<"published" | "taken"> {
  const outcome = await linkNoReplace(temp, path);
  if (!await stillAnchored(anchor)) {
    if (outcome === "published") await undoForeignLink(temp, path);
    throw parentReplaced(anchor, "while the new file was being published into it");
  }
  return outcome;
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
  const anchor = await anchorOn(at.directory);
  await assertCanPublish(at, anchor);
  await options.gap?.("before-move");
  await assertAnchored(anchor, "while the transaction was in its first gap");

  const staged = await moveAside(options.path, at, anchor);
  try {
    const captured = await Deno.readFile(staged);
    if (await sha256Hex(captured) !== options.expected) {
      await assertAnchored(anchor, "while the file it had moved aside was being checked");
      const kept = await putBack(staged, options.path, at, anchor, options);
      throw targetChanged(options.path, "changed while the installer was working", kept);
    }

    await options.gap?.("after-move");
    await assertAnchored(anchor, "while the captured file was waiting to be deleted");

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
    if (await stillAnchored(anchor) && await exists(staged)) {
      await putBack(staged, options.path, at, anchor, options).catch(() => {});
    }
    throw failure;
  }
  await assertAnchored(anchor, "immediately after the captured file was deleted");
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
 *
 * A directory with no leftovers -- or no directory at all -- has nothing to
 * finish, so binding to it is not worth failing over. Once there is something
 * to put back, the same identity has to hold for every one of them.
 */
export async function recoverStaged(
  path: string,
  context: PublishContext,
): Promise<StagedRecovery[]> {
  const at = locate(path);
  const identity = await identityOf(at.directory);
  if (identity === null) return [];
  const anchor: Anchor = { directory: at.directory, identity };

  const recovered: StagedRecovery[] = [];
  for (const staged of await listStaged(path)) {
    await assertAnchored(anchor, "while an interrupted transaction was being finished");
    const kept = await putBack(staged, path, at, anchor, context);
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
