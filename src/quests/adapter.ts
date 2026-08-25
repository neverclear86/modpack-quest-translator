/**
 * Quest-format adapters. v1 registers only the modern FTB Quests `lang/*.snbt`
 * adapter; older inline quest data and other quest mods can be added without
 * touching extraction, translation or packaging. See DESIGN.md §5.1.
 */

export interface TranslationUnit {
  /** Stable identity: the SNBT key, plus `#index` for array elements. */
  readonly id: string;
  /** The SNBT key this unit belongs to. */
  readonly key: string;
  /** Last dot segment of the key: `title`, `quest_desc`, `quest_subtitle`, ... */
  readonly kind: string;
  /** Array element index, or -1 for a scalar string. */
  readonly index: number;
  /** The FTB object id embedded in the key, when the key has the usual shape. */
  readonly objectId?: string;
  readonly text: string;
  /** Markers the translation must reproduce verbatim. */
  readonly protectedTokens: string[];
  /** Chapter title, when the chapter index could resolve one. */
  chapter?: string;
}

export interface TranslatableDocument {
  readonly units: TranslationUnit[];
  /** Number of distinct SNBT keys, for reporting. */
  readonly keyCount: number;
}

export interface DetectionResult {
  readonly supported: boolean;
  readonly reason?: string;
}

export interface QuestFormatAdapter {
  readonly id: string;
  readonly description: string;
  detect(source: string): DetectionResult;
  extract(source: string): TranslatableDocument;
  /** Rebuild the document, joining translations by unit id only. */
  apply(source: string, translations: ReadonlyMap<string, string>): string;
}
