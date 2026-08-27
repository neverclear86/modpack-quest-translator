/**
 * Finding the English strings inside a mod jar.
 *
 * A jar is read exactly like a modpack archive -- through the same bounded ZIP
 * reader, from the central directory, with the same Zip Slip, symlink,
 * decompression-bomb and entry-count limits. Only `assets/<namespace>/lang/
 * <locale>.json` entries are ever inflated: no class file is read, nothing is
 * extracted to disk, and nothing is executed. The jar is data.
 */

import { AppError } from "../errors.ts";
import { readZip, type ZipArchive } from "./zip/reader.ts";
import { sha256Hex } from "../util/hash.ts";

/**
 * More candidate namespaces than this and auto-detection is not the user's
 * problem to debug: reading and parsing them all is work we should not do
 * silently, and picking between them is not something a heuristic should try.
 * The limit is a property of *guessing*, so `--lang-namespace` -- which is the
 * answer to it -- is never measured against it.
 */
export const MAX_LANG_NAMESPACES = 64;

/** Namespaces listed in an error before it stops naming them one by one. */
const NAMESPACE_SAMPLE = 20;

/** Top-level `assets/<namespace>/lang/<locale>.json` only. */
function langEntryPattern(sourceLocale: string): RegExp {
  const locale = sourceLocale.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return new RegExp(`^assets/([a-z0-9_.-]+)/lang/${locale}\\.json$`, "i");
}

export interface LangJarCandidate {
  namespace: string;
  /** Path of the entry inside the jar. */
  path: string;
  /**
   * Every translation key the file defines.
   *
   * Membership, not value type. A referenced key whose value is not a string is
   * a key this jar *defines* and this tool must refuse -- not a key it is
   * missing, which would be silently skipped as untranslatable.
   */
  keys: ReadonlySet<string>;
  /** How many keys the file defines in total, translatable or not. */
  entryCount: number;
}

/** A language entry that matched the layout but cannot be used as one. */
export interface MalformedLangEntry {
  namespace: string;
  path: string;
  /** Reads as `<path> <reason>`, e.g. "… is not valid JSON". */
  reason: string;
}

export interface LangJarScan {
  candidates: LangJarCandidate[];
  /**
   * Files that looked like language files and were not. Kept rather than
   * dropped: they are the difference between "this jar ships nothing" and
   * "this jar ships something this tool could not read".
   */
  malformed: MalformedLangEntry[];
}

export interface LangJarSelection {
  chosen: LangJarCandidate;
  /** Referenced keys the chosen namespace defines, in referenced order. */
  matched: string[];
  /** Referenced keys nothing in the chosen namespace defines. */
  missing: string[];
  /** Namespaces that also matched but are covered by the chosen one. */
  alternates: LangJarCandidate[];
}

export interface LoadedLangJar {
  /** Base name only; the full path is never written into an artefact. */
  fileName: string;
  sha256: string;
  archive: ZipArchive;
}

/**
 * Somewhere bytes come from, one bounded chunk at a time.
 *
 * `Deno.FsFile` satisfies it as it stands, which is the point: the jar is read
 * through the same narrow interface a test can implement, so "the cap stopped
 * the read" is provable without a file that really is gigabytes long.
 */
export interface JarByteSource {
  /** Fill some of `into` and answer with how many bytes, or null at the end. */
  read(into: Uint8Array): Promise<number | null>;
  close(): void;
}

export interface LoadLangJarOptions {
  /** How the jar is opened. Injected so the limit can be proved while reading. */
  open?: (path: string) => Promise<JarByteSource>;
}

/** Where a growing buffer starts, so a small jar costs a small allocation. */
const INITIAL_BUFFER = 64 * 1024;

/**
 * Reading past the cap by one byte is the whole proof that a file is over it,
 * and the most that is ever held for a file that is.
 */
const OVERSHOOT = 1;

/**
 * A read that goes nowhere. Nothing well-behaved returns 0 for a buffer with
 * room in it, and a source that does it forever must not become a hang.
 */
const MAX_EMPTY_READS = 64;

