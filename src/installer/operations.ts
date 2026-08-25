import { AppError } from "../errors.ts";
import { currentDurability, type Durability } from "../util/durable.ts";
import { writeFileAtomic } from "../util/fs.ts";
import { sha256Hex } from "../util/hash.ts";
import {
  type BackupKind,
  type BackupRecord,
  BACKUPS_DIR,
  BackupStore,
  RESTORABLE_KINDS,
} from "./backup.ts";
import { loadBundle, loadBundleManifest, type LoadedBundle } from "./bundle.ts";
import {
  type ResolvedInstance,
  type ResolvedTarget,
  resolveInstanceRoot,
  resolveTargetPath,
} from "./instance.ts";
import { currentOs, type OsKind } from "./paths.ts";
import { type InstallerState, type InstallRecord, loadState, saveState } from "./state.ts";

export interface OperationContext {
  bundleDir: string;
  instanceInput: string;
  force: boolean;
  /** Injected rather than read from the clock, so runs are testable. */
  now: () => Date;
  os?: OsKind;
  /**
   * How bytes are pushed past the page cache. Injected for the same reason the
   * clock is: a filesystem that refuses to flush has to be testable without
   * finding one.
   */
  durability?: Durability;
  /**
   * Awaited immediately before each destructive step, and nowhere else.
   *
   * This is the only way to put another process's write inside the window the
   * revalidation guards on purpose rather than by luck. Nothing passes it in
   * production, so nothing calls it.
   */
  interlude?: (stage: InterludeStage, target: string) => Promise<void>;
}

/** The destructive boundaries, in the order a run reaches them. */
export type InterludeStage = "after-capture" | "before-replace" | "before-rename";

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
  durability: Durability;
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
  const durability = context.durability ?? currentDurability();
  const instance = await resolveInstanceRoot(context.instanceInput, os);
  const store = new BackupStore(instance.root, {
    toolVersion: bundle.manifest.toolVersion,
    bundleId: bundle.manifest.bundleId,
    os,
    durability,
  });
  const scan = await store.scan();
  const loaded = await loadState(await store.resolveInstallerDirectory(), os);
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
    durability,
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

/**
 * The install this run is continuing, if there is one at all.
 *
 * `backups/` is append-only and survives uninstall for ever, so the mere
 * existence of an `original` or `absent` backup proves nothing about the file
 * that is on disk right now: it may be the leftover of an install that was
 * undone releases ago. Adopting one of those as "the original of the current
 * install" is how a modpack update gets silently rolled back -- the pack's new
 * English file gets classified as somebody's edit, and the next uninstall puts
 * the old version back or deletes the file outright.
 *
 * So a backup only counts as preserved when this target is *actually* under
 * installation: state.json says so, or the file on disk is still one of our
 * payloads and it is state.json that was lost.
 */
interface Lineage {
  /** The record in state.json, when the install is still on the books. */
  record?: InstallRecord;
  /** The original this live install belongs to, when it still verifies. */
  preserved?: BackupRecord;
}

async function activeLineage(
  session: Session,
  relativePath: string,
  currentSha256: string | null,
  known: Set<string>,
): Promise<Lineage> {
  const record = session.state.installs[relativePath];
  const liveByPayload = currentSha256 !== null && known.has(currentSha256);
  if (!record && !liveByPayload) return {};

  const restorable = await verifiedRestorable(session, relativePath);
  const preserved = permittedBackups(restorable, record).allowed[0];
  return { ...(record ? { record } : {}), ...(preserved ? { preserved } : {}) };
}

