import { AppError } from "../errors.ts";
import { currentDurability, type Durability } from "../util/durable.ts";
import { basenameOf } from "../util/fs.ts";
import { sha256Hex } from "../util/hash.ts";
import { assertPayloadPath } from "./bundle.ts";
import { createDirectoryInsideRoot, resolveInsideRoot } from "./instance.ts";
import { currentOs, joinNative, type OsKind } from "./paths.ts";

/** Bumped only for a change an older installer could not read correctly. */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Everything the installer remembers lives inside the instance, so backups
 * travel with a copied or moved instance and no home directory, registry key or
 * administrator right is ever involved.
 */
export const INSTALLER_DIR = ".mqt-installer";
export const BACKUPS_DIR = "backups";

export type BackupKind =
  /** The file that was there before we first replaced anything. */
  | "original"
  /** Sentinel: there was no file before install, so restoring means deleting. */
  | "absent"
  /** An installed payload the user then edited, kept by `uninstall --force`. */
  | "modified-install";

/** Only these two are restore candidates. */
export const RESTORABLE_KINDS: readonly BackupKind[] = ["original", "absent"];

export interface BackupSidecar {
  formatVersion: number;
  kind: BackupKind;
  targetRelativePath: string;
  capturedAt: string;
  sha256: string;
  sizeBytes: number;
  toolVersion: string;
  capturedByBundleId: string;
}

export interface BackupRecord {
  /** File name inside `backups/`. */
  name: string;
  /** Path relative to the installer directory, as stored in state.json. */
  relativePath: string;
  backupPath: string;
  sidecarPath: string;
  sidecar: BackupSidecar;
  /** True when an identical backup already existed and was reused. */
  reused: boolean;
}

export interface BackupScan {
  records: BackupRecord[];
  /** Sidecars that could not be read, with the reason, for E_BACKUP reporting. */
  skipped: { path: string; reason: string }[];
}

export interface VerifiedBackup {
  ok: boolean;
  bytes?: Uint8Array;
  reason?: string;
}

export interface CaptureArgs {
  relativePath: string;
  /** The bytes to preserve, or null to record that there was no file. */
  bytes: Uint8Array | null;
  kind: BackupKind;
  /** ISO-8601, injected rather than read from the clock so runs are testable. */
  capturedAt: string;
}

export interface BackupStoreOptions {
  toolVersion: string;
  bundleId: string;
  os?: OsKind;
  /** How bytes are pushed past the page cache. Injected so faults are testable. */
  durability?: Durability;
}

export function backupError(message: string, hint?: string, cause?: unknown): AppError {
  return new AppError("E_BACKUP", message, { hint, cause });
}

/** `20260825T142233Z` — sortable, filename-safe, and readable at a glance. */
export function compactTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw backupError(`${JSON.stringify(iso)} is not a usable timestamp`);
  }
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * The on-disk backup inventory for one instance.
 *
 * Sidecars, not `state.json`, are the authority on what backups exist: state
 * can be lost or truncated, and the whole point of this directory is to survive
 * that. Nothing here is ever overwritten or deleted -- backups are created with
 * `createNew`, and uninstall only ever appends history.
 */
export class BackupStore {
  readonly #root: string;
  readonly #os: OsKind;
  readonly #toolVersion: string;
  readonly #bundleId: string;
  readonly #durability: Durability;

  constructor(instanceRoot: string, options: BackupStoreOptions) {
    this.#root = instanceRoot;
    this.#os = options.os ?? currentOs();
    this.#toolVersion = options.toolVersion;
    this.#bundleId = options.bundleId;
    this.#durability = options.durability ?? currentDurability();
  }

