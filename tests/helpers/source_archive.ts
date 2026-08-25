/**
 * The modpack archive a translation run read.
 *
 * Real bytes rather than a fake digest, because the packager now reads the
 * pack's own quest file back out of it: the manifest's account of the source is
 * checked against the archive instead of being taken on trust, so a test that
 * hands over a plausible-looking digest string is testing nothing.
 */
import { writeZip } from "../../src/archive/zip/writer.ts";
import { sha256Hex } from "../../src/util/hash.ts";

const LANG_DIR = "overrides/config/ftbquests/quests/lang";

export const SOURCE_LANG_PATH = `${LANG_DIR}/en_us.snbt`;

export interface SourceArchive {
  bytes: Uint8Array;
  sha256: string;
  /** Where the quest lang file sits inside it. */
  path: string;
}

/** A CurseForge-flavoured pack archive holding one quest lang file. */
export async function sourceArchiveOf(
  source: string,
  locale = "en_us",
): Promise<SourceArchive> {
  const path = `${LANG_DIR}/${locale}.snbt`;
  const bytes = await writeZip([
    {
      path: "manifest.json",
      text: JSON.stringify({
        name: "All of Create: Aeronautics",
        version: "2.4",
        minecraft: { version: "1.21.1", modLoaders: [{ id: "neoforge-21.1.1", primary: true }] },
      }),
    },
    { path: "overrides/mods/ftb-quests-neoforge-2101.1.10.jar", text: "not really a jar" },
    { path, text: source },
  ]);
  return { bytes, sha256: await sha256Hex(bytes), path };
}
