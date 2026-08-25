import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { BoundedHttpClient, type FetchLike } from "../src/net/http.ts";

function respond(body: string | Uint8Array, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

/** Router keyed by exact URL. */
function router(routes: Record<string, () => Response>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const route = routes[url];
    if (!route) return Promise.resolve(new Response("not found", { status: 404 }));
    void init;
    return Promise.resolve(route());
  };
  return { fetch, calls };
}

Deno.test("getJson parses a JSON body", async () => {
  const { fetch } = router({
    "https://api.example.com/v1/thing": () =>
      respond(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }),
  });
  const client = new BoundedHttpClient({ fetch });
  assertEquals(await client.getJson("https://api.example.com/v1/thing"), { ok: true });
});

Deno.test("a User-Agent is always sent and headers are merged", async () => {
  let seen: Headers | undefined;
  const fetch: FetchLike = (_i, init) => {
    seen = new Headers(init?.headers);
    return Promise.resolve(respond("{}"));
  };
  const client = new BoundedHttpClient({ fetch, userAgent: "mqt/9.9.9" });
  await client.getJson("https://api.example.com/x", { headers: { "x-api-key": "K" } });
  assertEquals(seen?.get("user-agent"), "mqt/9.9.9");
  assertEquals(seen?.get("x-api-key"), "K");
});

Deno.test("non-2xx responses raise E_DOWNLOAD with the status", async () => {
  const { fetch } = router({
    "https://api.example.com/gone": () => respond("nope", { status: 503 }),
  });
  const client = new BoundedHttpClient({ fetch });
  const err = await assertRejects(
    () => client.getJson("https://api.example.com/gone"),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_DOWNLOAD");
  assertStringIncludes(err.message, "503");
});

Deno.test("401/403 are distinguishable so resolvers can suggest an API key", async () => {
  const { fetch } = router({
    "https://api.curseforge.com/v1/x": () => respond("Forbidden", { status: 403 }),
  });
  const client = new BoundedHttpClient({ fetch });
  const err = await assertRejects(
    () => client.getJson("https://api.curseforge.com/v1/x"),
    AppError,
  ) as AppError;
  assertEquals(err.details?.status, 403);
});

Deno.test("redirects are followed, revalidated and bounded", async () => {
  const routes: Record<string, () => Response> = {};
  for (let i = 0; i < 10; i++) {
    routes[`https://example.com/r${i}`] = () =>
      respond("", { status: 302, headers: { location: `https://example.com/r${i + 1}` } });
  }
  routes["https://example.com/r3"] = () => respond("done");
  const { fetch } = router(routes);
  const client = new BoundedHttpClient({ fetch, maxRedirects: 5 });
  assertEquals(new TextDecoder().decode(await client.getBytes("https://example.com/r0")), "done");

  const { fetch: loopFetch } = router({});
  const looping: FetchLike = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    void loopFetch;
    const n = Number(url.slice(-1)) || 0;
    return Promise.resolve(
      respond("", { status: 302, headers: { location: `https://example.com/x${n + 1}` } }),
    );
  };
  const bounded = new BoundedHttpClient({ fetch: looping, maxRedirects: 3 });
  const err = await assertRejects(
    () => bounded.getBytes("https://example.com/x0"),
    AppError,
  ) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "redirect");
});

Deno.test("a redirect to a non-http scheme is refused", async () => {
  const { fetch } = router({
    "https://example.com/start": () =>
      respond("", { status: 302, headers: { location: "file:///etc/passwd" } }),
  });
  const client = new BoundedHttpClient({ fetch });
  const err = await assertRejects(
    () => client.getBytes("https://example.com/start"),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_DOWNLOAD");
  assertStringIncludes(err.message, "scheme");
});

Deno.test("an https to http downgrade redirect is refused", async () => {
  const { fetch } = router({
    "https://example.com/start": () =>
      respond("", { status: 301, headers: { location: "http://example.com/pack.zip" } }),
  });
  const client = new BoundedHttpClient({ fetch });
  const err = await assertRejects(
    () => client.getBytes("https://example.com/start"),
    AppError,
  ) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "downgrade");
});

Deno.test("a declared Content-Length over the cap is refused before download", async () => {
  const { fetch } = router({
    "https://example.com/huge.zip": () =>
      respond("x", { headers: { "content-length": String(50 * 1024 * 1024) } }),
  });
  const client = new BoundedHttpClient({ fetch, maxBytes: 1024 });
  const err = await assertRejects(
    () => client.getBytes("https://example.com/huge.zip"),
    AppError,
  ) as AppError;
  assertStringIncludes(err.message, "too large");
});

Deno.test("a lying Content-Length cannot smuggle an oversized body past the cap", async () => {
  const big = new Uint8Array(4096);
  const { fetch } = router({
    "https://example.com/liar.zip": () => respond(big, { headers: { "content-length": "10" } }),
  });
  const client = new BoundedHttpClient({ fetch, maxBytes: 1024 });
  const err = await assertRejects(
    () => client.getBytes("https://example.com/liar.zip"),
    AppError,
  ) as AppError;
  assertStringIncludes(err.message, "too large");
});

Deno.test("progress is reported while streaming", async () => {
  const body = new Uint8Array(3000);
  const { fetch } = router({ "https://example.com/p.zip": () => respond(body) });
  const client = new BoundedHttpClient({ fetch });
  let last = 0;
  const bytes = await client.getBytes("https://example.com/p.zip", {
    onProgress: (received) => {
      last = received;
    },
  });
  assertEquals(bytes.length, 3000);
  assertEquals(last, 3000);
});

Deno.test("non-http request urls are refused without calling fetch", async () => {
  let called = false;
  const fetch: FetchLike = () => {
    called = true;
    return Promise.resolve(respond("{}"));
  };
  const client = new BoundedHttpClient({ fetch });
  await assertRejects(() => client.getBytes("file:///etc/passwd"), AppError);
  assertEquals(called, false);
});

Deno.test("an abort signal cancels the request", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch: FetchLike = () => Promise.resolve(respond("{}"));
  const client = new BoundedHttpClient({ fetch });
  await assertRejects(
    () => client.getBytes("https://example.com/x.zip", { signal: controller.signal }),
    AppError,
  );
});

Deno.test("malformed JSON bodies raise E_DOWNLOAD rather than a raw SyntaxError", async () => {
  const { fetch } = router({ "https://api.example.com/bad": () => respond("<html>nope") });
  const client = new BoundedHttpClient({ fetch });
  const err = await assertRejects(
    () => client.getJson("https://api.example.com/bad"),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_DOWNLOAD");
});
