import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { BoundedHttpClient, type FetchLike } from "../src/net/http.ts";
import { resolvePack } from "../src/resolve/mod.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientFor(routes: Record<string, () => Response>) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetch: FetchLike = (input, init) => {
    const url = (typeof input === "string" ? input : input.toString()).split("#")[0];
    seen.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url];
    return Promise.resolve(route ? route() : new Response("not found", { status: 404 }));
  };
  return { client: new BoundedHttpClient({ fetch }), seen };
}

const MODRINTH_PROJECT = {
  id: "NbivcHgl",
  slug: "rubius-cobblemon",
  title: "Rubius Cobblemon",
  project_type: "modpack",
};

const MODRINTH_VERSIONS = [
  {
    id: "SzR6i4dZ",
    version_number: "0.9",
    version_type: "release",
    game_versions: ["1.21.1"],
    loaders: ["neoforge"],
    date_published: "2026-06-06T16:56:03.830029Z",
    files: [
      {
        filename: "server.mrpack",
        size: 5,
        url: "https://cdn.modrinth.com/s.mrpack",
        primary: false,
      },
      {
        filename: "Rubius 0.9.mrpack",
        size: 9,
        url: "https://cdn.modrinth.com/a.mrpack",
        primary: true,
      },
    ],
  },
  {
    id: "k3INVnaD",
    version_number: "1.0-beta",
    version_type: "beta",
    game_versions: ["1.21.1"],
    loaders: ["neoforge"],
    date_published: "2026-07-01T00:00:00Z",
    files: [{
      filename: "beta.mrpack",
      size: 9,
      url: "https://cdn.modrinth.com/b.mrpack",
      primary: true,
    }],
  },
];

function modrinthRoutes(): Record<string, () => Response> {
  return {
    "https://api.modrinth.com/v2/project/rubius-cobblemon": () => json(MODRINTH_PROJECT),
    "https://api.modrinth.com/v2/project/rubius-cobblemon/version": () => json(MODRINTH_VERSIONS),
    "https://api.modrinth.com/v2/version/SzR6i4dZ": () => json(MODRINTH_VERSIONS[0]),
  };
}

Deno.test("a Modrinth project url resolves to the latest stable release", async () => {
  const { client } = clientFor(modrinthRoutes());
  const resolved = await resolvePack("https://modrinth.com/modpack/rubius-cobblemon", { client });
  assertEquals(resolved.source, "modrinth");
  assertEquals(resolved.projectName, "Rubius Cobblemon");
  assertEquals(resolved.versionName, "0.9");
  assertEquals(resolved.minecraftVersion, "1.21.1");
  assertEquals(resolved.loader, "neoforge");
  assertEquals(resolved.publishedAt, "2026-06-06T16:56:03.830029Z");
  assertEquals(resolved.downloadUrl, "https://cdn.modrinth.com/a.mrpack");
  assertEquals(resolved.fileName, "Rubius 0.9.mrpack");
});

Deno.test("a beta-only newer version is not chosen without --allow-prerelease", async () => {
  const { client } = clientFor(modrinthRoutes());
  const stable = await resolvePack("https://modrinth.com/modpack/rubius-cobblemon", { client });
  assertEquals(stable.versionName, "0.9");
  const pre = await resolvePack("https://modrinth.com/modpack/rubius-cobblemon", {
    client,
    allowPrerelease: true,
  });
  assertEquals(pre.versionName, "1.0-beta");
});

Deno.test("the primary file is preferred over other files in a version", async () => {
  const { client } = clientFor(modrinthRoutes());
  const resolved = await resolvePack("https://modrinth.com/modpack/rubius-cobblemon", { client });
  assertEquals(resolved.fileName, "Rubius 0.9.mrpack");
});

Deno.test("a Modrinth version url pins that exact release", async () => {
  const { client } = clientFor(modrinthRoutes());
  const resolved = await resolvePack(
    "https://modrinth.com/modpack/rubius-cobblemon/version/SzR6i4dZ",
    { client },
  );
  assertEquals(resolved.versionName, "0.9");
  assertEquals(resolved.downloadUrl, "https://cdn.modrinth.com/a.mrpack");
});

