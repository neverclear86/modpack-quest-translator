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
 * for files this tool owns outright -- its cache, its `state.json`, the archives
 * it writes -- and wrong for a file inside somebody's Minecraft instance, where
 * "whatever is there" may be a modpack update that arrived a millisecond ago.
 * Those go through `installer/publish.ts`, which cannot overwrite anything.
 */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const durability = options.durability ?? currentDurability();
  const directory = dirnameOf(path);
  const temp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;

  try {
    await Deno.mkdir(directory, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.AlreadyExists)) {
      throw new AppError("E_WRITE", `Could not create directory ${directory}`, { cause });
    }
  }

  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temp, { write: true, create: true, truncate: true });
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
