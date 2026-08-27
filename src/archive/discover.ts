import { AppError } from "../errors.ts";
import type { ZipArchive } from "./zip/reader.ts";
import { selectAdapter } from "../quests/registry.ts";
import type { QuestFormatAdapter } from "../quests/adapter.ts";
import type { ChapterFile } from "../quests/chapter_index.ts";
import { minecraftLangJsonAdapter } from "../quests/lang_json.ts";
import { referencedKeysIn, type ReferenceScan, scanQuestReferences } from "../quests/references.ts";
import { scanLangJar, selectLangNamespace } from "./lang_jar.ts";

export type ArchiveFlavour = "curseforge" | "modrinth" | "plain";

export interface PackInfo {
  name?: string;
  version?: string;
  minecraftVersion?: string;
  loader?: string;
}

export interface QuestSource {
  /** Root inside the archive, e.g. `""`, `"overrides/"`. */
  root: string;
  /** Full archive path of the chosen lang file. */
  path: string;
  text: string;
  flavour: ArchiveFlavour;
  packInfo: PackInfo;
  adapter: QuestFormatAdapter;
  chapterFiles: ChapterFile[];
  /** Other roots that also contained a lang file, for reporting. */
  alternates: string[];
  /**
   * Version of the FTB Quests mod the pack actually ships, when it can be read
   * from the pack's file list. The generated README's server/client advice is
   * qualified against this rather than assumed.
   */
  questModVersion?: string;
  /** The jar the version was read from, for provenance. */
  questModFile?: string;

  // ---- JSON language-file mode only ---------------------------------------
  /** `assets/<namespace>/lang/...` the strings were read from. */
  langNamespace?: string;
  /** What the quest files referenced, and what they hard-coded. */
  references?: ReferenceScan;
  /** Referenced keys the language file defines, in referenced order. */
  presentKeys?: string[];
  /** Referenced keys nothing in the language file defines. */
  missingKeys?: string[];
}

export interface DiscoverOptions {
  sourceLocale: string;
  /** Cap on chapter files read for context; they are an optimisation only. */
  maxChapterFiles?: number;
}

export interface DiscoverLangJsonOptions {
  sourceLocale: string;
  /** Force a namespace instead of deducing it from the referenced keys. */
  namespace?: string;
  /** Cap on quest files scanned for references. */
  maxQuestFiles?: number;
}

/** Roots to search, in priority order. */
const ROOTS = ["", "overrides/", "server-overrides/", "client-overrides/"];

const QUEST_DIR = "config/ftbquests/quests";
/**
 * Chapter files are context for the translator, so reading fewer of them costs
 * quality, not correctness, and the cap is a soft one.
 */
const DEFAULT_MAX_CHAPTER_FILES = 500;
/**
 * Quest files in JSON mode are the *selection*: every key that is translated
 * comes from one. Reading fewer would not lose context, it would silently drop
 * quest text from the output, so this cap refuses rather than truncates.
 */
const DEFAULT_MAX_QUEST_FILES = 500;

export async function discoverQuestSource(
  archive: ZipArchive,
  options: DiscoverOptions,
): Promise<QuestSource> {
  const flavour = detectFlavour(archive);
  const packInfo = await readPackInfo(archive, flavour);
  const wanted = `${options.sourceLocale.toLowerCase()}.snbt`;

  const matches: { root: string; path: string }[] = [];
  for (const root of ROOTS) {
    const prefix = `${root}${QUEST_DIR}/lang/`;
    for (const entry of archive.files()) {
      if (!entry.path.startsWith(prefix)) continue;
      const name = entry.path.slice(prefix.length);
      if (name.includes("/")) continue;
      if (name.toLowerCase() !== wanted) continue;
      matches.push({ root, path: entry.path });
      break;
    }
  }

  if (matches.length === 0) throw await noLocalization(archive, options.sourceLocale);

  const chosen = matches[0];
  const text = await archive.readText(chosen.path);

  const selection = selectAdapter(text);
  if (!selection.adapter) {
    const detail = selection.reasons.map((r) => `${r.adapter}: ${r.reason}`).join("; ");
    throw new AppError(
      "E_NO_QUEST_LOCALIZATION",
      `Found ${chosen.path} but no quest-format adapter supports it (${detail})`,
      {
        hint: "v1 supports modern FTB Quests lang files only. Older inline quest data " +
          "and other quest mods are not supported yet.",
      },
    );
  }

  const chapterFiles = await readChapterFiles(
    archive,
    chosen.root,
    options.maxChapterFiles ?? DEFAULT_MAX_CHAPTER_FILES,
  );

  const questMod = await detectQuestMod(archive, flavour);

  return {
    root: chosen.root,
    path: chosen.path,
    text,
    flavour,
    packInfo,
    adapter: selection.adapter,
    chapterFiles,
    alternates: matches.slice(1).map((m) => m.path),
    questModVersion: questMod?.version,
    questModFile: questMod?.file,
  };
}

