import { AppError } from "../errors.ts";

export type DurabilityOs = "windows" | "posix";

/**
 * Getting bytes onto the disk, as opposed to into the page cache.
 *
 * Injected rather than called directly, so a filesystem that refuses to flush
 * can be tested without one -- and so the difference between the two platforms
 * is stated in one place instead of being implied by a swallowed error.
 */
export interface Durability {
  /** Flush a file's bytes and metadata. */
  syncFile(file: Deno.FsFile, path: string): Promise<void>;
  /**
   * Flush a directory, so a name created or renamed inside it survives a power
   * cut. A file's contents being durable says nothing about the entry that
   * names it.
   */
  syncDirectory(path: string): Promise<void>;
}

function writeError(message: string, cause: unknown): AppError {
  return new AppError("E_WRITE", message, {
    hint: "The disk may be full, read-only, or failing. Nothing further was written.",
    cause,
  });
}

async function syncFile(file: Deno.FsFile, path: string): Promise<void> {
  try {
    await file.sync();
  } catch (cause) {
    throw writeError(`Could not flush ${path} to the disk`, cause);
  }
}

/**
 * POSIX: open the directory read-only and `fsync` the descriptor, which is the
 * portable way to make a `create` or a `rename` inside it durable.
 */
const POSIX: Durability = {
  syncFile,
  async syncDirectory(path: string): Promise<void> {
    let handle: Deno.FsFile;
    try {
      handle = await Deno.open(path, { read: true });
    } catch (cause) {
      throw writeError(`Could not open ${path} to flush it to the disk`, cause);
    }
    try {
      await handle.sync();
    } catch (cause) {
      throw writeError(`Could not flush the directory ${path} to the disk`, cause);
    } finally {
      handle.close();
    }
  },
};

/**
 * Windows: there is no per-directory flush to call. Opening a directory as a
 * file fails outright, and the nearest equivalent -- `FlushFileBuffers` on a
 * volume handle -- needs administrator rights this installer deliberately never
 * asks for. NTFS journals directory metadata, so a rename that has returned is
 * recoverable by the filesystem itself.
 *
 * This is therefore a documented no-op rather than a swallowed failure: the
 * guarantee we can establish on Windows is "the file's bytes are durable and
 * the rename has returned", and that is what is claimed, no more.
 */
const WINDOWS: Durability = {
  syncFile,
  syncDirectory(_path: string): Promise<void> {
    return Promise.resolve();
  },
};

export function durabilityFor(os: DurabilityOs): Durability {
  return os === "windows" ? WINDOWS : POSIX;
}

/** What this process is actually running on. */
export function currentDurability(): Durability {
  return durabilityFor(Deno.build.os === "windows" ? "windows" : "posix");
}
