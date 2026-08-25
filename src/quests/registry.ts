import type { QuestFormatAdapter } from "./adapter.ts";
import { ftbQuestsLangAdapter } from "./ftbquests_lang.ts";

/**
 * v1 registers one adapter. Adding `ftbquests-inline` or another quest mod is
 * a matter of appending to this list; nothing downstream changes.
 */
export const QUEST_ADAPTERS: readonly QuestFormatAdapter[] = [ftbQuestsLangAdapter];

export interface AdapterSelection {
  adapter?: QuestFormatAdapter;
  /** Why each adapter declined, when none matched. */
  reasons: { adapter: string; reason: string }[];
}

export function selectAdapter(source: string): AdapterSelection {
  const reasons: { adapter: string; reason: string }[] = [];
  for (const adapter of QUEST_ADAPTERS) {
    const result = adapter.detect(source);
    if (result.supported) return { adapter, reasons };
    reasons.push({ adapter: adapter.id, reason: result.reason ?? "not supported" });
  }
  return { reasons };
}
