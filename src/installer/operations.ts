import { AppError } from "../errors.ts";
import { writeFileAtomic } from "../util/fs.ts";
import { sha256Hex } from "../util/hash.ts";
import { type BackupKind, type BackupRecord, BackupStore, RESTORABLE_KINDS } from "./backup.ts";
import { loadBundle, loadBundleManifest, type LoadedBundle } from "./bundle.ts";
import {
  type ResolvedInstance,
  type ResolvedTarget,
  resolveInstanceRoot,
  resolveTargetPath,
} from "./instance.ts";
import { currentOs, type OsKind } from "./paths.ts";
import { type InstallerState, loadState, saveState } from "./state.ts";

export interface OperationContext {
  bundleDir: string;
  instanceInput: string;
  force: boolean;
  /** Injected rather than read from the clock, so runs are testable. */
  now: () => Date;
  os?: OsKind;
}

export type InstallStatus =
  /** The payload replaced something else, or landed where nothing was. */
  | "installed"
  /** Already exactly this payload: nothing was written. */
  | "already-installed"
  /** Already this payload, rewritten because --force asked for it. */
  | "reinstalled"
  /** A different payload of ours was there: replaced, original untouched. */
  | "upgraded";

export interface BackupSummary {
  relativePath: string;
  kind: BackupKind;
  reused: boolean;
}

export interface InstallTargetOutcome {
  relativePath: string;
  path: string;
  status: InstallStatus;
  installedSha256: string;
  backup?: BackupSummary;
}

export interface InstallResult {
  bundleId: string;
  instance: ResolvedInstance;
  targets: InstallTargetOutcome[];
  warnings: string[];
}

export type UninstallStatus = "restored" | "deleted";

export interface UninstallTargetOutcome {
  relativePath: string;
  path: string;
  status: UninstallStatus;
  restoredFrom: string;
  /** Set by --force: where the user's edited file was preserved. */
  keptModifiedAs?: string;
}

export interface UninstallResult {
  bundleId: string;
  instance: ResolvedInstance;
  targets: UninstallTargetOutcome[];
  warnings: string[];
}

export interface StatusTarget {
  relativePath: string;
  path: string;
  present: boolean;
  /** True when the file on disk is byte-for-byte this bundle's payload. */
  matchesBundle: boolean;
  /** True when we have a record and the file has changed since we wrote it. */
  modified: boolean;
  recordedBundleId?: string;
  installedAt?: string;
  /** A verified backup that uninstall could restore from. */
  restorableFrom?: string;
  originalWasAbsent?: boolean;
}

export interface StatusResult {
  bundleId: string;
  instance: ResolvedInstance;
  targets: StatusTarget[];
  warnings: string[];
}

interface Session {
  bundle: LoadedBundle;
  instance: ResolvedInstance;
  store: BackupStore;
  state: InstallerState;
  backups: BackupRecord[];
  warnings: string[];
  os: OsKind;
}

/**
 * Everything an operation needs, gathered before anything is written: the
 * verified bundle, the resolved instance, the on-disk backup inventory and
 * whatever state.json still holds.
 */
async function open(
  context: OperationContext,
  bundle: LoadedBundle,
): Promise<Session> {
  const os = context.os ?? currentOs();
  const instance = await resolveInstanceRoot(context.instanceInput, os);
  const store = new BackupStore(instance.root, {
    toolVersion: bundle.manifest.toolVersion,
    bundleId: bundle.manifest.bundleId,
    os,
  });
  const scan = await store.scan();
  const loaded = await loadState(store.installerDirectory, os);
  const warnings: string[] = [];
  if (loaded.warning) warnings.push(loaded.warning);
  for (const skipped of scan.skipped) {
    warnings.push(`Ignoring an unreadable backup record: ${skipped.reason}`);
  }
  return {
    bundle,
    instance,
    store,
    state: loaded.state,
    backups: scan.records,
    warnings,
    os,
  };
}

/**
 * Every digest we have reason to believe is one of our own payloads: this
 * bundle's, whatever is currently recorded as installed, and every payload this
 * instance has been through.
 *
 * This set is what stops a second install from recording the Japanese file as
 * the "original" English one, and it holds even with state.json missing,
 * because the current bundle's own digest already catches the common case.
 */
function knownPayloadDigests(session: Session): Set<string> {
  const digests = new Set<string>();
  for (const entry of session.bundle.manifest.payload) digests.add(entry.sha256);
  for (const record of Object.values(session.state.installs)) {
    digests.add(record.installedSha256);
  }
  for (const event of session.state.history) {
    if (event.event === "install") digests.add(event.installedSha256);
  }
  return digests;
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw new AppError("E_INSTANCE", `Could not read ${path}`, {
      hint: "Close Minecraft and any editor holding the file, then try again.",
      cause,
    });
  }
}

