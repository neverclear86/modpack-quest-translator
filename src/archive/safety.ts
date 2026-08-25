import { AppError } from "../errors.ts";

/**
 * Normalise an archive-declared entry name into a safe, forward-slashed
 * relative path, or explain why it cannot be made safe.
 *
 * Nothing from a downloaded pack is ever written to disk, but the discovery
 * layer still matches on these paths, so a traversal-shaped name must not be
 * silently normalised into something that looks legitimate.
 */
export function normaliseEntryPath(rawName: string): string {
  if (rawName.length === 0) throw unsafe(rawName, "the name is empty");

  // Control characters, including NUL, are never legitimate in a pack.
  for (let i = 0; i < rawName.length; i++) {
    const code = rawName.charCodeAt(i);
    if (code < 0x20 || code === 0x7F) {
      throw unsafe(rawName, "the name contains a control character");
    }
  }

  const slashed = rawName.replace(/\\/g, "/");

  if (slashed.startsWith("/")) throw unsafe(rawName, "the name is an absolute path");
  if (/^[A-Za-z]:/.test(slashed)) throw unsafe(rawName, "the name has a Windows drive prefix");
  if (slashed.startsWith("//")) throw unsafe(rawName, "the name is a UNC path");

  const segments = slashed.split("/");
  for (const segment of segments) {
    if (segment === "..") throw unsafe(rawName, "the name escapes the archive root");
    // A trailing dot or space is a Windows path-normalisation trick.
    if (segment.length > 0 && /[. ]$/.test(segment) && segment !== "." && segment !== "..") {
      throw unsafe(rawName, "a path segment ends with a dot or space");
    }
  }

  // Collapse "." segments and repeated slashes, keeping any trailing slash.
  const isDirectory = slashed.endsWith("/");
  const cleaned = segments.filter((s) => s.length > 0 && s !== ".").join("/");
  if (cleaned.length === 0) throw unsafe(rawName, "the name resolves to nothing");
  return isDirectory ? `${cleaned}/` : cleaned;
}

function unsafe(rawName: string, reason: string): AppError {
  return new AppError(
    "E_UNSUPPORTED_PACK",
    `Refusing archive entry with an unsafe path ${JSON.stringify(rawName)}: ${reason}`,
    { hint: "The archive may be malicious or corrupt; it was not extracted." },
  );
}

/** Unix file-type bits from a ZIP central-directory external attributes field. */
export function unixFileType(externalAttributes: number): number {
  return (externalAttributes >>> 16) & 0xF000;
}

export const S_IFLNK = 0xA000;
