import { assertEquals, assertStringIncludes } from "@std/assert";
import { AppError, EXIT_CODES, exitCodeFor } from "../src/errors.ts";

Deno.test("exit codes match the documented table", () => {
  assertEquals(EXIT_CODES.E_INTERNAL, 1);
  assertEquals(EXIT_CODES.E_INVALID_INPUT, 2);
  assertEquals(EXIT_CODES.E_UNSUPPORTED_PACK, 3);
  assertEquals(EXIT_CODES.E_DOWNLOAD, 4);
  assertEquals(EXIT_CODES.E_NO_QUEST_LOCALIZATION, 5);
  assertEquals(EXIT_CODES.E_TRANSLATION, 6);
  assertEquals(EXIT_CODES.E_VALIDATION, 7);
  assertEquals(EXIT_CODES.E_WRITE, 8);
  assertEquals(EXIT_CODES.E_PREFLIGHT, 9);
  assertEquals(EXIT_CODES.E_BUNDLE, 10);
  assertEquals(EXIT_CODES.E_INSTANCE, 11);
  assertEquals(EXIT_CODES.E_TARGET_MODIFIED, 12);
  assertEquals(EXIT_CODES.E_BACKUP, 13);
  assertEquals(EXIT_CODES.E_NOT_INSTALLED, 14);
  assertEquals(EXIT_CODES.E_SOURCE_MISMATCH, 15);
  assertEquals(EXIT_CODES.E_CANCELLED, 130);
});

Deno.test("every exit code is distinct", () => {
  const codes = Object.values(EXIT_CODES);
  assertEquals(new Set(codes).size, codes.length);
});

Deno.test("AppError carries a code and an actionable hint", () => {
  const err = new AppError("E_INVALID_INPUT", "bad url", { hint: "use https" });
  assertEquals(err.code, "E_INVALID_INPUT");
  assertEquals(err.exitCode, 2);
  assertStringIncludes(err.message, "bad url");
  assertEquals(err.hint, "use https");
});

Deno.test("exitCodeFor maps unknown errors to E_INTERNAL", () => {
  assertEquals(exitCodeFor(new Error("boom")), 1);
  assertEquals(exitCodeFor(new AppError("E_DOWNLOAD", "nope")), 4);
});

Deno.test("AppError preserves the underlying cause", () => {
  const cause = new Error("socket closed");
  const err = new AppError("E_DOWNLOAD", "download failed", { cause });
  assertEquals(err.cause, cause);
});