/** Backups for one target that uninstall could restore from, newest first. */
function restoreCandidates(session: Session, relativePath: string): BackupRecord[] {
  return session.backups
    .filter((record) =>
      record.sidecar.targetRelativePath === relativePath &&
      RESTORABLE_KINDS.includes(record.sidecar.kind)
    )
    .sort((a, b) => b.sidecar.capturedAt.localeCompare(a.sidecar.capturedAt));
}

/** Every restore candidate for a target that still verifies, newest first. */
async function verifiedRestorable(
  session: Session,
  relativePath: string,
): Promise<BackupRecord[]> {
  const verified: BackupRecord[] = [];
  for (const candidate of restoreCandidates(session, relativePath)) {
    if ((await session.store.verify(candidate)).ok) verified.push(candidate);
  }
  return verified;
}

async function firstVerified(
  session: Session,
  candidates: BackupRecord[],
): Promise<{ record: BackupRecord; bytes: Uint8Array } | { failures: string[] }> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    const verified = await session.store.verify(candidate);
    if (verified.ok) return { record: candidate, bytes: verified.bytes ?? new Uint8Array(0) };
    failures.push(`${candidate.name}: ${verified.reason}`);
  }
  return { failures };
}

interface Classified {
  entryIndex: number;
  target: ResolvedTarget;
  current: Uint8Array | null;
  currentSha256: string | null;
  /** A verified original/absent backup already exists for this target. */
  preserved?: BackupRecord;
  status: InstallStatus;
  /** What to capture before writing, if anything. */
  capture?: BackupKind;
}

/**
 * Install every payload the bundle declares.
 *
 * Classification for all targets happens before any write, so a refusal
 * (E_TARGET_MODIFIED, a symlink, a bad instance) leaves the instance exactly as
 * it was. Per target the order is: capture the backup and its sidecar, then
 * write the payload atomically, then record the state -- chosen so that a crash
 * at any point leaves something the next run can finish from.
 */
export async function install(context: OperationContext): Promise<InstallResult> {
  const bundle = await loadBundle(context.bundleDir);
  const session = await open(context, bundle);
  const known = knownPayloadDigests(session);

  const plan: Classified[] = [];
  for (let index = 0; index < bundle.payload.length; index++) {
    const entry = bundle.payload[index];
    const target = await resolveTargetPath(session.instance.root, entry.path, { os: session.os });
    const current = await readIfPresent(target.path);
    const currentSha256 = current === null ? null : await sha256Hex(current);

    const preservedOriginals = await verifiedRestorable(session, entry.path);

    plan.push(classify({
      entry,
      target,
      current,
      currentSha256,
      preservedOriginals,
      known,
      force: context.force,
    }));
    plan[plan.length - 1].entryIndex = index;
  }

  const targets: InstallTargetOutcome[] = [];
  for (const step of plan) {
    const entry = bundle.payload[step.entryIndex];
    let backup: BackupSummary | undefined;

    if (step.capture) {
      const record = await session.store.capture({
        relativePath: entry.path,
        bytes: step.capture === "absent" ? null : step.current,
        kind: step.capture,
        capturedAt: context.now().toISOString(),
      });
      backup = {
        relativePath: record.relativePath,
        kind: record.sidecar.kind,
        reused: record.reused,
      };
      if (step.capture !== "modified-install") step.preserved = record;
    }

    if (step.status !== "already-installed") {
      await writeFileAtomic(step.target.path, entry.bytes);
    }

    const previous = session.state.installs[entry.path];
    const originalBackup = step.capture === "original" || step.capture === "absent"
      ? step.preserved
      : undefined;

    session.state.installs[entry.path] = {
      bundleId: bundle.manifest.bundleId,
      installedSha256: entry.sha256,
      installedAt: context.now().toISOString(),
      ...originalPointer(originalBackup, previous, step.preserved),
      toolVersion: bundle.manifest.toolVersion,
    };
    session.state.history.push({
      event: "install",
      target: entry.path,
      at: context.now().toISOString(),
      bundleId: bundle.manifest.bundleId,
      installedSha256: entry.sha256,
      ...(backup ? { backup: backup.relativePath } : {}),
    });

    targets.push({
      relativePath: entry.path,
      path: step.target.path,
      status: step.status,
      installedSha256: entry.sha256,
      ...(backup ? { backup } : {}),
    });
  }

  await saveState(session.store.installerDirectory, session.state, session.os);

  return {
    bundleId: bundle.manifest.bundleId,
    instance: session.instance,
    targets,
    warnings: session.warnings,
  };
}