/**
 * Read the supplied mod jar as data.
 *
 * Bounded *while* it is read, not afterwards: the bytes arrive a chunk at a
 * time into a buffer that never grows past `maxBytes + 1`, and the read stops
 * at the first byte that proves the file is over the limit. A `stat` could only
 * ever have been a claim -- about a file anything can extend, replace or
 * misreport, as `/proc` does by reporting zero -- so no allocation is sized by
 * one.
 *
 * What was actually read is measured again once the read has finished, because
 * that is the only number the cap can honestly be applied to; it is the last
 * word rather than the first.
 *
 * The bytes are then parsed by the same central-directory ZIP reader as the
 * pack, so Zip Slip, symlinks, encrypted entries and decompression bombs are
 * refused identically. Nothing in it is executed and nothing is extracted to
 * disk.
 */
export async function loadLangJar(
  path: string,
  maxBytes: number,
  options: LoadLangJarOptions = {},
): Promise<LoadedLangJar> {
  const source = await (options.open ?? openLangJar)(path);
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(source, path, maxBytes);
  } finally {
    // Whatever happened, the handle does not outlive this call.
    try {
      source.close();
    } catch {
      // Closing an already-broken handle is not a second failure to report.
    }
  }
  assertJarWithinLimit(path, bytes.byteLength, maxBytes);

  return {
    fileName: path.replace(/\\/g, "/").split("/").pop() ?? "lang.jar",
    sha256: await sha256Hex(bytes),
    archive: await readZip(bytes, { maxTotalBytes: maxBytes * 4 }),
  };
}

/**
 * Open the jar and prove it is a file through the handle itself.
 *
 * `fstat` describes what was opened; a `stat` of the path describes whatever is
 * at that name now, which need not be the same thing.
 */
async function openLangJar(path: string): Promise<JarByteSource> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (cause) {
    throw new AppError("E_INVALID_INPUT", `Could not read --lang-jar ${path}`, {
      cause,
      hint: "Pass the path of a local mod jar that ships " +
        "assets/<namespace>/lang/<source-locale>.json.",
    });
  }
  let info: Deno.FileInfo;
  try {
    info = await file.stat();
  } catch (cause) {
    file.close();
    throw new AppError("E_INVALID_INPUT", `Could not read --lang-jar ${path}`, { cause });
  }
  if (!info.isFile) {
    file.close();
    throw new AppError("E_INVALID_INPUT", `--lang-jar ${path} is not a file`);
  }
  return file;
}

/**
 * Everything the source has, as long as that is not more than the cap allows.
 *
 * The buffer doubles up to `maxBytes + 1` and never beyond it, so the peak
 * allocation for a refused file is one byte past its own limit rather than
 * whatever the file happened to be.
 */
async function readBounded(
  source: JarByteSource,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const ceiling = maxBytes + OVERSHOOT;
  let buffer = new Uint8Array(Math.min(ceiling, INITIAL_BUFFER));
  let received = 0;
  let empty = 0;

  while (received < ceiling) {
    if (received === buffer.byteLength) {
      const grown = new Uint8Array(Math.min(ceiling, buffer.byteLength * 2));
      grown.set(buffer);
      buffer = grown;
    }
    let read: number | null;
    try {
      // The window is what is left of the allowance, so the source is never
      // given the chance to hand over more than that.
      read = await source.read(buffer.subarray(received));
    } catch (cause) {
      throw new AppError("E_INVALID_INPUT", `Could not read --lang-jar ${path}`, {
        cause,
        hint: "The file has to stay readable for as long as it takes to read it.",
      });
    }
    if (read === null) return buffer.subarray(0, received);
    if (read <= 0) {
      if (++empty > MAX_EMPTY_READS) {
        throw new AppError("E_INVALID_INPUT", `Could not read --lang-jar ${path}`, {
          hint: "The file stopped returning data without reaching its end.",
        });
      }
      continue;
    }
    empty = 0;
    received += read;
  }

  // The allowance is full and the source has not ended, so there is at least
  // one byte more than the cap permits. How many more is not worth reading to
  // find out.
  throw tooLarge(path, `is larger than the ${maxBytes} byte limit`);
}

