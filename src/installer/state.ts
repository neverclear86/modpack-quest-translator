import { AppError } from "../errors.ts";
import { writeFileAtomic } from "../util/fs.ts";
import { instanceError } from "./instance.ts";
import { currentOs, joinNative, type OsKind } from "./paths.ts";

export const STATE_FORMAT_VERSION = 1;
export const STATE_FILE = "state.json";

/** Enough to explain what happened to an instance without growing forever. */
export const HISTORY_LIMIT = 200;

export interface InstallRecord {
  bundleId: string;
  installedSha256: string;
  installedAt: string;
  /** `backups/<name>.bak`, relative to the installer directory. */
  originalBackup?: string;
  originalSha256?: string;
  originalWasAbsent: boolean;
  toolVersion: string;
}

export interface InstallEvent {
  event: "install";
  target: string;
  at: string;
  bundleId: string;
  installedSha256: string;
  backup?: string;
}

export interface UninstallEvent {
  event: "uninstall";
  target: string;
  at: string;
  restoredFrom?: string;
  /** True when the restore was "there was no file here before", i.e. a delete. */
  deleted?: boolean;
}

export type HistoryEvent = InstallEvent | UninstallEvent;

export interface InstallerState {
  formatVersion: number;
  /** Keyed by instance-relative target path. */
  installs: Record<string, InstallRecord>;
  history: HistoryEvent[];
}

export interface LoadedState {
  state: InstallerState;
  /** Set when the file existed but could not be used; the run continues. */
  warning?: string;
}

export function emptyState(): InstallerState {
  return { formatVersion: STATE_FORMAT_VERSION, installs: {}, history: [] };
}

export function statePath(installerDirectory: string, os: OsKind = currentOs()): string {
  return joinNative(os, installerDirectory, STATE_FILE);
}

/**
 * `state.json` has to be a real file, or nothing.
 *
 * The directory it lives in is proven to be inside the instance by
 * `BackupStore.resolveInstallerDirectory`; this is the leaf that walk does not
 * cover, and a link planted here would have us reading -- and, on the next
 * atomic rename, replacing -- a file somewhere else entirely.
 */
async function assertRealStateFile(path: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return;
    throw instanceError(`${path} could not be inspected`, undefined, cause);
  }
  if (info.isSymlink) {
    throw instanceError(
      `${path} is a symbolic link, which this installer will not follow`,
      "Delete the link; the installer keeps its state inside the instance, nowhere else.",
    );
  }
  if (info.isDirectory) {
    throw instanceError(`${path} is a directory, but the installer keeps its state in a file`);
  }
}

/**
 * Read `state.json`, tolerating everything except a version this installer
 * would misread.
 *
 * A lost or truncated state file is recoverable by design: the backup sidecars
 * still say what every backup is and which target it belongs to, so uninstall
 * works without it. Refusing to run because a bookkeeping file is damaged would
 * turn a recoverable situation into a stuck one.
 */
export async function loadState(
  installerDirectory: string,
  os: OsKind = currentOs(),
): Promise<LoadedState> {
  const path = statePath(installerDirectory, os);
  await assertRealStateFile(path);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return { state: emptyState() };
    return {
      state: emptyState(),
      warning: `${STATE_FILE} could not be read (${describe(cause)}); ` +
        `continuing from the backup records on disk`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      state: emptyState(),
      warning: `${STATE_FILE} is not valid JSON; continuing from the backup records on disk`,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      state: emptyState(),
      warning: `${STATE_FILE} is not a JSON object; continuing from the backup records on disk`,
    };
  }

  const body = raw as Record<string, unknown>;
  const formatVersion = body.formatVersion;
  if (typeof formatVersion === "number" && formatVersion > STATE_FORMAT_VERSION) {
    // The one thing that is not recoverable: rewriting a newer state file would
    // discard whatever the newer installer recorded in it.
    throw instanceError(
      `${path} was written by a newer version of the installer ` +
        `(formatVersion ${formatVersion})`,
      "Use the installer that set this instance up.",
    );
  }

  const state = emptyState();
  const installs = body.installs;
  if (typeof installs === "object" && installs !== null && !Array.isArray(installs)) {
    for (const [target, value] of Object.entries(installs as Record<string, unknown>)) {
      const record = parseInstallRecord(value);
      if (record) state.installs[target] = record;
    }
  }
  const history = body.history;
  if (Array.isArray(history)) {
    for (const value of history) {
      const event = parseHistoryEvent(value);
      if (event) state.history.push(event);
    }
    state.history = state.history.slice(-HISTORY_LIMIT);
  }
  return { state };
}

/** Written atomically: a crash leaves the previous state, never a half file. */
export async function saveState(
  installerDirectory: string,
  state: InstallerState,
  os: OsKind = currentOs(),
): Promise<void> {
  const body: InstallerState = {
    formatVersion: STATE_FORMAT_VERSION,
    installs: state.installs,
    history: state.history.slice(-HISTORY_LIMIT),
  };
  const path = statePath(installerDirectory, os);
  await assertRealStateFile(path);
  try {
    await writeFileAtomic(path, `${JSON.stringify(body, null, 2)}\n`);
  } catch (cause) {
    throw new AppError("E_WRITE", `Could not record the install state in ${installerDirectory}`, {
      hint: "The install itself succeeded; re-running it will record the state.",
      cause,
    });
  }
}

function parseInstallRecord(value: unknown): InstallRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const installedSha256 = body.installedSha256;
  // Without a digest there is no way to tell an untouched install from an
  // edited one, and a half-trusted record is worse than none.
  if (typeof installedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(installedSha256)) {
    return undefined;
  }
  const record: InstallRecord = {
    bundleId: stringOr(body.bundleId, "unknown"),
    installedSha256,
    installedAt: stringOr(body.installedAt, "unknown"),
    originalWasAbsent: body.originalWasAbsent === true,
    toolVersion: stringOr(body.toolVersion, "unknown"),
  };
  if (typeof body.originalBackup === "string") record.originalBackup = body.originalBackup;
  if (typeof body.originalSha256 === "string") record.originalSha256 = body.originalSha256;
  return record;
}

function parseHistoryEvent(value: unknown): HistoryEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const target = body.target;
  const at = body.at;
  if (typeof target !== "string" || typeof at !== "string") return undefined;

  if (body.event === "install") {
    const installedSha256 = body.installedSha256;
    if (typeof installedSha256 !== "string") return undefined;
    const event: InstallEvent = {
      event: "install",
      target,
      at,
      bundleId: stringOr(body.bundleId, "unknown"),
      installedSha256,
    };
    if (typeof body.backup === "string") event.backup = body.backup;
    return event;
  }
  if (body.event === "uninstall") {
    const event: UninstallEvent = { event: "uninstall", target, at };
    if (typeof body.restoredFrom === "string") event.restoredFrom = body.restoredFrom;
    if (body.deleted === true) event.deleted = true;
    return event;
  }
  return undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