/**
 * Which backup this install should point at as "the original".
 *
 * A backup captured just now wins; otherwise the pointer already in state is
 * kept, because an upgrade must not lose the original English file; otherwise
 * an original found on disk is adopted, which is what repairs an install whose
 * state.json was lost.
 */
function originalPointer(
  captured: BackupRecord | undefined,
  previous:
    | { originalBackup?: string; originalSha256?: string; originalWasAbsent: boolean }
    | undefined,
  preserved: BackupRecord | undefined,
): { originalBackup?: string; originalSha256?: string; originalWasAbsent: boolean } {
  const source = captured ?? preserved;
  if (previous?.originalBackup) {
    return {
      originalBackup: previous.originalBackup,
      ...(previous.originalSha256 ? { originalSha256: previous.originalSha256 } : {}),
      originalWasAbsent: previous.originalWasAbsent,
    };
  }
  if (source) {
    return {
      originalBackup: source.relativePath,
      originalSha256: source.sidecar.sha256,
      originalWasAbsent: source.sidecar.kind === "absent",
    };
  }
  return { originalWasAbsent: false };
}

interface ClassifyArgs {
  entry: { path: string; sha256: string };
  target: ResolvedTarget;
  current: Uint8Array | null;
  currentSha256: string | null;
  /** Verified original/absent backups already held for this target, newest first. */
  preservedOriginals: BackupRecord[];
  known: Set<string>;
  force: boolean;
}

function classify(args: ClassifyArgs): Classified {
  const preserved = args.preservedOriginals[0];
  const base = {
    entryIndex: 0,
    target: args.target,
    current: args.current,
    currentSha256: args.currentSha256,
    preserved,
  };

  if (args.currentSha256 === args.entry.sha256) {
    // Already exactly this payload. Never a backup: a file matching a payload
    // digest is not an original, and capturing it as one is precisely the bug
    // that loses the pack's English text.
    return { ...base, status: args.force ? "reinstalled" : "already-installed" };
  }

  if (args.current === null) {
    // Nothing here. If an original is already preserved (a previous install we
    // are repairing) keep it; otherwise record that there was no file.
    return { ...base, status: "installed", capture: preserved ? undefined : "absent" };
  }

  if (args.known.has(args.currentSha256!)) {
    // A different payload of ours: an overlay upgrade, not an original.
    return { ...base, status: "upgraded" };
  }

  if (args.preservedOriginals.some((record) => record.sidecar.sha256 === args.currentSha256)) {
    // Byte-for-byte what we already preserved. This is the run that finishes an
    // install interrupted between capturing the backup and writing the payload:
    // the file is the original, not a modification of ours.
    return { ...base, status: "installed" };
  }

  if (preserved) {
    // We already hold this target's original, so whatever is here now arrived
    // after we installed -- an edit, or a hand-placed replacement.
    if (!args.force) {
      throw new AppError(
        "E_TARGET_MODIFIED",
        `${args.target.path} is neither the original file nor anything this installer wrote`,
        {
          hint: "Re-run with --force to install anyway; the file that is there now will be " +
            "kept as a backup first.",
          details: { target: args.target.relativePath },
        },
      );
    }
    return { ...base, status: "installed", capture: "modified-install" };
  }

  // First contact with a file we did not write: this is the original.
  return { ...base, status: "installed", capture: "original" };
}