/**
 * Discovery for packs whose quest files hold `{translation.key}` placeholders
 * and whose English strings live in a mod's language file.
 *
 * Three steps, each of which can fail with something the user can act on:
 * find the quest files, read the keys they reference, then find the one
 * namespace in the supplied jar that backs those keys. The jar is opened with
 * the same bounded reader as the pack and only its language entries are read.
 */
export async function discoverLangJsonSource(
  archive: ZipArchive,
  jar: ZipArchive,
  options: DiscoverLangJsonOptions,
): Promise<QuestSource> {
  const flavour = detectFlavour(archive);
  const packInfo = await readPackInfo(archive, flavour);

  const root = findQuestRoot(archive);
  if (root === undefined) throw noQuestData(archive);

  const { files: questFiles, unreadable } = await readQuestFiles(
    archive,
    root,
    options.maxQuestFiles ?? DEFAULT_MAX_QUEST_FILES,
  );
  const references = scanQuestReferences(questFiles, unreadable);

  if (references.keys.length === 0) {
    throw new AppError(
      "E_NO_QUEST_LOCALIZATION",
      `The ${questFiles.length} quest file(s) under ${root}${QUEST_DIR}/ contain no ` +
        `{translation.key} placeholder` +
        (unreadable.length > 0
          ? `, and ${unreadable.length} more could not be read: ${unreadable.join(", ")}`
          : ""),
      {
        hint: "--lang-jar is for packs whose quest text is stored as translation keys backed " +
          "by a mod's language file. This pack writes its quest text inline, so drop " +
          "--lang-jar and translate its config/ftbquests/quests/lang/<locale>.snbt instead.",
      },
    );
  }

  const { candidates, malformed } = await scanLangJar(
    jar,
    options.sourceLocale,
    options.namespace,
  );
  const selection = selectLangNamespace(
    candidates,
    references.keys,
    options.namespace,
    options.sourceLocale,
    malformed,
  );
  const text = await jar.readText(selection.chosen.path);
  const questMod = await detectQuestMod(archive, flavour);

  return {
    root,
    path: selection.chosen.path,
    text,
    flavour,
    packInfo,
    adapter: minecraftLangJsonAdapter,
    chapterFiles: questFiles,
    alternates: selection.alternates.map((c) => c.path),
    questModVersion: questMod?.version,
    questModFile: questMod?.file,
    langNamespace: selection.chosen.namespace,
    references,
    presentKeys: selection.matched,
    missingKeys: selection.missing,
  };
}

/** The first root that carries FTB Quests data at all. */
function findQuestRoot(archive: ZipArchive): string | undefined {
  for (const root of ROOTS) {
    const prefix = `${root}${QUEST_DIR}/`;
    if (archive.files().some((entry) => entry.path.startsWith(prefix))) return root;
  }
  return undefined;
}

interface QuestFilesRead {
  files: ChapterFile[];
  /** Entries that matched but could not be inflated out of the archive. */
  unreadable: string[];
}

/**
 * Every `.snbt` under the quest directory: chapters, groups, reward tables.
 *
 * The count is checked before anything is read. Stopping at the limit would
 * mean translating a prefix of the pack's quests and packaging the result as if
 * it were the whole thing, so exceeding it is refused instead -- the bound is
 * kept, what it protects against is not silently delivered.
 */
