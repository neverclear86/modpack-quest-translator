import type { QuestFormatAdapter } from "./adapter.ts";
import { ftbQuestsLangAdapter } from "./ftbquests_lang.ts";
import { minecraftLangJsonAdapter } from "./lang_json.ts";

/**
 * Order is priority: `selectAdapter` is only ever handed a pack's own quest
 * localization file, and an SNBT lang file must keep resolving to the SNBT
 * adapter. The JSON adapter is normally chosen explicitly (the caller has a
 * `--lang-jar` and a namespace); it sits here so the registry is the one honest
 * list of what this tool understands.
 */
export const QUEST_ADAPTERS: readonly QuestFormatAdapter[] = [
  ftbQuestsLangAdapter,
  minecraftLangJsonAdapter,
];

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
