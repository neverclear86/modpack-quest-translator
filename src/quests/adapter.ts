/**
 * Quest-format adapters: the one seam between "how a pack stores its quest
 * strings" and everything downstream. Extraction, batching, the cache, the
 * glossary, token preservation, validation and packaging are written against
 * `TranslationUnit` alone, so a new storage format is a new adapter and nothing
 * else. See DESIGN.md §5.1.
 *
 * Two are registered:
 *  - `ftbquests-lang`     — FTB Quests' own `config/ftbquests/quests/lang/*.snbt`
 *  - `minecraft-lang-json` — `assets/<namespace>/lang/<locale>.json`, for packs
 *    whose quest files hold `{translation.key}` placeholders instead of prose.
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

/**
 * What the caller knows that the document itself does not.
 *
 * A mod's `en_us.json` holds every string the mod ships -- item names, GUI
 * labels, quest prose -- and only the quest files know which of them the quests
 * actually use. `keys` carries that answer in, so the adapter stays a pure
 * function of (document, selection) and the "which keys?" policy stays with the
 * caller that can see the pack.
 */
export interface ExtractContext {
  /** Restrict extraction to these keys. Absent means "everything". */
  readonly keys?: readonly string[];
}

/** A value's shape, for whole-document validation across formats. */
export interface ValueShape {
  readonly type: string;
  /** Element count, for array-shaped values. */
  readonly length?: number;
}

export function describeShape(shape: ValueShape): string {
  return shape.length === undefined ? shape.type : `${shape.type}[${shape.length}]`;
}

export interface QuestFormatAdapter {
  readonly id: string;
  readonly description: string;
  /** Extension of the payload `apply` produces: `snbt`, `json`, ... */
  readonly payloadExtension: string;
  detect(source: string): DetectionResult;
  extract(source: string, context?: ExtractContext): TranslatableDocument;
  /** Rebuild the document, joining translations by unit id only. */
  apply(
    source: string,
    translations: ReadonlyMap<string, string>,
    context?: ExtractContext,
  ): string;
  /**
   * Key to value shape, for the whole-document check that runs before anything
   * is written. Throws when the text does not parse; the caller turns that into
   * a validation problem.
   */
  shapes(source: string, context?: ExtractContext): Map<string, ValueShape>;
}
