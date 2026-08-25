import { fastHashHex } from "../util/hash.ts";
import { joinPath, writeFileAtomic } from "../util/fs.ts";

/** Bumped whenever the translation prompt changes in a way that alters output. */
export const PROMPT_VERSION = 1;

export interface CacheKeyFields {
  sourceLocale: string;
  targetLocale: string;
  provider: string;
  promptVersion: number;
  glossaryVersion: string;
}

export interface CacheEntry {
  text: string;
  /** The model that actually produced this translation. */
  model: string;
}

export interface CacheOptions {
  enabled?: boolean;
}

interface CacheFile {
  version: 1;
  key: CacheKeyFields;
  entries: Record<string, CacheEntry>;
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  stores: number;
  /** Entries that were found but failed revalidation and were discarded. */
  rejected: number;
}

export interface CacheLookup {
  model: string;
  /** Also consulted, so a string rescued by the stronger model is still reused. */
  fallbackModel?: string;
  /**
   * Revalidation gate, run against every candidate before it is handed back.
   * An entry that fails is discarded and the lookup continues as a miss.
   *
   * A cache entry is a translation that some *earlier* run validated, against
   * that run's source text, glossary and validation rules. All three can have
   * changed since -- the pack updated, `--glossary` gained a term, the tool
   * learned to check something it used to miss -- and the file itself is
   * user-editable. Reusing an entry without re-checking it is the one path
   * that can put an unvalidated string into an "all keys validated" archive.
   */
  accept?: (entry: CacheEntry) => boolean;
}

/** Stable identity for a glossary, so changing it invalidates the cache. */
export function glossaryVersion(glossary: Readonly<Record<string, string>> | undefined): string {
  if (!glossary) return "none";
  const keys = Object.keys(glossary).sort();
  if (keys.length === 0) return "none";
  return fastHashHex(JSON.stringify(keys.map((k) => [k, glossary[k]])));
}

/**
 * Resumable translation cache. Keyed by source text, source locale, target
 * locale, provider, model, prompt version and glossary version -- exactly the
 * fields the requirements list. Lookup consults the primary model's namespace
 * first and then the fallback's, so a string rescued by the stronger model is
 * still reused on resume. See DESIGN.md §6.3.
 */
export class TranslationCache {
  readonly #path: string;
  readonly #key: CacheKeyFields;
  readonly #entries: Map<string, CacheEntry>;
  readonly #enabled: boolean;
  #dirty = false;
  /** Serialises flushes so two in-flight writes cannot land out of order. */
  #flushing: Promise<void> = Promise.resolve();
  #hits = 0;
  #misses = 0;
  #stores = 0;
  #rejected = 0;

  private constructor(
    path: string,
    key: CacheKeyFields,
    entries: Map<string, CacheEntry>,
    enabled: boolean,
  ) {
    this.#path = path;
    this.#key = key;
    this.#entries = entries;
    this.#enabled = enabled;
  }

  static async open(
    directory: string,
    key: CacheKeyFields,
    options: CacheOptions = {},
  ): Promise<TranslationCache> {
    const enabled = options.enabled ?? true;
    const path = joinPath(directory, `${namespaceOf(key)}.json`);
    const entries = new Map<string, CacheEntry>();

    if (enabled) {
      try {
        const parsed = JSON.parse(await Deno.readTextFile(path)) as CacheFile;
        if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") {
          for (const [id, entry] of Object.entries(parsed.entries)) {
            if (typeof entry?.text === "string" && typeof entry?.model === "string") {
              entries.set(id, entry);
            }
          }
        }
      } catch {
        // Missing or corrupt: start empty rather than fail the run.
      }
    }

    return new TranslationCache(path, key, entries, enabled);
  }

  /**
   * Look up in the primary model's namespace, then the fallback's. Nothing is
   * returned that `lookup.accept` rejects; see CacheLookup for why that gate
   * exists at all.
   */
  get(sourceText: string, lookup: CacheLookup): CacheEntry | undefined {
    if (!this.#enabled) return undefined;
    const candidates = lookup.fallbackModel ? [lookup.model, lookup.fallbackModel] : [lookup.model];
    for (const candidate of candidates) {
      const id = this.#id(sourceText, candidate);
      const entry = this.#entries.get(id);
      if (!entry) continue;
      if (lookup.accept && !lookup.accept(entry)) {
        // Drop it rather than merely skip it: an entry that cannot be trusted
        // now will not become trustworthy on the next run, and leaving it would
        // make every future run pay to rediscover the same problem.
        this.#entries.delete(id);
        this.#dirty = true;
        this.#rejected++;
        continue;
      }
      this.#hits++;
      return entry;
    }
    this.#misses++;
    return undefined;
  }

  set(sourceText: string, model: string, text: string): void {
    if (!this.#enabled) return;
    this.#entries.set(this.#id(sourceText, model), { text, model });
    this.#stores++;
    this.#dirty = true;
  }

  /**
   * Persist atomically. Called after every batch so Ctrl+C is always safe.
   *
   * Two things matter here and both were once wrong:
   *  - the dirty flag is cleared *before* the snapshot, so a set() that lands
   *    while the write is in flight re-dirties the cache and is picked up by the
   *    next flush instead of being marked clean and dropped;
   *  - flushes are chained, so two concurrent workers cannot rename an older,
   *    smaller snapshot over a newer one.
   */
  flush(): Promise<void> {
    if (!this.#enabled) return Promise.resolve();
    const previous = this.#flushing;
    this.#flushing = (async () => {
      await previous.catch(() => {});
      if (!this.#dirty) return;
      // Clear first, snapshot second: both are synchronous, so nothing can slip
      // in between, and anything added later re-dirties for the next flush.
      this.#dirty = false;
      const file: CacheFile = {
        version: 1,
        key: this.#key,
        entries: Object.fromEntries([...this.#entries].sort(([a], [b]) => (a < b ? -1 : 1))),
      };
      const payload = `${JSON.stringify(file, null, 2)}\n`;
      try {
        await writeFileAtomic(this.#path, payload);
      } catch (error) {
        // A failed write must not leave the cache believing it is persisted.
        this.#dirty = true;
        throw error;
      }
    })();
    return this.#flushing;
  }

  stats(): CacheStats {
    return {
      entries: this.#entries.size,
      hits: this.#hits,
      misses: this.#misses,
      stores: this.#stores,
      rejected: this.#rejected,
    };
  }

  get path(): string {
    return this.#path;
  }

  #id(sourceText: string, model: string): string {
    return fastHashHex(JSON.stringify([
      sourceText,
      this.#key.sourceLocale,
      this.#key.targetLocale,
      this.#key.provider,
      model,
      this.#key.promptVersion,
      this.#key.glossaryVersion,
    ]));
  }
}

function namespaceOf(key: CacheKeyFields): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${safe(key.provider)}-${safe(key.sourceLocale)}-${safe(key.targetLocale)}-` +
    `p${key.promptVersion}-g${safe(key.glossaryVersion).slice(0, 16)}`;
}
