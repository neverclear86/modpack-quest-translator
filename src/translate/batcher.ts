import type { TranslationUnit } from "../quests/adapter.ts";
import type { Batch } from "./types.ts";

export interface BatchOptions {
  maxItems: number;
  maxChars: number;
}

/**
 * Deterministic, stable-ordered batching. Units are grouped by chapter first —
 * SNBT id order interleaves chapters, so closing a batch on every chapter
 * change would emit roughly one batch per string — then each chapter's units,
 * still in source order, are chunked until either bound is reached. Chapters
 * keep their first-seen order, batches never mix chapters, and a single unit
 * larger than the character budget becomes its own batch, flagged so the
 * orchestrator can send it straight to the stronger model. See DESIGN.md §6.2.
 */
export function buildBatches(
  units: readonly TranslationUnit[],
  options: BatchOptions,
): Batch[] {
  const byChapter = new Map<string | undefined, TranslationUnit[]>();
  for (const unit of units) {
    const group = byChapter.get(unit.chapter);
    if (group) group.push(unit);
    else byChapter.set(unit.chapter, [unit]);
  }

  const batches: Batch[] = [];
  let current: TranslationUnit[] = [];
  let currentChars = 0;

  for (const [chapter, group] of byChapter) {
    const flush = (longProse = false) => {
      if (current.length === 0) return;
      batches.push({
        id: `batch-${String(batches.length).padStart(4, "0")}`,
        index: batches.length,
        units: current,
        chapter,
        longProse,
      });
      current = [];
      currentChars = 0;
    };

    for (const unit of group) {
      const size = unit.text.length;

      if (size > options.maxChars) {
        flush();
        current = [unit];
        flush(true);
        continue;
      }

      const wouldOverflow = current.length >= options.maxItems ||
        (current.length > 0 && currentChars + size > options.maxChars);
      if (wouldOverflow) flush();

      current.push(unit);
      currentChars += size;
    }

    // A chapter never spills into the next one's batch.
    flush();
  }

  return batches;
}
