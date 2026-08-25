import { assertEquals, assertStringIncludes } from "@std/assert";
import { REDACTION, Redactor } from "../src/util/redact.ts";

Deno.test("registered secrets are removed by exact substring match", () => {
  const r = new Redactor();
  r.register("$2a$supersecretkey");
  const out = r.text("failed with key $2a$supersecretkey trailing");
  assertEquals(out.includes("supersecretkey"), false);
  assertStringIncludes(out, REDACTION);
  assertStringIncludes(out, "trailing");
});

Deno.test("empty and very short secrets are never registered", () => {
  const r = new Redactor();
  r.register("");
  r.register("ab");
  r.register(undefined);
  assertEquals(r.text("ab cd"), "ab cd");
});

Deno.test("anthropic and generic api keys are redacted by pattern", () => {
  const r = new Redactor();
  const out = r.text("token sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH0011 done");
  assertEquals(out.includes("sk-ant-api03"), false);
  assertStringIncludes(out, "done");
});

Deno.test("bearer headers and credential query parameters are redacted", () => {
  const r = new Redactor();
  assertEquals(r.text("Authorization: Bearer abcdef123456ghijkl").includes("abcdef123456"), false);
  const url = r.text("https://api.example.com/v1/x?api_key=ZZZZ9999YYYY&page=2");
  assertEquals(url.includes("ZZZZ9999YYYY"), false);
  assertStringIncludes(url, "page=2");
});

Deno.test("email addresses are redacted", () => {
  const r = new Redactor();
  const out = r.text("logged in as person.name@example.com now");
  assertEquals(out.includes("person.name@example.com"), false);
  assertStringIncludes(out, "now");
});

Deno.test("value() walks nested structures and leaves other data intact", () => {
  const r = new Redactor();
  r.register("$2a$topsecretvalue");
  const out = r.value({
    a: ["x", "key=$2a$topsecretvalue"],
    b: { c: "$2a$topsecretvalue" },
    n: 42,
    t: true,
    z: null,
  }) as Record<string, unknown>;
  assertEquals(JSON.stringify(out).includes("topsecretvalue"), false);
  assertEquals(out.n, 42);
  assertEquals(out.t, true);
  assertEquals(out.z, null);
});

Deno.test("redactor collects secrets from the environment snapshot", () => {
  const r = Redactor.fromEnv({
    CURSEFORGE_API_KEY: "$2a$10$curseforgekeyvalue",
    ANTHROPIC_API_KEY: "sk-ant-zzz-real-value-here",
    UNRELATED: "keepme",
  });
  const out = r.text("a $2a$10$curseforgekeyvalue b sk-ant-zzz-real-value-here c keepme");
  assertEquals(out.includes("curseforgekeyvalue"), false);
  assertEquals(out.includes("sk-ant-zzz-real-value-here"), false);
  assertStringIncludes(out, "keepme");
});
