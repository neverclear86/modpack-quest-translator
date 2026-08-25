import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ClaudeCodeProvider } from "../src/translate/providers/claude_code.ts";
import { FatalProviderError, TransientProviderError } from "../src/translate/types.ts";
import type { BatchRequest } from "../src/translate/types.ts";
import { ScriptedRunner } from "./helpers/scripted_runner.ts";

const REQUEST: BatchRequest = {
  sourceLocale: "en_us",
  targetLocale: "ja_jp",
  context: { pack: "All of Create Aeronautics", chapter: "aeronautics" },
  glossary: { Create: "Create" },
  items: [
    { id: "quest.A.title", kind: "title", text: "Cogwheel", protectedTokens: [] },
    {
      id: "quest.B.quest_desc#0",
      kind: "quest_desc",
      text: "&6Go&r",
      protectedTokens: ["&6", "&r"],
    },
  ],
};

function resultJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"items":[{"id":"quest.A.title","text":"歯車"}]}',
    structured_output: {
      items: [
        { id: "quest.A.title", text: "歯車" },
        { id: "quest.B.quest_desc#0", text: "&6行け&r" },
      ],
    },
    usage: { input_tokens: 1054, output_tokens: 378, cache_read_input_tokens: 0 },
    total_cost_usd: 0.0039,
    session_id: "0625dc5b-1f54-403f-9bbb-3b8b29492dfc",
    ...extra,
  });
}

const HELP_WITHOUT_MAX_TURNS =
  "Usage: claude [options]\n  --tools <tools...>\n  --json-schema <schema>\n";
const HELP_WITH_MAX_TURNS = HELP_WITHOUT_MAX_TURNS + "  --max-turns <n>  Bound the turns\n";

Deno.test("a batch is translated through a schema-validated structured result", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  const provider = new ClaudeCodeProvider({ runner });
  const response = await provider.translateBatch(REQUEST, { model: "haiku", effort: "low" });
  assertEquals(response.items, [
    { id: "quest.A.title", text: "歯車" },
    { id: "quest.B.quest_desc#0", text: "&6行け&r" },
  ]);
  assertEquals(response.model, "haiku");
  assertEquals(response.costUsd, 0.0039);
  assertEquals(response.usage?.inputTokens, 1054);
});

Deno.test("the subprocess is spawned without a shell and never interpolates pack text", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  const provider = new ClaudeCodeProvider({ runner });
  const evil: BatchRequest = {
    ...REQUEST,
    items: [{
      id: "quest.A.title",
      kind: "title",
      text: '"; rm -rf / #$(whoami)`id`',
      protectedTokens: [],
    }],
  };
  await provider.translateBatch(evil, { model: "haiku" }).catch(() => {});

  const call = runner.calls.find((c) => c.args.includes("-p"))!;
  assertEquals(call.command, "claude");
  // Not a shell, and no argument carries the pack text.
  assertEquals(["sh", "bash", "cmd", "cmd.exe", "/bin/sh"].includes(call.command), false);
  for (const arg of call.args) {
    assertEquals(arg.includes("rm -rf"), false, `pack text leaked into argv: ${arg}`);
  }
  // The text arrives on stdin instead.
  assertStringIncludes(call.stdin ?? "", "rm -rf");
});

Deno.test("the mandated safety flags are always passed", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  await new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, {
    model: "haiku",
    effort: "low",
  });
  const args = runner.calls.find((c) => c.args.includes("-p"))!.args;

  assertEquals(args.includes("-p"), true);
  assertEquals(args[args.indexOf("--output-format") + 1], "json");
  assertEquals(args.includes("--json-schema"), true);
  assertEquals(args.includes("--no-session-persistence"), true);
  assertEquals(args.includes("--disable-slash-commands"), true);
  assertEquals(args[args.indexOf("--tools") + 1], "", "tools must be disabled with an empty value");
  assertEquals(args[args.indexOf("--model") + 1], "haiku");
  assertEquals(args[args.indexOf("--effort") + 1], "low");
  assertEquals(args.includes("--system-prompt"), true);
  // --tools is variadic, so it must never be the last argument.
  assertEquals(args[args.indexOf("--tools") + 2]?.startsWith("--"), true);
});

