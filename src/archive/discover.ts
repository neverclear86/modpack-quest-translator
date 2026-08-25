import { AppError } from "../errors.ts";
import type { ZipArchive } from "./zip/reader.ts";
import { selectAdapter } from "../quests/registry.ts";
import type { QuestFormatAdapter } from "../quests/adapter.ts";
import type { ChapterFile } from "../quests/chapter_index.ts";

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
}

export interface DiscoverOptions {
  sourceLocale: string;
  /** Cap on chapter files read for context; they are an optimisation only. */
  maxChapterFiles?: number;
}

/** Roots to search, in priority order. */
const ROOTS = ["", "overrides/", "server-overrides/", "client-overrides/"];

const QUEST_DIR = "config/ftbquests/quests";
const DEFAULT_MAX_CHAPTER_FILES = 500;

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

  if (matches.length === 0) throw noLocalization(archive, options.sourceLocale);

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

function noLocalization(archive: ZipArchive, sourceLocale: string): AppError {
  const questPaths = archive.files()
    .map((e) => e.path)
    .filter((p) => p.includes(`${QUEST_DIR}/`))
    .slice(0, 20);

  const hint = questPaths.length > 0
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
