import { assertEquals, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { classifyPackUrl } from "../src/resolve/url.ts";

Deno.test("curseforge modpack project urls", () => {
  const r = classifyPackUrl(
    "https://www.curseforge.com/minecraft/modpacks/all-of-create-aeronautics",
  );
  assertEquals(r.kind, "curseforge");
  assertEquals(r.slug, "all-of-create-aeronautics");
  assertEquals(r.fileId, undefined);
});

Deno.test("curseforge urls without the www host and with trailing slash", () => {
  const r = classifyPackUrl("https://curseforge.com/minecraft/modpacks/some-pack/");
  assertEquals(r.kind, "curseforge");
  assertEquals(r.slug, "some-pack");
});

Deno.test("curseforge file and download urls pin an exact release", () => {
  const files = classifyPackUrl("https://www.curseforge.com/minecraft/modpacks/aca/files/6543210");
  assertEquals(files.kind, "curseforge");
  assertEquals(files.fileId, 6543210);
  const dl = classifyPackUrl("https://www.curseforge.com/minecraft/modpacks/aca/download/6543210");
  assertEquals(dl.fileId, 6543210);
  const query = classifyPackUrl(
    "https://www.curseforge.com/minecraft/modpacks/aca/files/all?fileId=999",
  );
  assertEquals(query.fileId, 999);
});

Deno.test("curseforge non-modpack projects are rejected", () => {
  const err = assertThrows(
    () => classifyPackUrl("https://www.curseforge.com/minecraft/mc-mods/jei"),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_UNSUPPORTED_PACK");
  assertThrows(
    () => classifyPackUrl("https://www.curseforge.com/minecraft/texture-packs/x"),
    AppError,
  );
});

Deno.test("modrinth modpack project urls", () => {
  const r = classifyPackUrl("https://modrinth.com/modpack/rubius-cobblemon");
  assertEquals(r.kind, "modrinth");
  assertEquals(r.slug, "rubius-cobblemon");
  assertEquals(r.versionId, undefined);
});

Deno.test("modrinth version urls pin an exact release", () => {
  const r = classifyPackUrl("https://modrinth.com/modpack/rubius-cobblemon/version/SzR6i4dZ");
  assertEquals(r.kind, "modrinth");
  assertEquals(r.slug, "rubius-cobblemon");
  assertEquals(r.versionId, "SzR6i4dZ");
});

Deno.test("modrinth non-modpack projects are rejected", () => {
  const err = assertThrows(
    () => classifyPackUrl("https://modrinth.com/mod/sodium"),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_UNSUPPORTED_PACK");
  assertThrows(() => classifyPackUrl("https://modrinth.com/resourcepack/x"), AppError);
});

Deno.test("direct archive urls are accepted", () => {
  const zip = classifyPackUrl("https://example.com/packs/pack-1.2.3.zip");
  assertEquals(zip.kind, "direct");
  assertEquals(zip.url, "https://example.com/packs/pack-1.2.3.zip");
  const mr = classifyPackUrl("https://cdn.modrinth.com/data/A/versions/B/Pack%201.0.mrpack");
  assertEquals(mr.kind, "direct");
  const cf = classifyPackUrl("https://mediafilez.forgecdn.net/files/1234/567/Pack.zip");
  assertEquals(cf.kind, "direct");
});

Deno.test("non-http schemes are rejected", () => {
  for (
    const bad of ["file:///etc/passwd", "ftp://x/y.zip", "javascript:alert(1)", "data:text/plain,x"]
  ) {
    const err = assertThrows(() => classifyPackUrl(bad), AppError) as AppError;
    assertEquals(err.code, "E_INVALID_INPUT");
  }
});

Deno.test("unparseable and ambiguous urls are rejected with guidance", () => {
  assertThrows(() => classifyPackUrl("not a url"), AppError);
  assertThrows(() => classifyPackUrl(""), AppError);
  const err = assertThrows(
    () => classifyPackUrl("https://example.com/some/page"),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_UNSUPPORTED_PACK");
  assertEquals(typeof err.hint, "string");
});

Deno.test("plain http is allowed but recorded as insecure", () => {
  const r = classifyPackUrl("http://example.com/pack.zip");
  assertEquals(r.kind, "direct");
  assertEquals(r.insecure, true);
});

Deno.test("a malformed percent-escape is actionable invalid input, not an internal error", () => {
  // decodeURIComponent throws a bare URIError("URI malformed"). Left alone it
  // escaped classification as an unhandled internal failure and exited 1,
  // telling the user to file a bug about their own typo.
  for (
    const bad of [
      "https://example.com/%E0%A4%A.zip",
      "https://www.curseforge.com/minecraft/modpacks/%E0%A4%A",
      "https://modrinth.com/modpack/%E0%A4%A",
      "https://example.com/pack%.zip",
      "https://example.com/pack%zz.zip",
      "https://example.com/%.mrpack",
    ]
  ) {
    const err = assertThrows(() => classifyPackUrl(bad), AppError, undefined, bad) as AppError;
    assertEquals(err.code, "E_INVALID_INPUT", bad);
    assertEquals(err.exitCode, 2, bad);
    assertEquals(err.message.includes("percent-encoding"), true, bad);
    assertEquals(typeof err.hint, "string", bad);
    // The raw engine wording must not be what the user is shown.
    assertEquals(err.message.includes("URI malformed"), false, bad);
  }
});

Deno.test("well-formed percent-escapes are still decoded normally", () => {
  const cf = classifyPackUrl("https://www.curseforge.com/minecraft/modpacks/all%2Dof%2Dcreate");
  assertEquals(cf.kind, "curseforge");
  assertEquals(cf.slug, "all-of-create");
  // A fully escaped multi-byte character is valid and must survive.
  const mr = classifyPackUrl("https://modrinth.com/modpack/%E3%81%82");
  assertEquals(mr.kind, "modrinth");
  assertEquals(mr.slug, "あ");
  assertEquals(classifyPackUrl("https://example.com/%E3%81%82.zip").kind, "direct");
});

Deno.test("a malformed escape outside the path does not reject a good url", () => {
  // Only the path is decoded, so a stray % in the query is not our business.
  assertEquals(classifyPackUrl("https://example.com/pack.zip?token=100%").kind, "direct");
});
