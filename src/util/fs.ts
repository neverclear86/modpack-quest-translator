import { AppError } from "../errors.ts";
import { currentDurability, type Durability } from "./durable.ts";

export interface AtomicWriteOptions {
  /** How bytes are pushed past the page cache. Injected so faults are testable. */
  durability?: Durability;
}

/**
 * Write a file atomically: temp file in the destination directory, then rename.
 * A rename within a directory is atomic on every platform we target, so a
 * cancelled run can never leave a half-written cache or output file.
 *
 * A flush that fails is an error, not a shrug. The bytes reaching the page
 * cache is not the same as the bytes reaching the disk, and the caller may well
 * be about to destroy the only other copy of them.
 *
 * The rename replaces whatever is at the destination, which makes this right
 * for files this tool owns outright -- its cache, its `state.json` -- and wrong
 * for a name something else may have taken since it was last looked at. A file
 * inside somebody's Minecraft instance goes through `installer/publish.ts`; an
 * output whose name was only checked at the start of the run goes through
 * `writeFileNoClobber` below. Neither can overwrite anything.
 */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const durability = options.durability ?? currentDurability();
  const directory = dirnameOf(path);
  await ensureDirectory(directory);
  const temp = await writeTempBeside(path, bytes, durability);

  try {
    await Deno.rename(temp, path);
  } catch (cause) {
    await Deno.remove(temp).catch(() => {});
    throw new AppError("E_WRITE", `Could not move the temporary file into place at ${path}`, {
      cause,
    });
  }

  // The new contents are durable and the rename has returned; the entry that
  // names them is not durable until the directory itself is flushed.
  await durability.syncDirectory(directory);
}

const NO_LINK_HINT =
  "This filesystem cannot publish a file without replacing whatever is already there, and " +
  "replacing it blindly is how somebody else's file gets overwritten. Write the output to a " +
  "filesystem that supports hard links (NTFS, ext4, APFS, btrfs), or pass --force to replace " +
  "whatever is at the destination.";

/**
 * Write a file the way `writeFileAtomic` does, and publish it into a name
 * nothing is using -- refusing rather than replacing one that is.
 *
 * Checking that a path is free and then renaming onto it is two operations on a
 * pathname, and a pathname is not a lock: everything a run proves about the
 * name it is about to write happens *before* the rename, and another run, an
 * editor or a sync client can take the name in between. So publishing is a
 * single operation that cannot overwrite: `Deno.link` fails with `AlreadyExists`
 * rather than replacing, which makes the kernel, not a prior check, the thing
 * that decides who was first. This is the same primitive and the same reasoning
 * as `installer/publish.ts`, on a target this tool named rather than one it
 * found.
 *
 * Answers `null` when the name was taken, so the caller can say what that means
 * in its own vocabulary. Whatever took it is never read, moved or touched.
 */
export async function writeFileNoClobber(
  path: string,
  data: Uint8Array | string,
  options: AtomicWriteOptions = {},
): Promise<boolean> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const durability = options.durability ?? currentDurability();
  const directory = dirnameOf(path);
  await ensureDirectory(directory);
  const temp = await writeTempBeside(path, bytes, durability);

  try {
    try {
      await Deno.link(temp, path);
    } catch (cause) {
      if (cause instanceof Deno.errors.AlreadyExists) return false;
      throw new AppError("E_WRITE", `Could not publish ${path} without replacing what is there`, {
        cause,
        hint: NO_LINK_HINT,
      });
    }
    await durability.syncDirectory(directory);
    return true;
  } finally {
    await Deno.remove(temp).catch(() => {});
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await Deno.mkdir(directory, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.AlreadyExists)) {
      throw new AppError("E_WRITE", `Could not create directory ${directory}`, { cause });
    }
  }
}

/**
 * Put the bytes in a file of their own beside the target and flush them, so
 * that whichever way they are published afterwards is a single operation with
 * nothing left to fail after it.
 */
async function writeTempBeside(
  path: string,
  bytes: Uint8Array,
  durability: Durability,
): Promise<string> {
  const temp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temp, { write: true, createNew: true });
    let written = 0;
    while (written < bytes.byteLength) {
      written += await file.write(bytes.subarray(written));
    }
    await durability.syncFile(file, temp);
  } catch (cause) {
    file?.close();
    file = undefined;
    await Deno.remove(temp).catch(() => {});
    if (cause instanceof AppError) throw cause;
    throw new AppError("E_WRITE", `Could not write ${path}`, { cause });
  } finally {
    file?.close();
  }
  return temp;
}

export function dirnameOf(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  const index = normalised.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return normalised.slice(0, index);
}

export function basenameOf(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  const index = normalised.lastIndexOf("/");
  return index < 0 ? normalised : normalised.slice(index + 1);
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .join("/");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
