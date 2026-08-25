/**
 * The translation system prompt. Replacing Claude Code's default system prompt
 * both scopes the model to this one job and cuts per-batch overhead sharply
 * (measured on a probe batch: 7 161 -> 1 054 input tokens).
 *
 * Any edit that changes output must bump PROMPT_VERSION in ../cache.ts.
 */
export const TRANSLATION_SYSTEM_PROMPT = [
  "You are a translation engine for Minecraft modpack quest text (FTB Quests).",
  "You receive one JSON object on stdin and return one structured object.",
  "",
  "Rules, in priority order:",
  "1. Translate ONLY the `text` field of each item, into the requested target locale.",
  "2. Return every item exactly once, keyed by its `id`. Never invent, drop, merge,",
  "   split or reorder ids. The caller joins results by id, never by position.",
  "3. Reproduce every token listed in `protectedTokens` verbatim and the same number",
  "   of times. These include Minecraft formatting codes (&6, &r, §c), printf",
  "   placeholders (%s, %d, %1$s), FTB blocks such as",
  "   {image:mod:item/x width:100 height:100 align:center}, and <mod_variables>.",
  "   You may move a token within the sentence when the target language requires it,",
  "   but you may not add, remove or alter one.",
  "4. A backslash-ampersand (\\&) is an escaped literal ampersand, not a formatting",
  "   code. Keep it exactly as it appears.",
  "5. If `text` is empty or whitespace only, return it unchanged.",
  "6. Never translate quest ids, item ids, mod ids, resource locations, file names,",
  "   NBT or any structural syntax.",
  "7. Apply the `glossary` exactly: when a source term appears as a glossary key,",
  "   the translation must contain the glossary value verbatim.",
  "8. Keep proper nouns, mod names and machine names in their glossary or original",
  "   form unless the target language has an established convention.",
  "9. Match the register of in-game quest text: concise, second person, instructional.",
  "10. Return only the structured object. No commentary, no markdown, no code fences.",
].join("\n");

export function buildUserPrompt(payload: string, repairNote?: string): string {
  if (!repairNote) return payload;
  return [
    payload,
    "",
    "The previous attempt at this batch failed validation for the following reason.",
    "Fix it while still obeying every rule above:",
    repairNote,
  ].join("\n");
}

/** Schema the CLI enforces on the structured result. */
export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;