Deno.test("the json schema forbids extra properties and requires id and text", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  await new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, { model: "haiku" });
  const args = runner.calls.find((c) => c.args.includes("-p"))!.args;
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  assertEquals(schema.additionalProperties, false);
  assertEquals(schema.required, ["items"]);
  assertEquals(schema.properties.items.items.required, ["id", "text"]);
  assertEquals(schema.properties.items.items.additionalProperties, false);
});

Deno.test("--max-turns is passed only when the installed CLI advertises it", async () => {
  const without = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  await new ClaudeCodeProvider({ runner: without }).translateBatch(REQUEST, { model: "haiku" });
  assertEquals(
    without.calls.find((c) => c.args.includes("-p"))!.args.includes("--max-turns"),
    false,
  );

  const with_ = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITH_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  await new ClaudeCodeProvider({ runner: with_ }).translateBatch(REQUEST, { model: "haiku" });
  const args = with_.calls.find((c) => c.args.includes("-p"))!.args;
  assertEquals(args[args.indexOf("--max-turns") + 1], "2");
});

Deno.test("the request sent on stdin has the shape the requirements specify", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  await new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, { model: "haiku" });
  const payload = JSON.parse(runner.calls.find((c) => c.args.includes("-p"))!.stdin!);
  assertEquals(payload.sourceLocale, "en_us");
  assertEquals(payload.targetLocale, "ja_jp");
  assertEquals(payload.context.pack, "All of Create Aeronautics");
  assertEquals(payload.context.chapter, "aeronautics");
  assertEquals(payload.glossary, { Create: "Create" });
  assertEquals(payload.items[1].protectedTokens, ["&6", "&r"]);
});

Deno.test("structured_output is preferred but a JSON result string also works", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], {
      stdout: JSON.stringify({
        subtype: "success",
        is_error: false,
        result: '{"items":[{"id":"quest.A.title","text":"歯車"}]}',
      }),
    });
  const response = await new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, {
    model: "haiku",
  });
  assertEquals(response.items, [{ id: "quest.A.title", text: "歯車" }]);
});

Deno.test("prose is never scraped: a response with neither field fails", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], {
      stdout: JSON.stringify({
        subtype: "success",
        is_error: false,
        result: "Sure! Here are the translations: 歯車 and 行け.",
      }),
    });
  await assertRejects(
    () => new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, { model: "haiku" }),
    TransientProviderError,
  );
});

Deno.test("a non-JSON stdout is a transient failure, not a crash", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: "<html>gateway timeout</html>" });
  await assertRejects(
    () => new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, { model: "haiku" }),
    TransientProviderError,
  );
});

Deno.test("rate limits and overload are classified as transient", async () => {
  for (
    const message of [
      "Error: rate limit exceeded",
      "API Error: 529 overloaded_error",
      "Error: 500 Internal Server Error",
      "request timed out",
    ]
  ) {
    const runner = new ScriptedRunner()
      .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
      .on(["-p"], {
        stdout: JSON.stringify({ is_error: true, subtype: "error", result: message }),
      });
    await assertRejects(
      () => new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, { model: "haiku" }),
      TransientProviderError,
      undefined,
      message,
    );
  }
});

Deno.test("being logged out or asking for an unknown model is fatal, not retried", async () => {
  for (const message of ["Invalid API key. Please run /login", "Unknown model: haiku-9"]) {
    const runner = new ScriptedRunner()
      .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
      .on(["-p"], {
        stdout: JSON.stringify({ is_error: true, subtype: "error", result: message }),
      });
    await assertRejects(
      () => new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, { model: "haiku" }),
      FatalProviderError,
    );
  }
});