  /**
   * `<instance>/.mqt-installer`, as a path. Good enough to name in a message;
   * not proof that it is safe to open. Use `resolveInstallerDirectory` for that.
   */
  get installerDirectory(): string {
    return joinNative(this.#os, this.#root, INSTALLER_DIR);
  }

  get backupsDirectory(): string {
    return joinNative(this.#os, this.installerDirectory, BACKUPS_DIR);
  }

  /**
   * The same path, proven symlink-free and inside the instance, right now.
   *
   * Re-proved at each boundary rather than cached: the whole point of the check
   * is that the directory could have been swapped since the last one.
   */
  async resolveInstallerDirectory(): Promise<string> {
    return (await resolveInsideRoot(this.#root, [INSTALLER_DIR], {
      os: this.#os,
      expect: "directory",
    })).path;
  }

  async resolveBackupsDirectory(): Promise<string> {
    return (await resolveInsideRoot(this.#root, [INSTALLER_DIR, BACKUPS_DIR], {
      os: this.#os,
      expect: "directory",
    })).path;
  }

  /**
   * `backups/`, creating it and `.mqt-installer/` a level at a time.
   *
   * `mkdir --recursive` would walk straight through a symlinked
   * `.mqt-installer`; this cannot.
   */
  async createBackupsDirectory(): Promise<string> {
    const { path, created } = await createDirectoryInsideRoot(
      this.#root,
      [INSTALLER_DIR, BACKUPS_DIR],
      { os: this.#os },
    );
    // A directory that only exists in the page cache is a directory the backup
    // inside it can vanish with. Flush each new level's *parent*, deepest
    // first, so the whole chain down to `backups/` is on the disk.
    for (const directory of [...created].reverse()) {
      await this.#flushDirectory(parentOf(directory, this.#os));
    }
    return path;
  }

  /**
   * A directory whose new entries have to survive a power cut, because what
   * comes next is replacing the only other copy of the file just backed up.
   */
  async #flushDirectory(path: string): Promise<void> {
    try {
      await this.#durability.syncDirectory(path);
    } catch (cause) {
      throw backupError(
        `The backup was written but ${path} could not be flushed to the disk, so the backup ` +
          `is not guaranteed to survive a power cut. Nothing was changed.`,
        BACKUP_HINT,
        cause,
      );
    }
  }

