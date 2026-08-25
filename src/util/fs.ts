import { AppError } from "../errors.ts";

/**
 * Write a file atomically: temp file in the destination directory, then rename.
 * A rename within a directory is atomic on every platform we target, so a
 * cancelled run can never leave a half-written cache or output file.
 */
export async function writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
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
    await syncToDisk(file);
  } catch (cause) {
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
}

/**
 * Flush the file to disk, on both supported Deno majors.
 *
 * Deno 2 removed `Deno.fsync` along with the resource ids it took, so
 * `FsFile.sync` is the only option there. Deno 1.41 has `FsFile.sync` on the
 * object but gates it behind `--unstable-fs`, and calling a gated API *aborts
 * the process* instead of throwing -- a try/catch cannot rescue it, so the
 * method cannot simply be attempted. `Deno.fsync` is present on exactly the
 * majors where the method may be gated and absent on exactly the majors where
 * the method is the only option, which makes its presence the reliable test.
 *
 * Durability is best effort either way: the rename in writeFileAtomic is what
 * actually makes the write atomic, and a filesystem that declines to flush is
 * not a reason to fail a run.
 */
async function syncToDisk(file: Deno.FsFile): Promise<void> {
  const legacyFsync = (Deno as unknown as { fsync?: (rid: number) => Promise<void> }).fsync;
  try {
    if (legacyFsync) await legacyFsync((file as unknown as { rid: number }).rid);
    else await file.sync();
  } catch {
    // Not fatal.
  }
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