Deno.test("a Modrinth project that is not a modpack is rejected", async () => {
  const { client } = clientFor({
    "https://api.modrinth.com/v2/project/sodium": () =>
      json({ slug: "sodium", title: "Sodium", project_type: "mod" }),
  });
  const err = await assertRejects(
    () => resolvePack("https://modrinth.com/modpack/sodium", { client }),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_UNSUPPORTED_PACK");
});

Deno.test("a Modrinth project with no releases at all is rejected actionably", async () => {
  const { client } = clientFor({
    "https://api.modrinth.com/v2/project/empty": () =>
      json({ slug: "empty", title: "Empty", project_type: "modpack" }),
    "https://api.modrinth.com/v2/project/empty/version": () => json([]),
  });
  const err = await assertRejects(
    () => resolvePack("https://modrinth.com/modpack/empty", { client }),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_UNSUPPORTED_PACK");
  assertStringIncludes(String(err.message), "no");
});

Deno.test("a Modrinth 404 is reported as an unresolvable pack", async () => {
  const { client } = clientFor({});
  await assertRejects(
    () => resolvePack("https://modrinth.com/modpack/nope", { client }),
    AppError,
  );
});

const CF_MOD = {
  data: [{
    id: 900001,
    name: "All of Create Aeronautics",
    slug: "all-of-create-aeronautics",
    classId: 4471,
    latestFiles: [],
  }],
};

const CF_FILES = {
  data: [
    {
      id: 6000001,
      displayName: "ACA-1.4.0.zip",
      fileName: "ACA-1.4.0.zip",
      releaseType: 1,
      fileDate: "2026-01-01T00:00:00Z",
      downloadUrl: "https://mediafilez.forgecdn.net/files/600/1/ACA-1.4.0.zip",
      gameVersions: ["1.20.1", "Forge"],
    },
    {
      id: 6000002,
      displayName: "ACA-1.4.2.zip",
      fileName: "ACA-1.4.2.zip",
      releaseType: 1,
      fileDate: "2026-03-01T00:00:00Z",
      downloadUrl: "https://mediafilez.forgecdn.net/files/600/2/ACA-1.4.2.zip",
      gameVersions: ["1.20.1", "Forge"],
    },
    {
      id: 6000003,
      displayName: "ACA-1.5.0-beta.zip",
      fileName: "ACA-1.5.0-beta.zip",
      releaseType: 2,
      fileDate: "2026-04-01T00:00:00Z",
      downloadUrl: "https://mediafilez.forgecdn.net/files/600/3/ACA-1.5.0-beta.zip",
      gameVersions: ["1.20.1", "Forge"],
    },
  ],
};

function cfRoutes(): Record<string, () => Response> {
  return {
    "https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&slug=all-of-create-aeronautics":
      () => json(CF_MOD),
    "https://api.curseforge.com/v1/mods/900001/files?pageSize=50": () => json(CF_FILES),
    "https://api.curseforge.com/v1/mods/900001/files/6000001": () =>
      json({ data: CF_FILES.data[0] }),
  };
}

Deno.test("a CurseForge project url resolves the latest stable file with an api key", async () => {
  const { client, seen } = clientFor(cfRoutes());
  const resolved = await resolvePack(
    "https://www.curseforge.com/minecraft/modpacks/all-of-create-aeronautics",
    { client, curseForgeApiKey: "$2a$10$testkeyvalue" },
  );
  assertEquals(resolved.source, "curseforge");
  assertEquals(resolved.projectName, "All of Create Aeronautics");
  assertEquals(resolved.versionName, "ACA-1.4.2.zip");
  assertEquals(resolved.minecraftVersion, "1.20.1");
  assertEquals(resolved.loader, "Forge");
  assertEquals(resolved.downloadUrl, "https://mediafilez.forgecdn.net/files/600/2/ACA-1.4.2.zip");
  assertEquals(seen.every((s) => s.headers.get("x-api-key") === "$2a$10$testkeyvalue"), true);
});

Deno.test("a CurseForge file url pins that exact file", async () => {
  const { client } = clientFor(cfRoutes());
  const resolved = await resolvePack(
    "https://www.curseforge.com/minecraft/modpacks/all-of-create-aeronautics/files/6000001",
    { client, curseForgeApiKey: "$2a$10$testkeyvalue" },
  );
  assertEquals(resolved.versionName, "ACA-1.4.0.zip");
});

Deno.test("CurseForge without a key gives an actionable error and never leaks the key", async () => {
  const { client } = clientFor({
    "https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&slug=aca": () =>
      new Response("Forbidden: API Key missing or invalid", { status: 403 }),
  });
  const err = await assertRejects(
    () => resolvePack("https://www.curseforge.com/minecraft/modpacks/aca", { client }),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_UNSUPPORTED_PACK");
  const hint = String(err.hint);
  assertStringIncludes(hint, "CURSEFORGE_API_KEY");
  assertStringIncludes(hint, "--archive");
  assertStringIncludes(hint, "forgecdn.net");
});

Deno.test("a CurseForge file with no download url explains the author opt-out", async () => {
  const { client } = clientFor({
    "https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&slug=aca": () =>
      json({ data: [{ id: 1, name: "ACA", slug: "aca", classId: 4471 }] }),
    "https://api.curseforge.com/v1/mods/1/files?pageSize=50": () =>
      json({
        data: [{
          id: 5,
          displayName: "x.zip",
          fileName: "x.zip",
          releaseType: 1,
          fileDate: "2026-01-01T00:00:00Z",
          downloadUrl: null,
          gameVersions: ["1.20.1"],
        }],
      }),
  });
  const err = await assertRejects(
    () =>
      resolvePack("https://www.curseforge.com/minecraft/modpacks/aca", {
        client,
        curseForgeApiKey: "$2a$10$k",
      }),
    AppError,
  ) as AppError;
  assertStringIncludes(String(err.hint).toLowerCase(), "third-party");
});

Deno.test("a CurseForge project that is not a modpack is rejected", async () => {
  const { client } = clientFor({
    "https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&slug=jei": () =>
      json({ data: [] }),
  });
  await assertRejects(
    () =>
      resolvePack("https://www.curseforge.com/minecraft/modpacks/jei", {
        client,
        curseForgeApiKey: "$2a$10$k",
      }),
    AppError,
  );
});

Deno.test("a direct archive url resolves without any api call", async () => {
  const { client, seen } = clientFor({});
  const resolved = await resolvePack("https://example.com/packs/My%20Pack-1.2.3.zip", { client });
  assertEquals(resolved.source, "direct");
  assertEquals(resolved.downloadUrl, "https://example.com/packs/My%20Pack-1.2.3.zip");
  assertEquals(resolved.fileName, "My Pack-1.2.3.zip");
  assertEquals(resolved.versionName, "My Pack-1.2.3");
  assertEquals(seen.length, 0);
});

Deno.test("resolution is describable for the pre-flight banner", async () => {
  const { client } = clientFor(modrinthRoutes());
  const resolved = await resolvePack("https://modrinth.com/modpack/rubius-cobblemon", { client });
  const text = resolved.describe();
  assertStringIncludes(text, "Rubius Cobblemon");
  assertStringIncludes(text, "0.9");
  assertStringIncludes(text, "1.21.1");
  assertStringIncludes(text, "neoforge");
});
