import { assertEquals, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { isInsideRoot, joinNative, normaliseInstanceInput } from "../src/installer/paths.ts";

function refuses(raw: string, os: "windows" | "posix"): void {
  const error = assertThrows(
    () => normaliseInstanceInput(raw, os),
    AppError,
    undefined,
    `expected ${JSON.stringify(raw)} to be refused on ${os}`,
  );
  assertEquals(error.code, "E_INVALID_INPUT");
}

Deno.test("a dropped Windows path keeps its spaces and non-ASCII characters", () => {
  assertEquals(
    normaliseInstanceInput("C:\\Users\\\u3086\u304d\\Downloads\\aca ja\\", "windows"),
    "C:\\Users\\\u3086\u304d\\Downloads\\aca ja",
  );
});

Deno.test("Windows separators are normalised and repeats collapsed", () => {
  assertEquals(normaliseInstanceInput("C:/Games/mc/", "windows"), "C:\\Games\\mc");
  assertEquals(normaliseInstanceInput("C:\\a\\\\\\b", "windows"), "C:\\a\\b");
});

Deno.test("a Windows drive root keeps its trailing separator", () => {
  assertEquals(normaliseInstanceInput("C:\\", "windows"), "C:\\");
  assertEquals(normaliseInstanceInput("c:/", "windows"), "c:\\");
});

Deno.test("a drive-relative Windows path is refused rather than guessed at", () => {
  // "C:instances" means "instances, relative to the current directory *of drive
  // C:*", which is per-drive state this process has no business inventing.
  refuses("C:instances", "windows");
  refuses("C:", "windows");
});

Deno.test("a UNC path is accepted and its root is preserved", () => {
  assertEquals(
    normaliseInstanceInput("\\\\server\\share\\inst\\", "windows"),
    "\\\\server\\share\\inst",
  );
  assertEquals(normaliseInstanceInput("//server/share", "windows"), "\\\\server\\share");
});

Deno.test("surrounding quotes from a pasted path are stripped", () => {
  assertEquals(normaliseInstanceInput('"C:\\path with space\\"', "windows"), "C:\\path with space");
  assertEquals(normaliseInstanceInput('"/home/u/mc"', "posix"), "/home/u/mc");
});

Deno.test("a POSIX path keeps non-ASCII and loses only trailing separators", () => {
  assertEquals(
    normaliseInstanceInput(
      "/home/u/\u30a4\u30f3\u30b9\u30bf\u30f3\u30b9 \u30d5\u30a9\u30eb\u30c0/",
      "posix",
    ),
    "/home/u/\u30a4\u30f3\u30b9\u30bf\u30f3\u30b9 \u30d5\u30a9\u30eb\u30c0",
  );
  assertEquals(normaliseInstanceInput("/", "posix"), "/");
  assertEquals(normaliseInstanceInput("//home//u///", "posix"), "/home/u");
});

Deno.test("an empty or control-character path is refused on both platforms", () => {
  for (const os of ["windows", "posix"] as const) {
    refuses("", os);
    refuses("   ", os);
    refuses('""', os);
    refuses("/home/u\u0000/mc", os);
    refuses("/home/u\n/mc", os);
  }
});

Deno.test("an unexpanded tilde is refused with an actionable message", () => {
  const error = assertThrows(() => normaliseInstanceInput("~/.minecraft", "posix"), AppError);
  assertEquals(error.code, "E_INVALID_INPUT");
  assertEquals(typeof error.hint, "string");
});

Deno.test("joinNative uses the separator of the platform it is told about", () => {
  assertEquals(joinNative("windows", "C:\\mc", "config", "a.snbt"), "C:\\mc\\config\\a.snbt");
  assertEquals(joinNative("windows", "C:\\", "config"), "C:\\config");
  assertEquals(joinNative("posix", "/mc", "config", "a.snbt"), "/mc/config/a.snbt");
  assertEquals(joinNative("posix", "/", "config"), "/config");
});

Deno.test("containment is checked on path segments, not on string prefixes", () => {
  assertEquals(isInsideRoot("/home/u/mc", "/home/u/mc"), true);
  assertEquals(isInsideRoot("/home/u/mc", "/home/u/mc/config/x.snbt"), true);
  // The trap: "/home/u/mc-evil" starts with "/home/u/mc" as a string.
  assertEquals(isInsideRoot("/home/u/mc", "/home/u/mc-evil/x"), false);
  assertEquals(isInsideRoot("/home/u/mc", "/home/u"), false);
  assertEquals(isInsideRoot("C:\\mc", "C:\\mc\\config", "windows"), true);
  assertEquals(isInsideRoot("C:\\mc", "C:\\mc-evil\\config", "windows"), false);
  // Windows compares case-insensitively; POSIX does not.
  assertEquals(isInsideRoot("C:\\MC", "c:\\mc\\config", "windows"), true);
  assertEquals(isInsideRoot("/home/MC", "/home/mc/config", "posix"), false);
});
