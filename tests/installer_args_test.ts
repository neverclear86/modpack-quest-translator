import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { parseInstallerArgs } from "../src/installer/args.ts";

function parse(argv: string[], interactive = false) {
  return parseInstallerArgs(argv, { interactive });
}

function refuses(argv: string[], needle: string, interactive = false): void {
  const error = assertThrows(() => parse(argv, interactive), AppError);
  assertEquals(error.code, "E_INVALID_INPUT");
  assertStringIncludes(error.message, needle);
}

Deno.test("install parses its bundle and instance", () => {
  const options = parse(["install", "--bundle", "/b", "--instance", "/i"]);
  assertEquals(options.mode, "install");
  assertEquals(options.bundleDir, "/b");
  assertEquals(options.instance, "/i");
  assertEquals(options.force, false);
  assertEquals(options.json, false);
  assertEquals(options.assumeYes, false);
});

Deno.test("uninstall and status parse the same way", () => {
  assertEquals(parse(["uninstall", "--instance", "/i"]).mode, "uninstall");
  assertEquals(parse(["status", "--instance", "/i"]).mode, "status");
});

Deno.test("flags may be given as --flag=value", () => {
  const options = parse(["install", "--bundle=/b", "--instance=/i", "--force", "--json", "--yes"]);
  assertEquals(options.bundleDir, "/b");
  assertEquals(options.instance, "/i");
  assertEquals(options.force, true);
  assertEquals(options.json, true);
  assertEquals(options.assumeYes, true);
});

Deno.test("no arguments at all shows help rather than doing something", () => {
  assertEquals(parse([]).mode, "help");
  assertEquals(parse(["--help"]).mode, "help");
  assertEquals(parse(["-h"]).mode, "help");
  assertEquals(parse(["install", "--help"]).mode, "help");
  assertEquals(parse(["--version"]).mode, "version");
});

Deno.test("an unknown subcommand or flag is refused", () => {
  refuses(["frobnicate"], "frobnicate");
  refuses(["install", "--wat"], "--wat");
  refuses(["install", "--instance", "/i", "extra"], "extra");
});

Deno.test("a flag that needs a value is refused without one", () => {
  refuses(["install", "--instance"], "--instance");
  refuses(["install", "--bundle"], "--bundle");
});

Deno.test("status takes no --force, because it changes nothing", () => {
  refuses(["status", "--instance", "/i", "--force"], "--force");
});

Deno.test("--instance is required when there is no terminal to ask on", () => {
  refuses(["install", "--bundle", "/b"], "--instance");
  // With a terminal, the path is prompted for instead: that is the double-click flow.
  assertEquals(parse(["install", "--bundle", "/b"], true).instance, undefined);
});

Deno.test("an empty instance path is refused rather than treated as the root", () => {
  refuses(["install", "--instance", ""], "--instance");
});

Deno.test("the last value wins when a flag is repeated", () => {
  assertEquals(parse(["install", "--instance", "/a", "--instance", "/b"]).instance, "/b");
});
