import type { TranslationUnit } from "../quests/adapter.ts";
import type { Batch } from "./types.ts";

export interface BatchOptions {
  maxItems: number;
  maxChars: number;
}

/**
 * Deterministic, stable-ordered batching. A batch closes when either bound is
 * reached; batches never mix chapters; a single unit larger than the character
 * budget becomes its own batch and is flagged so the orchestrator can send it
 * straight to the stronger model. See DESIGN.md §6.2.
 */
export function buildBatches(
  units: readonly TranslationUnit[],
  options: BatchOptions,
): Batch[] {
  const batches: Batch[] = [];
  let current: TranslationUnit[] = [];
  let currentChars = 0;
  let currentChapter: string | undefined;

  const flush = (longProse = false) => {
    if (current.length === 0) return;
    batches.push({
      id: `batch-${String(batches.length).padStart(4, "0")}`,
      index: batches.length,
      units: current,
      chapter: currentChapter,
      longProse,
    });
    current = [];
    currentChars = 0;
    currentChapter = undefined;
  };

  for (const unit of units) {
    const size = unit.text.length;

    if (size > options.maxChars) {
      flush();
      currentChapter = unit.chapter;
      current = [unit];
      flush(true);
      continue;
    }

    const chapterChanged = current.length > 0 && unit.chapter !== currentChapter;
    const wouldOverflow = current.length >= options.maxItems ||
      (current.length > 0 && currentChars + size > options.maxChars);
    if (chapterChanged || wouldOverflow) flush();

    if (current.length === 0) currentChapter = unit.chapter;
    current.push(unit);
    currentChars += size;
  }

  flush();
  return batches;
}