async function readQuestFiles(
  archive: ZipArchive,
  root: string,
  limit: number,
): Promise<QuestFilesRead> {
  const prefix = `${root}${QUEST_DIR}/`;
  const wanted = archive.files().filter((entry) =>
    entry.path.startsWith(prefix) &&
    entry.path.toLowerCase().endsWith(".snbt") &&
    // The pack's own lang file is not a source of references.
    !entry.path.startsWith(`${prefix}lang/`)
  );

  if (wanted.length > limit) {
    throw new AppError(
      "E_UNSUPPORTED_PACK",
      `This pack has ${wanted.length} quest files under ${prefix}, above the limit of ${limit}`,
      {
        hint: "Every translated key comes from one of these files, so reading only the first " +
          `${limit} would produce a resource pack missing quest text without saying so. ` +
          "Please report this pack: the limit is a guess about real packs, not a hard bound.",
      },
    );
  }

  const files: ChapterFile[] = [];
  const unreadable: string[] = [];
  for (const entry of wanted) {
    try {
      files.push({ path: entry.path, text: await archive.readText(entry.path) });
    } catch {
      // Not fatal, but not invisible either: the scan reports it as a file whose
      // references are unknown, so nothing downstream claims to have read it.
      unreadable.push(entry.path);
    }
  }
  return { files, unreadable };
}

function noQuestData(archive: ZipArchive): AppError {
  const paths = archive.files().map((e) => e.path).filter((p) => p.includes("ftbquests")).slice(
    0,
    20,
  );
  return new AppError(
    "E_NO_QUEST_LOCALIZATION",
    `No ${QUEST_DIR}/** data was found in this archive`,
    {
      hint: paths.length > 0
        ? `Found related paths: ${paths.join(", ")}`
        : "The pack may use a different questing mod, or quests may ship inside a mod jar.",
    },
  );
}

/**
 * `ftb-quests-neoforge-2101.1.10.jar` -> `2101.1.10`.
 * Deliberately narrow: only jars whose name starts with the FTB Quests mod id
 * match, so an unrelated questing mod is never reported as this one.
 */
const FTB_QUESTS_JAR = /^ftb[-_]?quests[-_].*?[-_](\d[\w.\-+]*)\.jar$/i;

function questModFromFileName(fileName: string): string | undefined {
  const match = FTB_QUESTS_JAR.exec(fileName);
  return match ? match[1] : undefined;
}

async function detectQuestMod(
  archive: ZipArchive,
  flavour: ArchiveFlavour,
): Promise<{ version: string; file: string } | undefined> {
  // Modrinth lists mod jars in its index; they are downloaded, not bundled.
  if (flavour === "modrinth") {
    try {
      const index = JSON.parse(await archive.readText("modrinth.index.json")) as {
        files?: { path?: string }[];
      };
      for (const entry of index.files ?? []) {
        const name = (entry.path ?? "").split("/").pop() ?? "";
        const version = questModFromFileName(name);
        if (version) return { version, file: name };
      }
    } catch {
      // Metadata only; never fatal.
    }
  }

  // Either flavour may also ship the jar inside the archive.
  for (const entry of archive.files()) {
    const name = entry.path.split("/").pop() ?? "";
    const version = questModFromFileName(name);
    if (version) return { version, file: name };
  }

  // A CurseForge manifest references files by numeric id only, so there is
  // nothing to read there. Reporting "unknown" is better than guessing.
  return undefined;
}

function detectFlavour(archive: ZipArchive): ArchiveFlavour {
  if (archive.has("modrinth.index.json")) return "modrinth";
  if (archive.has("manifest.json")) return "curseforge";
  return "plain";
}

