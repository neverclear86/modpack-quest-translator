import { AppError } from "../errors.ts";

export type OsKind = "windows" | "posix";

/** The platform this process is actually running on. */
export function currentOs(): OsKind {
  return Deno.build.os === "windows" ? "windows" : "posix";
}

function invalid(message: string, hint?: string): AppError {
  return new AppError("E_INVALID_INPUT", message, { hint });
}

/**
 * Turn whatever the user dropped, pasted or typed into a path this installer
 * will act on -- or refuse it.
 *
 * The Windows half is exercised from Linux, because the way the path arrives on
 * Windows (dragged onto a .cmd, pasted with quotes, with a trailing backslash)
 * is exactly where a path bug would be invisible in testing and destructive in
 * the field.
 */
export function normaliseInstanceInput(raw: string, os: OsKind = currentOs()): string {
  let value = raw.trim();

  // A dragged or pasted path often arrives wrapped in quotes.
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  if (value.length === 0) throw invalid("No instance path was given");

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7F) {
      throw invalid(
        "The instance path contains a control character",
        "Retype the path rather than pasting it; something copied a newline or a NUL.",
      );
    }
  }

  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    throw invalid(
      `The instance path ${JSON.stringify(value)} still contains an unexpanded "~"`,
      "This installer never reads your environment, so it cannot expand ~. " +
        "Type the full path, e.g. /home/you/.minecraft.",
    );
  }

  return os === "windows" ? normaliseWindows(value) : normalisePosix(value);
}

function normaliseWindows(value: string): string {
  const slashed = value.replace(/\//g, "\\");

  if (slashed.startsWith("\\\\")) {
    // UNC: \\server\share[\...]. The leading pair is the root and survives.
    const body = slashed.slice(2).replace(/\\{2,}/g, "\\").replace(/\\+$/, "");
    if (body.length === 0) throw invalid(`${JSON.stringify(value)} is not a usable UNC path`);
    return `\\\\${body}`;
  }

  const drive = /^([A-Za-z]):(\\?)([\s\S]*)$/.exec(slashed);
  if (drive) {
    const [, letter, separator, rest] = drive;
    if (separator === "") {
      throw invalid(
        `${JSON.stringify(value)} is relative to the current directory of drive ` +
          `${letter.toUpperCase()}:`,
        `Give an absolute path such as ${letter.toUpperCase()}:\\Games\\instances\\aca.`,
      );
    }
    const body = rest.replace(/\\{2,}/g, "\\").replace(/\\+$/, "");
    return body.length === 0 ? `${letter}:\\` : `${letter}:\\${body}`;
  }

  const collapsed = slashed.replace(/\\{2,}/g, "\\").replace(/\\+$/, "");
  if (collapsed.length === 0) throw invalid(`${JSON.stringify(value)} is not a usable path`);
  return collapsed;
}

function normalisePosix(value: string): string {
  const collapsed = value.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
  if (collapsed.length === 0) throw invalid(`${JSON.stringify(value)} is not a usable path`);
  return collapsed;
}

export function separatorFor(os: OsKind): string {
  return os === "windows" ? "\\" : "/";
}

/** Join with the platform separator, without collapsing a root's own separator. */
export function joinNative(os: OsKind, base: string, ...segments: string[]): string {
  const separator = separatorFor(os);
  let out = base;
  for (const segment of segments) {
    if (segment.length === 0) continue;
    out = out.endsWith(separator) ? `${out}${segment}` : `${out}${separator}${segment}`;
  }
  return out;
}

/**
 * Is `path` the root itself or something underneath it?
 *
 * Compared segment by segment rather than by string prefix, because
 * `/home/u/mc-evil` starts with `/home/u/mc` and a prefix test would call it
 * contained. Windows path comparison is case-insensitive; POSIX is not.
 */
export function isInsideRoot(root: string, path: string, os: OsKind = currentOs()): boolean {
  const separator = separatorFor(os);
  const fold = (value: string) => (os === "windows" ? value.toLowerCase() : value);
  const split = (value: string) =>
    fold(value).split(separator).filter((segment) => segment.length > 0);

  const rootSegments = split(root);
  const pathSegments = split(path);
  if (pathSegments.length < rootSegments.length) return false;
  return rootSegments.every((segment, index) => segment === pathSegments[index]);
}