/**
 * The backups an install record permits to be treated as its original, in
 * preference order.
 *
 * An install that is on the books names its own original, and that backup --
 * by name, or by the digest that still identifies its bytes when the file has
 * been renamed -- is the only thing undoing that install may put back.
 * `backups/` is append-only and outlives the install that filled it, so its
 * other entries belong to lineages that have already been undone. If the
 * modpack updated its own English file in between, restoring one of those
 * hands the player a pre-update quest file and reports success.
 *
 * So a pointer that cannot be matched is a refusal, not a cue to look further.
 * With no pointer at all -- state.json lost, or a record written before
 * pointers were kept -- a single candidate is unambiguous and anything more is
 * a guess between lineages. Guessing is precisely the failure this refuses to
 * make.
 *
 * Several candidates *can* share the pointer's digest, and those are not a
 * guess: identical bytes restore an identical file, whichever copy is read.
 */
function permittedBackups(
  candidates: readonly BackupRecord[],
  record: Pick<InstallRecord, "originalBackup" | "originalSha256"> | undefined,
): { allowed: BackupRecord[]; refusal?: string } {
  const pointer = record?.originalBackup;
  const digest = record?.originalSha256;

  if (pointer === undefined && digest === undefined) {
    if (candidates.length <= 1) return { allowed: [...candidates] };
    return {
      allowed: [],
      refusal: `${candidates.length} backups of this file are on disk and nothing records which ` +
        `one belongs to the install being undone`,
    };
  }

  const allowed = candidates.filter((candidate) =>
    candidate.relativePath === pointer || candidate.sidecar.sha256 === digest
  );
  // The named one first: a path is more specific than a digest.
  allowed.sort((a, b) => Number(b.relativePath === pointer) - Number(a.relativePath === pointer));
  if (allowed.length > 0) return { allowed };
  return {
    allowed: [],
    refusal: `${pointer ?? digest}: recorded as this install's original backup, but no backup ` +
      `in ${BACKUPS_DIR}/ matches it -- it is missing`,
  };
}

/**
 * A verified `original` backup holding exactly the bytes that are on disk now.
 *
 * Lineage does not come into this one: the bytes are the same, so restoring
 * from it later reproduces the file that is there this second, whichever
 * install captured it. It is what makes a run interrupted between capturing the
 * backup and writing the payload finish without a second capture.
 *
 * `absent` sentinels are deliberately excluded. A sentinel is a zero-byte file,
 * so a target that genuinely *is* empty would digest-match one, and adopting it
 * would turn "restore an empty file" into "delete the file".
 */