Deno.test("a non-zero exit with no parseable output is transient", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { code: 1, stderr: "connection reset by peer" });
  await assertRejects(
    () => new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, { model: "haiku" }),
    TransientProviderError,
  );
});

Deno.test("preflight reports the version and a safe auth summary", async () => {
  const runner = new ScriptedRunner()
    .on(["--version"], { stdout: "2.1.241 (Claude Code)\n" })
    .on(["auth", "status"], {
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "max",
        email: "person.name@example.com",
        orgId: "88fceb4c-91cf-43e2-832d-f7e0a55b0d5c",
      }),
    });
  const report = await new ClaudeCodeProvider({ runner }).preflight();
  assertEquals(report.ok, true);
  assertStringIncludes(report.version!, "2.1.241");
  assertStringIncludes(report.auth!, "claude.ai");
  // The email and org id the CLI returns must never be surfaced.
  const all = JSON.stringify(report);
  assertEquals(all.includes("person.name@example.com"), false);
  assertEquals(all.includes("88fceb4c"), false);
});

Deno.test("preflight fails actionably when claude is missing", async () => {
  const runner = new ScriptedRunner().onMissing();
  const report = await new ClaudeCodeProvider({ runner }).preflight();
  assertEquals(report.ok, false);
  assertStringIncludes(String(report.hint).toLowerCase(), "install");
});

Deno.test("preflight fails actionably when logged out", async () => {
  const runner = new ScriptedRunner()
    .on(["--version"], { stdout: "2.1.241 (Claude Code)\n" })
    .on(["auth", "status"], { stdout: JSON.stringify({ loggedIn: false }) });
  const report = await new ClaudeCodeProvider({ runner }).preflight();
  assertEquals(report.ok, false);
  assertStringIncludes(String(report.hint), "claude auth login");
});

Deno.test("preflight never runs claude update", async () => {
  const runner = new ScriptedRunner()
    .on(["--version"], { stdout: "2.1.241\n" })
    .on(["auth", "status"], {
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    });
  await new ClaudeCodeProvider({ runner }).preflight();
  assertEquals(runner.calls.some((c) => c.args.includes("update")), false);
});

Deno.test("a timeout kills the child and is reported as transient", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { hang: true });
  const provider = new ClaudeCodeProvider({ runner });
  await assertRejects(
    () => provider.translateBatch(REQUEST, { model: "haiku", timeoutMs: 20 }),
    TransientProviderError,
  );
  assertEquals(runner.killed, true);
});

Deno.test("a repair note is appended to the prompt when retrying a bad batch", async () => {
  const runner = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  await new ClaudeCodeProvider({ runner }).translateBatch(REQUEST, {
    model: "haiku",
    repairNote: "Formatting codes changed: &6 was dropped",
  });
  const stdin = runner.calls.find((c) => c.args.includes("-p"))!.stdin!;
  assertStringIncludes(stdin, "&6 was dropped");
});

Deno.test("--max-budget-usd is passed only when a cost cap is configured", async () => {
  const plain = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  await new ClaudeCodeProvider({ runner: plain }).translateBatch(REQUEST, { model: "haiku" });
  assertEquals(
    plain.calls.find((c) => c.args.includes("-p"))!.args.includes("--max-budget-usd"),
    false,
  );

  const capped = new ScriptedRunner()
    .on(["--help"], { stdout: HELP_WITHOUT_MAX_TURNS })
    .on(["-p"], { stdout: resultJson() });
  await new ClaudeCodeProvider({ runner: capped, maxBudgetUsd: 5 })
    .translateBatch(REQUEST, { model: "haiku" });
  const args = capped.calls.find((c) => c.args.includes("-p"))!.args;
  assertEquals(args[args.indexOf("--max-budget-usd") + 1], "5");
});