  /** A backup or sidecar file, proven to be a real file inside `backups/`. */
  async resolveBackupFile(name: string): Promise<string> {
    assertBackupName(name);
    return (await resolveInsideRoot(this.#root, [INSTALLER_DIR, BACKUPS_DIR, name], {
      os: this.#os,
      expect: "file",
    })).path;
  }

  async scan(): Promise<BackupScan> {
    const records: BackupRecord[] = [];
    const skipped: { path: string; reason: string }[] = [];

    const directory = await this.resolveBackupsDirectory();
    let names: string[];
    try {
      names = [];
      for await (const entry of Deno.readDir(directory)) {
        if (!entry.name.endsWith(".bak.json")) continue;
        // readDir does not follow links, so a planted one shows up here rather
        // than as a file we would go on to read through.
        if (entry.isSymlink) {
          skipped.push({
            path: joinNative(this.#os, directory, entry.name),
            reason: `${entry.name} is a symbolic link, which this installer will not follow`,
          });
          continue;
        }
        if (entry.isFile) names.push(entry.name);
      }
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return { records: [], skipped: [] };
      throw backupError(`Could not read ${directory}`, undefined, cause);
    }
    names.sort();

    for (const name of names) {
      let sidecarPath: string;
      try {
        sidecarPath = await this.resolveBackupFile(name);
      } catch (error) {
        skipped.push({
          path: joinNative(this.#os, directory, name),
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      let sidecar: BackupSidecar;
      try {
        sidecar = parseSidecar(await Deno.readTextFile(sidecarPath), sidecarPath);
      } catch (error) {
        if (error instanceof AppError && error.details?.unreadable === true) {
          skipped.push({ path: sidecarPath, reason: error.message });
          continue;
        }
        throw error;
      }
      const backupName = name.slice(0, -".json".length);
      records.push({
        name: backupName,
        relativePath: `${BACKUPS_DIR}/${backupName}`,
        backupPath: joinNative(this.#os, directory, backupName),
        sidecarPath,
        sidecar,
        reused: false,
      });
    }
    return { records, skipped };
  }

  /** Read a backup and prove it is still exactly what was captured. */
  async verify(record: BackupRecord): Promise<VerifiedBackup> {
    // An "absent" sentinel is a zero-byte file, so it verifies through exactly
    // the same size-and-digest path as a real backup rather than a special case.
    let bytes: Uint8Array;
    let path: string;
    try {
      path = await this.resolveBackupFile(record.name);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    try {
      bytes = await Deno.readFile(path);
    } catch (cause) {
      const reason = cause instanceof Deno.errors.NotFound
        ? `the backup file is missing: ${path}`
        : `the backup file could not be read: ${path}`;
      return { ok: false, reason };
    }
    if (bytes.byteLength !== record.sidecar.sizeBytes) {
      return {
        ok: false,
        reason: `${record.name} is ${bytes.byteLength} bytes, but ${record.sidecar.sizeBytes} ` +
          `bytes were captured`,
      };
    }
    const digest = await sha256Hex(bytes);
    if (digest !== record.sidecar.sha256) {
      return { ok: false, reason: `${record.name} no longer matches its recorded digest` };
    }
    return { ok: true, bytes };
  }

  /**
   * Preserve `bytes` under a name that cannot collide, or reuse an identical
   * backup that is already there.
   *
   * The reuse is what makes an interrupted run converge instead of accumulating
   * near-duplicates: a crash between capturing the backup and writing the
   * payload leaves an orphan, and the next run finds it by digest.
   */
  async capture(args: CaptureArgs): Promise<BackupRecord> {
    const relativePath = assertPayloadPath(args.relativePath);
    const data = args.bytes ?? new Uint8Array(0);
    const sha256 = await sha256Hex(data);

    const scan = await this.scan();
    const existing = scan.records.find((record) =>
      record.sidecar.targetRelativePath === relativePath &&
      record.sidecar.kind === args.kind &&
      record.sidecar.sha256 === sha256
    );
    if (existing && (await this.verify(existing)).ok) return { ...existing, reused: true };

    const sidecar: BackupSidecar = {
      formatVersion: BACKUP_FORMAT_VERSION,
      kind: args.kind,
      targetRelativePath: relativePath,
      capturedAt: args.capturedAt,
      sha256,
      sizeBytes: data.byteLength,
      toolVersion: this.#toolVersion,
      capturedByBundleId: this.#bundleId,
    };

    const directory = await this.createBackupsDirectory();
    const stem = `${basenameOf(relativePath)}.${compactTimestamp(args.capturedAt)}`;
    const suffix = sha256.slice(0, 12);

    for (let counter = 0; counter < 1000; counter++) {
      const name = `${stem}-${counter}.${suffix}.bak`;
      const backupPath = await this.resolveBackupFile(name);
      let file: Deno.FsFile;
      try {
        file = await Deno.open(backupPath, { write: true, createNew: true });
      } catch (cause) {
        if (cause instanceof Deno.errors.AlreadyExists) continue;
        throw backupError(`Could not create the backup ${backupPath}`, BACKUP_HINT, cause);
      }
      try {
        let written = 0;
        while (written < data.byteLength) written += await file.write(data.subarray(written));
        await this.#durability.syncFile(file, backupPath);
      } catch (cause) {
        throw backupError(`Could not write the backup ${backupPath}`, BACKUP_HINT, cause);
      } finally {
        file.close();
      }

      const sidecarPath = await this.resolveBackupFile(`${name}.json`);
      await writeSidecar(sidecarPath, sidecar, this.#durability);
      // Both files are durable; the entries that name them are not until the
      // directory holding them is flushed too. Only then may the caller go on
      // to replace the file this backup is the only remaining copy of.
      await this.#flushDirectory(directory);
      return {
        name,
        relativePath: `${BACKUPS_DIR}/${name}`,
        backupPath,
        sidecarPath,
        sidecar,
        reused: false,
      };
    }

    throw backupError(
      `Could not find a free backup name for ${relativePath}`,
      `Something is creating files in ${directory} faster than they can be used.`,
    );
  }
}

/**
 * Every name the store puts on disk is generated from a payload basename, a
 * timestamp and a digest, so this can never legitimately fail. It is checked
 * anyway, because it is the last place a name could turn into a path.
 */
function assertBackupName(name: string): void {
  if (name.length === 0 || name.length > 255 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw backupError(`${JSON.stringify(name)} is not a usable backup file name`);
  }
}

const BACKUP_HINT =
  "The instance directory has to be writable for the original file to be preserved; " +
  "nothing was changed.";

/**
 * The sidecar is written after its backup and flushed, so a crash between the
 * two leaves an unlabelled `.bak` that is ignored rather than a label with no
 * bytes behind it.
 */
async function writeSidecar(
  path: string,
  sidecar: BackupSidecar,
  durability: Durability,
): Promise<void> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(sidecar, null, 2)}\n`);
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { write: true, create: true, truncate: true });
  } catch (cause) {
    throw backupError(`Could not write the backup record ${path}`, BACKUP_HINT, cause);
  }
  try {
    let written = 0;
    while (written < bytes.byteLength) written += await file.write(bytes.subarray(written));
    await durability.syncFile(file, path);
  } catch (cause) {
    throw backupError(`Could not write the backup record ${path}`, BACKUP_HINT, cause);
  } finally {
    file.close();
  }
}

/** The directory a path sits in, in the store's own separator. */
function parentOf(path: string, os: OsKind): string {
  const separator = os === "windows" ? "\\" : "/";
  const index = path.lastIndexOf(separator);
  return index <= 0 ? path : path.slice(0, index);
}

function unreadable(message: string, cause?: unknown): AppError {
  return new AppError("E_BACKUP", message, { cause, details: { unreadable: true } });
}

export function parseSidecar(text: string, path: string): BackupSidecar {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw unreadable(`${path} is not valid JSON`, cause);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw unreadable(`${path} is not a JSON object`);
  }
  const body = raw as Record<string, unknown>;

  const formatVersion = body.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion)) {
    throw unreadable(`${path} has no integer formatVersion`);
  }
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    // Not skippable: a backup this installer cannot read is exactly the file it
    // must not step around, because stepping around it is how an original is
    // lost.
    throw backupError(
      `${path} was written by a newer version of the installer ` +
        `(formatVersion ${formatVersion})`,
      "Use the installer that created this instance's backups.",
    );
  }

  const kind = body.kind;
  if (kind !== "original" && kind !== "absent" && kind !== "modified-install") {
    throw unreadable(`${path} has the unknown backup kind ${JSON.stringify(kind)}`);
  }
  const sha256 = body.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw unreadable(`${path} has no usable sha256`);
  }
  const sizeBytes = body.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw unreadable(`${path} has no usable sizeBytes`);
  }
  const targetRelativePath = body.targetRelativePath;
  if (typeof targetRelativePath !== "string" || targetRelativePath.length === 0) {
    throw unreadable(`${path} has no targetRelativePath`);
  }
  const capturedAt = body.capturedAt;
  if (typeof capturedAt !== "string" || Number.isNaN(new Date(capturedAt).getTime())) {
    throw unreadable(`${path} has no usable capturedAt`);
  }

  return {
    formatVersion,
    kind,
    targetRelativePath,
    capturedAt,
    sha256,
    sizeBytes,
    toolVersion: typeof body.toolVersion === "string" ? body.toolVersion : "unknown",
    capturedByBundleId: typeof body.capturedByBundleId === "string"
      ? body.capturedByBundleId
      : "unknown",
  };
}