async function readPackInfo(archive: ZipArchive, flavour: ArchiveFlavour): Promise<PackInfo> {
  try {
    if (flavour === "modrinth") {
      const index = JSON.parse(await archive.readText("modrinth.index.json")) as {
        name?: string;
        versionId?: string;
        dependencies?: Record<string, string>;
      };
      const deps = index.dependencies ?? {};
      const loaderKey = Object.keys(deps).find((k) => k !== "minecraft");
      return {
        name: index.name,
        version: index.versionId,
        minecraftVersion: deps.minecraft,
        loader: loaderKey ? `${loaderKey} ${deps[loaderKey]}` : undefined,
      };
    }
    if (flavour === "curseforge") {
      const manifest = JSON.parse(await archive.readText("manifest.json")) as {
        name?: string;
        version?: string;
        minecraft?: { version?: string; modLoaders?: { id?: string; primary?: boolean }[] };
      };
      const loaders = manifest.minecraft?.modLoaders ?? [];
      const primary = loaders.find((l) => l.primary) ?? loaders[0];
      return {
        name: manifest.name,
        version: manifest.version,
        minecraftVersion: manifest.minecraft?.version,
        loader: primary?.id,
      };
    }
  } catch {
    // A malformed manifest costs us metadata, not the run.
  }
  return {};
}

async function readChapterFiles(
  archive: ZipArchive,
  root: string,
  limit: number,
): Promise<ChapterFile[]> {
  const prefix = `${root}${QUEST_DIR}/chapters/`;
  const out: ChapterFile[] = [];
  for (const entry of archive.files()) {
    if (out.length >= limit) break;
    if (!entry.path.startsWith(prefix)) continue;
    if (!entry.path.toLowerCase().endsWith(".snbt")) continue;
    try {
      out.push({ path: entry.path, text: await archive.readText(entry.path) });
    } catch {
      // Context only; a chapter we cannot read is not fatal.
    }
  }
  return out;
}

/** Files to sample when deciding which "no lang file" story to tell. */
const HINT_SAMPLE_FILES = 20;

/**
 * Translation keys referenced by a bounded sample of the pack's quest files.
 * A raw-text scan is enough: this decides which sentence an error message ends
 * with, not what gets translated.
 */
async function samplePlaceholders(archive: ZipArchive): Promise<string[]> {
  const root = findQuestRoot(archive);
  if (root === undefined) return [];
  const keys: string[] = [];
  let read = 0;
  for (const entry of archive.files()) {
    if (read >= HINT_SAMPLE_FILES || keys.length >= 3) break;
    if (!entry.path.startsWith(`${root}${QUEST_DIR}/`)) continue;
    if (!entry.path.toLowerCase().endsWith(".snbt")) continue;
    read++;
    try {
      for (const key of referencedKeysIn(await archive.readText(entry.path))) {
        if (!keys.includes(key)) keys.push(key);
      }
    } catch {
      // A file we cannot read simply contributes nothing to the hint.
    }
  }
  return keys;
}

async function noLocalization(archive: ZipArchive, sourceLocale: string): Promise<AppError> {
  const questPaths = archive.files()
    .map((e) => e.path)
    .filter((p) => p.includes(`${QUEST_DIR}/`))
    .slice(0, HINT_SAMPLE_FILES);

  // A pack whose quest files are full of `{translation.key}` placeholders is not
  // broken and is not too old: its strings live in a mod, and there is a mode
  // for that. Saying so here is the difference between a dead end and a next
  // command to run.
  const placeholders = await samplePlaceholders(archive);

  const hint = placeholders.length > 0
    ? `The quest files reference translation keys such as ${
      placeholders.slice(0, 3).map((k) => `{${k}}`).join(", ")
    } ` +
      `instead of holding quest text, so their English strings live in a mod's ` +
      `assets/<namespace>/lang/${sourceLocale}.json. Re-run with ` +
      `--lang-jar <path-to-that-mod.jar> to translate them into a resource pack.`
    : questPaths.length > 0
    ? `The archive does contain FTB Quests data, but no lang/${sourceLocale}.snbt. ` +
      `Found: ${questPaths.join(", ")}. This pack may predate FTB Quests' lang-file export, ` +
      `in which case quest text is still inline in the chapter files and is not supported in v1.`
    : "No config/ftbquests/quests/** data was found in this archive at all. " +
      "The pack may use a different questing mod, or quests may ship inside a mod jar.";

  return new AppError(
    "E_NO_QUEST_LOCALIZATION",
    `No modern FTB Quests localization file (config/ftbquests/quests/lang/${sourceLocale}.snbt) ` +
      `was found in the archive`,
    { hint },
  );
}
