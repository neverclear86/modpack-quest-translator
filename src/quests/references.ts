/**
 * Some packs keep no quest prose in their quest files at all: every visible
 * string is a `{translation.key}` placeholder resolved at runtime against a mod's
 * `assets/<namespace>/lang/<locale>.json`. This module answers the two questions
 * that mode needs, from the quest files alone:
 *
 *  - which translation keys do the quests actually reference?
 *  - which visible labels are hard-coded prose, and therefore out of reach?
 *
 * Both answers come from the parsed SNBT rather than from a text scan, so an
 * escape sequence cannot forge a reference and a `title` inside a task is found
 * wherever the pack chose to nest it.
 */

import { parseSnbt } from "./snbt/mod.ts";
import type { SnbtCompound, SnbtValue } from "./snbt/mod.ts";
import { stripPlaceholders } from "./tokens.ts";

/**
 * A Minecraft translation key inside FTB's `{...}` substitution braces.
 *
 * Deliberately narrow, because the same braces carry FTB's own markup:
 * `{image:mod:tex.png width:100}` and `{item:minecraft:apple}` contain a colon
 * and spaces, `{player}` has no dot. Requiring `a.b`-shaped, colon-free,
 * space-free content separates the two without a list of known markup verbs.
 */
const TRANSLATION_KEY = /\{([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_+-]+)+)\}/g;

/** Members whose strings a player reads as a label. */
const LABEL_FIELDS = new Set(["title", "subtitle", "description"]);

export interface QuestFile {
  /** Archive path, used for reporting and for chapter attribution. */
  path: string;
  text: string;
}

export interface LiteralLabel {
  /** `title`, `subtitle` or `description`. */
  field: string;
  text: string;
  /** The first file it was seen in. */
  file: string;
  /** How many label positions across all files hold this exact string. */
  count: number;
}

export interface ReferenceScan {
  /** Every referenced key, de-duplicated, in first-seen order. */
  keys: string[];
  /** Hard-coded visible labels, which no lang file can translate. */
  literals: LiteralLabel[];
  /** Key to the file that referenced it first. */
  fileByKey: Map<string, string>;
  /** File to its own title member, its `filename`, or its base name. */
  titleByFile: Map<string, string>;
  /** Files that were read. */
  files: string[];
  /**
   * Files whose references are unknown rather than absent: they did not parse,
   * or they could not be read out of the archive at all.
   */
  unparsed: string[];
}

/** Translation keys referenced by one string, in order, with duplicates kept. */
export function referencedKeysIn(text: string): string[] {
  return [...text.matchAll(TRANSLATION_KEY)].map((match) => match[1]);
}

/**
 * Is this label hard-coded prose rather than a placeholder?
 *
 * Everything the substitution and formatting machinery owns is removed first,
 * so `{image:...}`, a bare `{quest.x.title}` and `&6` never count. What is left
 * must contain a letter: a lone `3` or a `#` is not a translatable label.
 */
function isLiteralLabel(text: string): boolean {
  const rest = stripPlaceholders(text).replace(/[&§][0-9a-fk-orA-FK-OR]/g, "");
  return /\p{L}/u.test(rest);
}

function stringMember(compound: SnbtCompound, key: string): string | undefined {
  const member = compound.members.find((m) => m.key === key);
  if (!member || member.value.type !== "string") return undefined;
  return member.value.value.length > 0 ? member.value.value : undefined;
}

function baseName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.snbt$/i, "");
}

/**
 * Scan quest files for translation-key references and hard-coded labels.
 *
 * `unreadable` names quest files the caller could not hand over at all -- a
 * damaged or truncated archive entry. They join the ones that failed to parse:
 * from here they are indistinguishable, because in both cases what they
 * reference is unknown rather than absent, and a scan that dropped them would
 * report coverage of files it never saw.
 */
export function scanQuestReferences(
  files: readonly QuestFile[],
  unreadable: readonly string[] = [],
): ReferenceScan {
  const keys: string[] = [];
  const fileByKey = new Map<string, string>();
  const titleByFile = new Map<string, string>();
  const literalsBy = new Map<string, LiteralLabel>();
  const read: string[] = [];
  const unparsed: string[] = [...unreadable];

  for (const file of files) {
    let root: SnbtCompound;
    try {
      root = parseSnbt(file.text);
    } catch {
      unparsed.push(file.path);
      continue;
    }
    read.push(file.path);
    titleByFile.set(
      file.path,
      stringMember(root, "title") ?? stringMember(root, "filename") ?? baseName(file.path),
    );

    const noteKey = (key: string) => {
      if (fileByKey.has(key)) return;
      fileByKey.set(key, file.path);
      keys.push(key);
    };

    const noteLiteral = (field: string, text: string) => {
      if (!isLiteralLabel(text)) return;
      const id = `${field}\0${text}`;
      const existing = literalsBy.get(id);
      if (existing) existing.count++;
      else literalsBy.set(id, { field, text, file: file.path, count: 1 });
    };

    walk(root, undefined, noteKey, noteLiteral);
  }

  return {
    keys,
    literals: [...literalsBy.values()],
    fileByKey,
    titleByFile,
    files: read,
    unparsed,
  };
}

function walk(
  value: SnbtValue,
  field: string | undefined,
  noteKey: (key: string) => void,
  noteLiteral: (field: string, text: string) => void,
): void {
  switch (value.type) {
    case "string":
      for (const key of referencedKeysIn(value.value)) noteKey(key);
      if (field) noteLiteral(field, value.value);
      return;
    case "array":
      // An array under `description:` is one label per element; an array of
      // quests is not a label at all, so the field only survives one level.
      for (const item of value.items) walk(item, field, noteKey, noteLiteral);
      return;
    case "compound":
      for (const member of value.members) {
        walk(
          member.value,
          LABEL_FIELDS.has(member.key) ? member.key : undefined,
          noteKey,
          noteLiteral,
        );
      }
      return;
    default:
      // Numbers, booleans and typed arrays are never quest prose.
      return;
  }
}
