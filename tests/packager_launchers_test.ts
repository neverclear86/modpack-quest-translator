import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  LINUX_BINARY_NAME,
  linuxLauncher,
  WINDOWS_BINARY_NAME,
  windowsLauncher,
} from "../src/packager/launchers.ts";

/** Names of `%VAR%` / `%~dp0` expansions that appear outside double quotes. */
function unquotedBatchExpansions(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      if (line[i] !== "%") continue;
      // Match a whole expansion and step over it, so its closing % is not
      // mistaken for the start of another one.
      const match = /^%(~[\w~]*|[A-Za-z_][\w]*%)/.exec(line.slice(i));
      if (!match) continue;
      if (!quoted) found.push(match[1].replace(/%$/, ""));
      i += match[0].length - 1;
    }
  }
  return found;
}

/** Names of `$VAR` expansions that appear outside double quotes. */
function unquotedShellExpansions(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    let double = false;
    let single = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && !single) double = !double;
      else if (char === "'" && !double) single = !single;
      if (char !== "$" || double || single) continue;
      const match = /^\$\{?([A-Z_][A-Z0-9_]+)/.exec(line.slice(i));
      if (match) found.push(match[1]);
    }
  }
  return found;
}

Deno.test("the Windows launcher locates the bundle relative to itself, never the cwd", () => {
  const text = windowsLauncher("install");
  assertStringIncludes(text, "%~dp0");
  // A double-clicked .cmd can start in C:\Windows\System32, so a cd is a bug.
  for (const line of text.split(/\r?\n/)) {
    assert(!/^\s*(cd|chdir|pushd)\b/i.test(line), `unexpected directory change: ${line}`);
  }
});

Deno.test("the Windows launcher quotes every path expansion", () => {
  for (const command of ["install", "uninstall"] as const) {
    // The errorlevel is a number and must not be quoted; nothing else qualifies.
    assertEquals(unquotedBatchExpansions(windowsLauncher(command)), ["MQT_CODE"]);
  }
});

Deno.test("the Windows launcher renders Japanese, waits, and returns the real code", () => {
  const text = windowsLauncher("install");
  assertStringIncludes(text, "chcp 65001");
  assertStringIncludes(text, "pause");
  assertStringIncludes(text, "exit /b %MQT_CODE%");
  assertStringIncludes(text, `bin\\${WINDOWS_BINARY_NAME}`);
  assertStringIncludes(text, "install --bundle");
});

Deno.test("the Windows launcher takes a dropped path and warns about extra ones", () => {
  const text = windowsLauncher("install");
  assertStringIncludes(text, 'set "MQT_INSTANCE=%~1"');
  assertStringIncludes(text, 'if not "%~2"==""');
  assertStringIncludes(text, "set /p");
});

Deno.test("the Windows launcher uses CRLF, because Notepad and cmd expect it", () => {
  const text = windowsLauncher("uninstall");
  assert(text.includes("\r\n"));
  assertEquals(text.split("\n").length, text.split("\r\n").length);
  assertStringIncludes(text, "uninstall --bundle");
});

Deno.test("the shell launcher is strict, self-locating and LF-only", () => {
  const text = linuxLauncher("install");
  assert(text.startsWith("#!/bin/sh\n"));
  assert(!text.includes("\r"));
  assertStringIncludes(text, "set -eu");
  assertStringIncludes(text, 'BUNDLE_DIR=$(cd -- "$(dirname -- "$0")" && pwd)');
  assertStringIncludes(text, `bin/${LINUX_BINARY_NAME}`);
  assertStringIncludes(
    text,
    'exec "$EXE" install --bundle "$BUNDLE_DIR" --instance "$INSTANCE" "$@"',
  );
});

Deno.test("the shell launcher restores the execute bit some unzip tools drop", () => {
  assertStringIncludes(linuxLauncher("install"), "chmod +x");
});

Deno.test("the shell launcher quotes every expansion", () => {
  for (const command of ["install", "uninstall"] as const) {
    assertEquals(unquotedShellExpansions(linuxLauncher(command)), []);
  }
});

Deno.test("the shell launcher expands ~ itself, since the installer cannot", () => {
  const text = linuxLauncher("install");
  assertStringIncludes(text, "$HOME");
});

Deno.test("a leading flag is passed through rather than taken as the instance", () => {
  const text = linuxLauncher("uninstall");
  assertStringIncludes(text, "-*)");
  assertStringIncludes(text, 'exec "$EXE" uninstall');
});
