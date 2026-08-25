import { parseSnbt } from "./snbt/mod.ts";
import type { SnbtCompound, SnbtValue } from "./snbt/mod.ts";

export interface ChapterFile {
  path: string;
  text: string;
}

/**
 * Maps quest/task/reward object ids to their chapter title, so translation
 * batches can carry real chapter context. The lang file alone has no
 * quest-to-chapter edge; the chapter files do. See DESIGN.md §5.2.
 *
 * Best effort by design: a chapter file this parser cannot read degrades the
 * context rather than failing the run.
 */
export function buildChapterIndex(
  chapters: readonly ChapterFile[],
  langStrings: Readonly<Record<string, string>>,
): Map<string, string> {
  const index = new Map<string, string>();

  for (const chapter of chapters) {
    let root: SnbtCompound;
    try {
      root = parseSnbt(chapter.text);
    } catch {
      continue;
    }

    const chapterId = stringMember(root, "id");
    const filename = stringMember(root, "filename");
    const title = (chapterId ? langStrings[`chapter.${chapterId}.title`] : undefined) ??
      stringMember(root, "title") ??
      filename ??
      chapterId;
    if (!title) continue;

    if (chapterId) index.set(chapterId, title);

    const quests = arrayMember(root, "quests");
    for (const quest of quests) {
      if (quest.type !== "compound") continue;
      const questId = stringMember(quest, "id");
      if (questId) index.set(questId, title);
      for (const group of ["tasks", "rewards"]) {
        for (const child of arrayMember(quest, group)) {
          if (child.type !== "compound") continue;
          const childId = stringMember(child, "id");
          if (childId) index.set(childId, title);
        }
      }
    }
  }

  return index;
}

function stringMember(compound: SnbtCompound, key: string): string | undefined {
  const member = compound.members.find((m) => m.key === key);
  if (!member || member.value.type !== "string") return undefined;
  const value = member.value.value;
  return value.length > 0 ? value : undefined;
}

function arrayMember(compound: SnbtCompound, key: string): SnbtValue[] {
  const member = compound.members.find((m) => m.key === key);
  if (!member || member.value.type !== "array") return [];
  return member.value.items;
}