async function matchingOriginal(
  session: Session,
  relativePath: string,
  currentSha256: string | null,
): Promise<BackupRecord | undefined> {
  if (currentSha256 === null) return undefined;
  for (const candidate of restoreCandidates(session, relativePath)) {
    if (candidate.sidecar.kind !== "original") continue;
    if (candidate.sidecar.sha256 !== currentSha256) continue;
    if ((await session.store.verify(candidate)).ok) return candidate;
  }
  return undefined;
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

/**
 * Prove the target is still exactly what the plan was made for.
 *
 * The plan is built from one read per target; capturing a backup, hashing it
 * and flushing it all take time, and the file is not locked. Minecraft, a sync
 * client, an editor or the modpack's own updater can rewrite `en_us.snbt` in
 * that window, and writing the payload over it would lose whatever it now says.
 *
 * Re-resolving rather than reusing the planned path is deliberate: it re-walks
 * every component, so a parent directory swapped for a symbolic link since the
 * plan was made is refused here rather than followed.
 */
async function assertUnchanged(
  session: Session,
  relativePath: string,
  expected: string | null,
): Promise<ResolvedTarget> {
  const target = await resolveTargetPath(session.instance.root, relativePath, { os: session.os });
  const current = await readIfPresent(target.path);
  const actual = current === null ? null : await sha256Hex(current);
  if (actual === expected) return target;

  throw new AppError(
    "E_TARGET_MODIFIED",
    actual === null
      ? `${target.path} was deleted while the installer was working`
      : `${target.path} changed while the installer was working`,
    {
      hint: "Nothing was overwritten -- the newer file is still there. Close Minecraft and any " +
        "editor or sync client holding the file, then run the command again.",
      details: { target: relativePath },
    },
  );
}

/**
 * One target's worth of undo: what it held before this run changed it.
 *
 * Planning refuses across all targets before a single byte is written, but a
 * write can still fail at run time on the second of two files. Restoring the
 * first is what keeps "all or nothing" true past the planning stage.
 */
interface AppliedChange {
  relativePath: string;
  path: string;
  /** The bytes that were there before, or null when there was no file. */
  previous: Uint8Array | null;
  /** The digest this run left behind, so a third party's write is not clobbered. */
  wrote: string | null;
}

async function rollBack(
  session: Session,
  applied: readonly AppliedChange[],
  failure: unknown,
): Promise<never> {
  const notes: string[] = [];
  for (const change of [...applied].reverse()) {
    try {
      // If something else has changed it again since, leave it alone: undoing
      // our write would destroy theirs.
      await assertUnchanged(session, change.relativePath, change.wrote);
      if (change.previous === null) {
        await Deno.remove(change.path);
      } else {
        await writeFileAtomic(change.path, change.previous, {
          durability: session.durability,
        });
      }
      notes.push(`${change.relativePath}: put back`);
    } catch (cause) {
      notes.push(
        `${change.relativePath}: could NOT be put back ` +
          `(${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
  }

  const message = failure instanceof Error ? failure.message : String(failure);
  const code = failure instanceof AppError ? failure.code : "E_WRITE";
  throw new AppError(
    code,
    notes.length === 0 ? message : `${message}\n${notes.map((n) => `  - ${n}`).join("\n")}`,
    {
      hint: failure instanceof AppError && failure.hint
        ? failure.hint
        : "Nothing was recorded, so running the command again is safe.",
      cause: failure,
    },
  );
}

interface Classified {
  entryIndex: number;
  target: ResolvedTarget;
  current: Uint8Array | null;
  currentSha256: string | null;
  /** The install this run continues, empty when this is first contact. */
  lineage: Lineage;
  /** The original of the install currently in force, if one is in force. */
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

    const lineage = await activeLineage(session, entry.path, currentSha256, known);
    const identicalOriginal = await matchingOriginal(session, entry.path, currentSha256);

    plan.push(classify({
      entry,
      target,
      current,
      currentSha256,
      lineage,
      ...(identicalOriginal ? { identicalOriginal } : {}),
      known,
      force: context.force,
    }));
    plan[plan.length - 1].entryIndex = index;
    plan[plan.length - 1].lineage = lineage;
  }

  const targets: InstallTargetOutcome[] = [];
  const applied: AppliedChange[] = [];
  for (const step of plan) {
    const entry = bundle.payload[step.entryIndex];
    let backup: BackupSummary | undefined;

    try {
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

        // Capturing, hashing and flushing a backup takes time, and the file is
        // not locked while it happens.
        await context.interlude?.("after-capture", entry.path);
        await assertUnchanged(session, entry.path, step.currentSha256);
      } else if (step.preserved && step.status !== "already-installed") {
        // Nothing to capture, because this run is finishing or upgrading an
        // install whose original is already sitting in `backups/`. Sitting in
        // `backups/` is not the same as being on the disk: the run that put it
        // there may be the very run a failed flush stopped. It is about to
        // become the only copy of the pack's own file, so it is re-established
        // exactly as a freshly captured one would be.
        await session.store.reestablish(step.preserved);
      }

      if (step.status !== "already-installed") {
        await context.interlude?.("before-replace", entry.path);
        const target = await assertUnchanged(session, entry.path, step.currentSha256);
        await writeFileAtomic(target.path, entry.bytes, {
          durability: session.durability,
          beforeRename: async () => {
            await context.interlude?.("before-rename", entry.path);
            await assertUnchanged(session, entry.path, step.currentSha256);
          },
        });
        applied.push({
          relativePath: entry.path,
          path: target.path,
          previous: step.current,
          wrote: entry.sha256,
        });
      }
    } catch (failure) {
      await rollBack(session, applied, failure);
    }

    const originalBackup = step.capture === "original" || step.capture === "absent"
      ? step.preserved
      : undefined;

    session.state.installs[entry.path] = {
      bundleId: bundle.manifest.bundleId,
      installedSha256: entry.sha256,
      installedAt: context.now().toISOString(),
      ...originalPointer(originalBackup, step.lineage.record, step.preserved),
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

  await saveState(
    await session.store.resolveInstallerDirectory(),
    session.state,
    session.os,
    session.durability,
  );

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
 * A backup captured just now wins, because it is by definition the file this
 * run replaced; otherwise the pointer the live install already carries is kept,
 * because an upgrade must not lose the original English file; otherwise the
 * original belonging to that live install is adopted, which is what repairs an
 * install whose state.json was lost. A backup from an install that has already
 * been undone never reaches any of the three: it is not part of this lineage.
 */
function originalPointer(
  captured: BackupRecord | undefined,
  previous: InstallRecord | undefined,
  preserved: BackupRecord | undefined,
): { originalBackup?: string; originalSha256?: string; originalWasAbsent: boolean } {
  const source = captured ?? preserved;
  if (captured === undefined && previous?.originalBackup) {
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
  /** The install currently in force for this target, if any. */
  lineage: Lineage;
  /** A verified `original` backup byte-identical to what is on disk now. */
  identicalOriginal?: BackupRecord;
  known: Set<string>;
  force: boolean;
}

function classify(args: ClassifyArgs): Classified {
  const preserved = args.lineage.preserved;
  const base = {
    entryIndex: 0,
    target: args.target,
    current: args.current,
    currentSha256: args.currentSha256,
    lineage: args.lineage,
    ...(preserved ? { preserved } : {}),
  };

  if (args.currentSha256 === args.entry.sha256) {
    // Already exactly this payload. Never a backup: a file matching a payload
    // digest is not an original, and capturing it as one is precisely the bug
    // that loses the pack's English text.
    return { ...base, status: args.force ? "reinstalled" : "already-installed" };
  }

  if (args.current === null) {
    // Nothing here. If this install's own original is already preserved (a
    // previous install we are repairing) keep it; otherwise record that there
    // was no file.
    return { ...base, status: "installed", capture: preserved ? undefined : "absent" };
  }

  if (args.known.has(args.currentSha256!)) {
    // A different payload of ours: an overlay upgrade, not an original.
    return { ...base, status: "upgraded" };
  }

  if (args.identicalOriginal) {
    // Byte-for-byte an original we already hold. This is the run that finishes
    // an install interrupted between capturing the backup and writing the
    // payload: the file is the original, not a modification of ours.
    return { ...base, preserved: args.identicalOriginal, status: "installed" };
  }

  if (preserved) {
    // This install is live and we already hold its original, so whatever is
    // here now arrived after we installed -- an edit, or a hand-placed
    // replacement.
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

interface Restoration {
  relativePath: string;
  target: ResolvedTarget;
  current: Uint8Array | null;
  /** What the plan was made for; re-proved before anything is written. */
  currentSha256: string | null;
  /** True when the file was edited after we installed it; --force keeps it. */
  modified: boolean;
  backup: BackupRecord;
  /** The verified backup bytes, read before anything is written. */
  bytes: Uint8Array;
}

/** Restore what was there before, or delete if there was nothing. */
export async function uninstall(context: OperationContext): Promise<UninstallResult> {
  // The payload bytes are not needed to undo an install, so a bundle whose
  // payload was deleted can still uninstall.
  const loadedManifest = await loadBundleManifest(context.bundleDir);
  const bundle: LoadedBundle = { ...loadedManifest, payload: [] };
  const session = await open(context, bundle);

  // Every target is resolved, classified and its backup verified before a
  // single byte is written. A bundle may carry more than one quest lang file,
  // and undoing half of one is a state neither the player nor a later run
  // asked for.
  const known = knownPayloadDigests(session);
  const plan: Restoration[] = [];
  for (const entry of bundle.manifest.payload) {
    plan.push(await planRestore(session, context, known, entry));
  }

  const targets: UninstallTargetOutcome[] = [];
  const applied: AppliedChange[] = [];
  const restoredSha256 = new Map<string, string>();
  for (const step of plan) {
    let keptModifiedAs: string | undefined;
    const deleted = step.backup.sidecar.kind === "absent";
    try {
      if (step.modified) {
        const kept = await session.store.capture({
          relativePath: step.relativePath,
          bytes: step.current,
          kind: "modified-install",
          capturedAt: context.now().toISOString(),
        });
        keptModifiedAs = kept.relativePath;

        await context.interlude?.("after-capture", step.relativePath);
        await assertUnchanged(session, step.relativePath, step.currentSha256);
      }

      await context.interlude?.("before-replace", step.relativePath);
      const target = await assertUnchanged(session, step.relativePath, step.currentSha256);

      if (deleted) {
        if (step.current !== null) {
          try {
            await Deno.remove(target.path);
          } catch (cause) {
            throw new AppError("E_WRITE", `Could not remove ${target.path}`, { cause });
          }
          applied.push({
            relativePath: step.relativePath,
            path: target.path,
            previous: step.current,
            wrote: null,
          });
        }
      } else {
        const digest = restoredSha256.get(step.relativePath) ??
          await sha256Hex(step.bytes);
        restoredSha256.set(step.relativePath, digest);
        await writeFileAtomic(target.path, step.bytes, {
          durability: session.durability,
          beforeRename: async () => {
            await context.interlude?.("before-rename", step.relativePath);
            await assertUnchanged(session, step.relativePath, step.currentSha256);
          },
        });
        applied.push({
          relativePath: step.relativePath,
          path: target.path,
          previous: step.current,
          wrote: digest,
        });
      }
    } catch (failure) {
      await rollBack(session, applied, failure);
    }

    targets.push({
      relativePath: step.relativePath,
      path: step.target.path,
      status: deleted ? "deleted" : "restored",
      restoredFrom: step.backup.relativePath,
      ...(keptModifiedAs ? { keptModifiedAs } : {}),
    });
    session.state.history.push({
      event: "uninstall",
      target: step.relativePath,
      at: context.now().toISOString(),
      restoredFrom: step.backup.relativePath,
      ...(deleted ? { deleted: true } : {}),
    });
    delete session.state.installs[step.relativePath];
  }

  await saveState(
    await session.store.resolveInstallerDirectory(),
    session.state,
    session.os,
    session.durability,
  );

  return {
    bundleId: bundle.manifest.bundleId,
    instance: session.instance,
    targets,
    warnings: session.warnings,
  };
}

/** Decide what undoing one target means, refusing before anything is written. */
async function planRestore(
  session: Session,
  context: OperationContext,
  known: Set<string>,
  entry: { path: string },
): Promise<Restoration> {
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

  const chosen = await chooseBackup(session, entry.path, record);
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

  return {
    relativePath: entry.path,
    target,
    current,
    currentSha256,
    modified,
    backup: chosen.record,
    bytes: chosen.bytes,
  };
}

/**
 * The backup this install may be undone from, or why there is none.
 *
 * Only what `permittedBackups` allows is even read, and nothing is ever
 * restored from a backup whose size and digest do not match what was captured.
 * A permitted backup that fails either check ends the run with E_BACKUP: the
 * remaining files in `backups/` belong to other lineages, and reaching for one
 * of them is how an uninstall silently rolls the pack back.
 */
async function chooseBackup(
  session: Session,
  relativePath: string,
  record: Pick<InstallRecord, "originalBackup" | "originalSha256"> | undefined,
): Promise<{ record: BackupRecord; bytes: Uint8Array } | { failures: string[] }> {
  const { allowed, refusal } = permittedBackups(restoreCandidates(session, relativePath), record);
  const result = await firstVerified(session, allowed);
  if ("record" in result) return result;
  return { failures: [...(refusal ? [refusal] : []), ...result.failures] };
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
    const chosen = await chooseBackup(session, entry.path, record);

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
