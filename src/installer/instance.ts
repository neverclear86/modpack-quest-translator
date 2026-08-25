import { AppError } from "../errors.ts";
import { assertPayloadPath } from "./bundle.ts";
import {
  currentOs,
  isInsideRoot,
  joinNative,
  normaliseInstanceInput,
  type OsKind,
} from "./paths.ts";

/** Marker directories every Minecraft instance root has. */
const REQUIRED_DIRECTORIES = ["mods", "config"] as const;

/**
 * Launcher layouts that put the game directory one level below the folder a
 * user would drag onto the installer. Anything deeper is not searched: guessing
 * across a whole tree is how an installer ends up writing into the wrong pack.
 */
const NESTED_GAME_DIRECTORIES = [".minecraft", "minecraft"] as const;

export interface ResolvedInstance {
  /** Fully resolved, symlink-free instance root. */
  root: string;
  /** The path the user actually gave, when it differs from `root`. */
  givenPath: string;
  /** Set when the root was found one level down, e.g. ".minecraft". */
  descendedInto?: string;
}

export interface ResolvedTarget {
  /** Absolute path of the file to install or restore. */
  path: string;
  /** Instance-relative path, as declared by the bundle. */
  relativePath: string;
  /** Deepest directory on the way to the target that already exists. */
  existingAncestor: string;
}

export function instanceError(message: string, hint?: string, cause?: unknown): AppError {
  return new AppError("E_INSTANCE", message, { hint, cause });
}

const INSTANCE_HINT =
  "Choose the folder that contains mods/, config/ and saves/ -- the game directory, " +
  "not the launcher's folder above it.";

/**
 * Turn a user-supplied path into the instance root to operate on.
 *
 * Requires `mods/` and `config/` to be real directories, so a mis-aimed
 * drag-and-drop is refused before anything is opened, and refuses a symlinked
 * marker directory outright rather than following it somewhere unexpected.
 */
export async function resolveInstanceRoot(
  input: string,
  os: OsKind = currentOs(),
): Promise<ResolvedInstance> {
  const given = normaliseInstanceInput(input, os);

  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(given);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      throw instanceError(`The instance directory ${given} does not exist`, INSTANCE_HINT, cause);
    }
    throw instanceError(`The instance directory ${given} could not be read`, INSTANCE_HINT, cause);
  }
  if (!stat.isDirectory) {
    throw instanceError(`${given} is not a directory`, INSTANCE_HINT);
  }

  const direct = await describeInstance(given, os);
  if (direct.length === 0) {
    return { root: await Deno.realPath(given), givenPath: given };
  }

  for (const child of NESTED_GAME_DIRECTORIES) {
    const nested = joinNative(os, given, child);
    if ((await describeInstance(nested, os)).length === 0) {
      return {
        root: await Deno.realPath(nested),
        givenPath: given,
        descendedInto: child,
      };
    }
  }

  throw instanceError(
    `${given} does not look like a Minecraft instance: ${direct.join("; ")}`,
    INSTANCE_HINT,
  );
}

/** Empty when `dir` is an instance root; otherwise one reason per problem. */
async function describeInstance(dir: string, os: OsKind): Promise<string[]> {
  const problems: string[] = [];
  for (const name of REQUIRED_DIRECTORIES) {
    const path = joinNative(os, dir, name);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch {
      problems.push(`it has no ${name}/ directory`);
      continue;
    }
    if (info.isSymlink) {
      problems.push(`${name}/ is a symbolic link, which this installer will not follow`);
    } else if (!info.isDirectory) {
      problems.push(`${name} exists but is not a directory`);
    }
  }
  return problems;
}

export interface ResolveTargetOptions {
  /** Accepted and ignored: no --force overrides a symlink or a containment failure. */
  force?: boolean;
  os?: OsKind;
}

/**
 * Resolve a bundle-declared destination inside an instance root.
 *
 * Every component between the root and the file is lstat-ed, so a symlink
 * planted anywhere along the way is refused rather than followed, and the
 * deepest component that does exist is realpath-ed and checked to still be
 * inside the root. `--force` deliberately has no effect here: forcing past a
 * symlink is how an installer writes outside the instance.
 */
export async function resolveTargetPath(
  root: string,
  relativePath: string,
  options: ResolveTargetOptions = {},
): Promise<ResolvedTarget> {
  const os = options.os ?? currentOs();
  const safe = assertPayloadPath(relativePath);
  const segments = safe.split("/");

  let current = root;
  let existingAncestor = root;
  for (let i = 0; i < segments.length; i++) {
    current = joinNative(os, current, segments[i]);
    const isLast = i === segments.length - 1;

    let info: Deno.FileInfo | undefined;
    try {
      info = await Deno.lstat(current);
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) {
        throw instanceError(`${current} could not be inspected`, undefined, cause);
      }
    }
    if (info === undefined) break; // Everything from here down is ours to create.

    if (info.isSymlink) {
      throw instanceError(
        `${current} is a symbolic link, which this installer will not follow`,
        "Replace the link with a real file or directory, or install into the instance " +
          "the link points at.",
      );
    }
    if (!isLast && !info.isDirectory) {
      throw instanceError(
        `${current} is not a directory, so ${safe} cannot exist inside this instance`,
      );
    }
    if (isLast && info.isDirectory) {
      throw instanceError(`${current} is a directory, but the bundle installs a file there`);
    }
    if (!isLast) existingAncestor = current;
  }

  // The components were symlink-free, so this can only fail if the root itself
  // moved under us -- but it is cheap, and it is the check that actually proves
  // the write lands inside the instance.
  const realAncestor = await Deno.realPath(existingAncestor);
  if (!isInsideRoot(root, realAncestor, os)) {
    throw instanceError(
      `${safe} resolves to ${realAncestor}, which is outside the instance root ${root}`,
    );
  }

  return { path: joinNative(os, root, ...segments), relativePath: safe, existingAncestor };
}