function assertJarWithinLimit(path: string, byteLength: number, maxBytes: number): void {
  if (byteLength <= maxBytes) return;
  throw tooLarge(path, `is ${byteLength} bytes, above the ${maxBytes} byte limit`);
}

function tooLarge(path: string, detail: string): AppError {
  return new AppError("E_INVALID_INPUT", `--lang-jar ${path} ${detail}`, {
    hint: "Raise --max-download if this jar really is that large.",
  });
}

/**
 * Every namespace in the jar that ships a language file for `sourceLocale`.
 *
 * Nested trees such as `assets/tacz/x_default_gun/assets/bf1/lang/en_us.json`
 * are not namespaces of this jar and are skipped: Minecraft only reads the
 * top-level `assets/<namespace>` layout.
 *
 * `forcedNamespace` is not a filter applied after the fact. It names one file,
 * so exactly one file is looked for, read and validated; how many unrelated
 * namespaces the jar happens to ship is then neither counted nor refused.
 */
export async function scanLangJar(
  jar: ZipArchive,
  sourceLocale: string,
  forcedNamespace?: string,
): Promise<LangJarScan> {
  const pattern = langEntryPattern(sourceLocale);
  const paths: { namespace: string; path: string }[] = [];
  for (const entry of jar.files()) {
    const match = pattern.exec(entry.path);
    if (match) paths.push({ namespace: match[1].toLowerCase(), path: entry.path });
  }

  if (forcedNamespace !== undefined) {
    return await readForcedNamespace(jar, paths, forcedNamespace, sourceLocale);
  }

  if (paths.length > MAX_LANG_NAMESPACES) {
    throw new AppError(
      "E_INVALID_INPUT",
      `The language jar declares ${paths.length} namespaces with a ${sourceLocale} language ` +
        `file, above the limit of ${MAX_LANG_NAMESPACES}`,
      { hint: "Pass --lang-namespace <namespace> to name the one to read." },
    );
  }

  return await readCandidates(jar, paths);
}

async function readForcedNamespace(
  jar: ZipArchive,
  paths: readonly { namespace: string; path: string }[],
  forcedNamespace: string,
  sourceLocale: string,
): Promise<LangJarScan> {
  const wanted = forcedNamespace.toLowerCase();
  const selected = paths.filter((p) => p.namespace === wanted);
  if (selected.length === 0) {
    throw new AppError(
      "E_INVALID_INPUT",
      `--lang-namespace ${forcedNamespace} is not in the language jar. ` +
        `It ships a ${sourceLocale} language file for: ${describeNamespaces(paths)}`,
      { hint: "Pass one of those, or drop --lang-namespace to auto-detect." },
    );
  }

  const scan = await readCandidates(jar, selected);
  if (scan.candidates.length === 0) {
    const [bad] = scan.malformed;
    throw new AppError(
      "E_INVALID_INPUT",
      `--lang-namespace ${forcedNamespace} names ${bad.path}, which ${bad.reason}`,
      {
        hint: "A Minecraft language file is a JSON object mapping translation keys to strings. " +
          "Drop --lang-namespace to auto-detect one this tool can read.",
      },
    );
  }
  return scan;
}

function describeNamespaces(paths: readonly { namespace: string }[]): string {
  const unique = [...new Set(paths.map((p) => p.namespace))];
  if (unique.length === 0) return "(none)";
  const shown = unique.slice(0, NAMESPACE_SAMPLE).join(", ");
  const rest = unique.length - NAMESPACE_SAMPLE;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

async function readCandidates(
  jar: ZipArchive,
  paths: readonly { namespace: string; path: string }[],
): Promise<LangJarScan> {
  const candidates: LangJarCandidate[] = [];
  const malformed: MalformedLangEntry[] = [];

  for (const { namespace, path } of paths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await jar.readText(path));
    } catch {
      malformed.push({ namespace, path, reason: "is not valid JSON" });
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformed.push({ namespace, path, reason: "is not a JSON object" });
      continue;
    }
    const keys = new Set(Object.keys(parsed as Record<string, unknown>));
    if (keys.size === 0) {
      malformed.push({ namespace, path, reason: "defines no translation keys" });
      continue;
    }
    candidates.push({ namespace, path, keys, entryCount: keys.size });
  }

  return { candidates, malformed };
}

