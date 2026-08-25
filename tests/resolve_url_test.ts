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
