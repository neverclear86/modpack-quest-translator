import { fastHashHex } from "../util/hash.ts";
import type { TranslationUnit } from "./adapter.ts";

/**
 * One digest per SNBT key, covering array elements too.
 *
 * A translation run records these for the *source* file, so a later run can
 * diff added/changed/removed/reused keys without the manifest carrying the
 * whole source file. The packager then re-computes them over the *payload* and
 * compares: a payload that still digests to the source, key for key, is the
 * pack's own prose rather than a translation of it.
 *
 * Both sides must therefore compute it identically, which is why this lives
 * here rather than in either of them.
 */
export function digestByKey(units: readonly TranslationUnit[]): Record<string, string> {
  const byKey = new Map<string, string[]>();
  for (const unit of units) {
    const parts = byKey.get(unit.key) ?? [];
    parts.push(unit.text);
    byKey.set(unit.key, parts);
  }
  const out: Record<string, string> = {};
  for (const [key, parts] of byKey) out[key] = fastHashHex(JSON.stringify(parts));
  return out;
}