/**
 * Pick the namespace that backs this pack's quest text.
 *
 * The rule is evidence, not naming: a namespace is a candidate only if it
 * defines keys the quest files actually reference. One candidate is the answer.
 * Several are the answer only when one of them subsumes the rest -- it defines
 * everything they do and more -- because then there is nothing to choose. Any
 * other split is genuinely ambiguous and is refused rather than guessed.
 */
export function selectLangNamespace(
  candidates: readonly LangJarCandidate[],
  referencedKeys: readonly string[],
  forcedNamespace?: string,
  sourceLocale = "en_us",
  malformed: readonly MalformedLangEntry[] = [],
): LangJarSelection {
  const available = candidates.map((c) => c.namespace).join(", ") || "(none)";

  if (forcedNamespace) {
    const wanted = forcedNamespace.toLowerCase();
    const chosen = candidates.find((c) => c.namespace === wanted);
    if (!chosen) {
      throw new AppError(
        "E_INVALID_INPUT",
        `--lang-namespace ${forcedNamespace} is not in the language jar. ` +
          `It ships a ${sourceLocale} language file for: ${available}`,
        { hint: "Pass one of those, or drop --lang-namespace to auto-detect." },
      );
    }
    return { chosen, ...coverage(chosen, referencedKeys), alternates: [] };
  }

  const matching = candidates
    .map((candidate) => ({ candidate, ...coverage(candidate, referencedKeys) }))
    .filter((m) => m.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length);

  if (matching.length === 0) {
    // A jar whose language files all failed to load is a different problem from
    // a jar that ships none, and saying "none" would send the user looking for
    // a file that is right there.
    if (candidates.length === 0 && malformed.length > 0) {
      throw new AppError(
        "E_INVALID_INPUT",
        `The language jar ships ${malformed.length} ${sourceLocale} language file(s), none of ` +
          `which could be read: ${describeMalformed(malformed)}`,
        {
          hint: "A Minecraft language file is a JSON object mapping translation keys to strings. " +
            "Check that --lang-jar points at the mod that provides this pack's quest text.",
        },
      );
    }
    throw new AppError(
      "E_NO_QUEST_LOCALIZATION",
      (candidates.length === 0
        ? `The language jar contains no assets/<namespace>/lang/${sourceLocale}.json`
        : `None of the ${referencedKeys.length} translation key(s) the quest files reference is ` +
          `defined by any ${sourceLocale} language file in the jar (namespaces: ${available})`) +
        (malformed.length > 0
          ? `. ${malformed.length} language file(s) could not be read: ${
            describeMalformed(malformed)
          }`
          : ""),
      {
        hint: "Check that --lang-jar points at the mod that provides this pack's quest text, " +
          "and that --source-locale matches a language file it ships. " +
          "--lang-namespace <namespace> forces a specific one.",
      },
    );
  }

  const [best, ...rest] = matching;
  const subsumed = rest.every(
    (other) =>
      other.matched.length < best.matched.length &&
      other.matched.every((key) => best.candidate.keys.has(key)),
  );
  if (!subsumed) {
    const detail = matching
      .map((m) => `${m.candidate.namespace} (${m.matched.length} of ${referencedKeys.length})`)
      .join(", ");
    throw new AppError(
      "E_INVALID_INPUT",
      `Several namespaces in the language jar define the referenced quest keys: ${detail}`,
      { hint: "Pass --lang-namespace <namespace> to say which one provides the quest text." },
    );
  }

  return {
    chosen: best.candidate,
    matched: best.matched,
    missing: best.missing,
    alternates: rest.map((m) => m.candidate),
  };
}

function describeMalformed(malformed: readonly MalformedLangEntry[]): string {
  return malformed.map((m) => `${m.path} ${m.reason}`).join("; ");
}

function coverage(
  candidate: LangJarCandidate,
  referencedKeys: readonly string[],
): { matched: string[]; missing: string[] } {
  const matched: string[] = [];
  const missing: string[] = [];
  for (const key of referencedKeys) {
    if (candidate.keys.has(key)) matched.push(key);
    else missing.push(key);
  }
  return { matched, missing };
}