/** Restore what was there before, or delete if there was nothing. */
export async function uninstall(context: OperationContext): Promise<UninstallResult> {
  // The payload bytes are not needed to undo an install, so a bundle whose
  // payload was deleted can still uninstall.
  const loadedManifest = await loadBundleManifest(context.bundleDir);
  const bundle: LoadedBundle = { ...loadedManifest, payload: [] };
  const session = await open(context, bundle);
  const known = knownPayloadDigests(session);

  const targets: UninstallTargetOutcome[] = [];
  for (const entry of bundle.manifest.payload) {
    const target = await resolveTargetPath(session.instance.root, entry.path, { os: session.os });
    const current = await readIfPresent(target.path);
    const currentSha256 = current === null ? null : await sha256Hex(current);
    const record = session.state.installs[entry.path];

    const looksInstalled = currentSha256 !== null && known.has(currentSha256);
    if (!record && !looksInstalled) {
      throw new AppError(
        "E_NOT_INSTALLED",
        `Nothing from this bundle is installed at ${target.path}`,
        {
          hint: current === null
            ? "There is no quest translation there to remove."
            : "The file there was not written by this installer, so it is left alone.",
        },
      );
    }

    const modified = current !== null && !looksInstalled && record !== undefined;
    if (modified && !context.force) {
      throw new AppError(
        "E_TARGET_MODIFIED",
        `${target.path} has changed since it was installed`,
        {
          hint: "Re-run with --force to restore anyway; the file that is there now will be " +
            "kept as a backup first.",
          details: { target: entry.path },
        },
      );
    }

    // The backup is chosen before anything is written, so an unusable one
    // leaves the instance untouched even when --force asked us to press on.
    const chosen = await chooseBackup(session, entry.path, record?.originalBackup);
    if ("failures" in chosen) {
      throw new AppError(
        "E_BACKUP",
        `No usable backup of ${entry.path} was found, so nothing was changed.\n` +
          (chosen.failures.length > 0
            ? chosen.failures.map((line) => `  - ${line}`).join("\n")
            : `  - no backup record exists in ${session.store.backupsDirectory}`),
        {
          hint: "The translated file is still in place and can be deleted by hand; " +
            "the pack's own file can be restored by reinstalling the modpack.",
          details: { target: entry.path },
        },
      );
    }

    let keptModifiedAs: string | undefined;
    if (modified) {
      const kept = await session.store.capture({
        relativePath: entry.path,
        bytes: current,
        kind: "modified-install",
        capturedAt: context.now().toISOString(),
      });
      keptModifiedAs = kept.relativePath;
    }

    const at = context.now().toISOString();
    if (chosen.record.sidecar.kind === "absent") {
      if (current !== null) {
        try {
          await Deno.remove(target.path);
        } catch (cause) {
          throw new AppError("E_WRITE", `Could not remove ${target.path}`, { cause });
        }
      }
      targets.push({
        relativePath: entry.path,
        path: target.path,
        status: "deleted",
        restoredFrom: chosen.record.relativePath,
        ...(keptModifiedAs ? { keptModifiedAs } : {}),
      });
      session.state.history.push({
        event: "uninstall",
        target: entry.path,
        at,
        restoredFrom: chosen.record.relativePath,
        deleted: true,
      });
    } else {
      await writeFileAtomic(target.path, chosen.bytes);
      targets.push({
        relativePath: entry.path,
        path: target.path,
        status: "restored",
        restoredFrom: chosen.record.relativePath,
        ...(keptModifiedAs ? { keptModifiedAs } : {}),
      });
      session.state.history.push({
        event: "uninstall",
        target: entry.path,
        at,
        restoredFrom: chosen.record.relativePath,
      });
    }

    delete session.state.installs[entry.path];
  }

  await saveState(session.store.installerDirectory, session.state, session.os);

  return {
    bundleId: bundle.manifest.bundleId,
    instance: session.instance,
    targets,
    warnings: session.warnings,
  };
}

/**
 * The backup named by the install record, if it still verifies; otherwise the
 * newest backup on disk for this target that does. Nothing is ever restored
 * from a backup whose size and digest do not match what was captured.
 */
async function chooseBackup(
  session: Session,
  relativePath: string,
  pointer: string | undefined,
): Promise<{ record: BackupRecord; bytes: Uint8Array } | { failures: string[] }> {
  const candidates = restoreCandidates(session, relativePath);
  const named = pointer
    ? candidates.find((candidate) => candidate.relativePath === pointer)
    : undefined;

  const failures: string[] = [];
  if (pointer && !named) {
    failures.push(`${pointer}: recorded as the original backup, but it is missing`);
  }
  const ordered = named ? [named, ...candidates.filter((c) => c !== named)] : candidates;

  const result = await firstVerified(session, ordered);
  if ("record" in result) return result;
  return { failures: [...failures, ...result.failures] };
}

/** Report what is installed without writing anything. */
export async function status(context: OperationContext): Promise<StatusResult> {
  const loadedManifest = await loadBundleManifest(context.bundleDir);
  const bundle: LoadedBundle = { ...loadedManifest, payload: [] };
  const session = await open(context, bundle);

  const targets: StatusTarget[] = [];
  for (const entry of bundle.manifest.payload) {
    const target = await resolveTargetPath(session.instance.root, entry.path, { os: session.os });
    const current = await readIfPresent(target.path);
    const currentSha256 = current === null ? null : await sha256Hex(current);
    const record = session.state.installs[entry.path];
    const chosen = await chooseBackup(session, entry.path, record?.originalBackup);

    targets.push({
      relativePath: entry.path,
      path: target.path,
      present: current !== null,
      matchesBundle: currentSha256 === entry.sha256,
      modified: record !== undefined && currentSha256 !== null &&
        currentSha256 !== record.installedSha256,
      ...(record ? { recordedBundleId: record.bundleId, installedAt: record.installedAt } : {}),
      ...("record" in chosen
        ? {
          restorableFrom: chosen.record.relativePath,
          originalWasAbsent: chosen.record.sidecar.kind === "absent",
        }
        : {}),
    });
  }

  return {
    bundleId: bundle.manifest.bundleId,
    instance: session.instance,
    targets,
    warnings: session.warnings,
  };
}
