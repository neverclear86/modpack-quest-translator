import { assertEquals, assertRejects } from "@std/assert";
import {
  CommandNotFoundError,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  CommandTimeoutError,
  DenoCommandRunner,
} from "../src/util/command.ts";
import { AppError } from "../src/errors.ts";
import { translateUnits } from "../src/translate/orchestrator.ts";
import { TranslationCache } from "../src/translate/cache.ts";
import { ClaudeCodeProvider } from "../src/translate/providers/claude_code.ts";
import type { TranslationUnit } from "../src/quests/adapter.ts";

/**
 * These tests spawn real subprocesses. Scripted seams cannot reproduce the bug
 * they cover: it lives in the ordering of an await against an OS pipe buffer.
 */

/** A child that never reads its stdin and would otherwise outlive the test. */
const SLEEPER = ["eval", "await new Promise((resolve) => setTimeout(resolve, 30000));"];

/** Comfortably more than any platform's pipe buffer, so the write must block. */
const UNREADABLE_STDIN = "x".repeat(4_000_000);

/** Generous enough that a slow machine cannot fail the test for the wrong reason. */
const PROMPT_MS = 20_000;

Deno.test("stdin, stdout and the exit code round-trip through a real child", async () => {
  const result = await new DenoCommandRunner().run(Deno.execPath(), {
    args: [
      "eval",
      "--",
      "const b=[];for await(const c of Deno.stdin.readable)b.push(c);" +
      "await Deno.stdout.write(new Uint8Array(b.flatMap((c)=>[...c])));",
    ],
    stdin: "hello subprocess",
  });
  assertEquals(result.code, 0);
  assertEquals(result.success, true);
  assertEquals(result.stdout, "hello subprocess");
});

Deno.test("a missing binary is reported as CommandNotFoundError", async () => {
  await assertRejects(
    () => new DenoCommandRunner().run("mqt-no-such-binary-4f9a", { args: [] }),
    CommandNotFoundError,
  );
});

Deno.test("the timeout fires while a child refuses to read a large stdin", async () => {
  // The timeout used to be armed only after the stdin write resolved. A child
  // that never drains stdin fills the pipe buffer, the write never resolves,
  // and the run hung forever with no timer running to rescue it.
  const started = Date.now();
  const error = await assertRejects(
    () =>
      new DenoCommandRunner().run(Deno.execPath(), {
        args: SLEEPER,
        stdin: UNREADABLE_STDIN,
        timeoutMs: 1_000,
      }),
    CommandTimeoutError,
  );
  assertEquals(error.timeoutMs, 1_000);
  assertEquals(
    Date.now() - started < PROMPT_MS,
    true,
    "the timeout did not interrupt the blocked stdin write",
  );
});

Deno.test("aborting during a blocked stdin write terminates the child", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    const result = await new DenoCommandRunner().run(Deno.execPath(), {
      args: SLEEPER,
      stdin: UNREADABLE_STDIN,
      signal: controller.signal,
    });
    // The child was signalled, so it cannot have exited successfully.
    assertEquals(result.success, false);
    assertEquals(
      Date.now() - started < PROMPT_MS,
      true,
      "abort did not interrupt the blocked stdin write",
    );
  } finally {
    clearTimeout(timer);
  }
});

Deno.test("a signal already aborted before the call does not start work", async () => {
  const started = Date.now();
  const result = await new DenoCommandRunner().run(Deno.execPath(), {
    args: SLEEPER,
    stdin: UNREADABLE_STDIN,
    signal: AbortSignal.abort(),
  });
  assertEquals(result.success, false);
  assertEquals(Date.now() - started < PROMPT_MS, true, "a pre-aborted signal was ignored");
});

Deno.test("the timeout still applies to a child with no stdin at all", async () => {
  const error = await assertRejects(
    () => new DenoCommandRunner().run(Deno.execPath(), { args: SLEEPER, timeoutMs: 1_000 }),
    CommandTimeoutError,
  );
  assertEquals(error.command, Deno.execPath());
});

Deno.test("a fast child is unaffected by an armed timeout or signal", async () => {
  const controller = new AbortController();
  const result = await new DenoCommandRunner().run(Deno.execPath(), {
    args: ["eval", "console.log('done')"],
    stdin: "ignored",
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  assertEquals(result.success, true);
  assertEquals(result.stdout.trim(), "done");
});

/**
 * Delegates to a real subprocess that ignores stdin, so the provider, the
 * runner and the orchestrator are all exercised against real pipes. Preflight
 * probes carry no stdin and are answered in process; only the translate call
 * needs a real child.
 */
class IgnoresStdinRunner implements CommandRunner {
  readonly #real = new DenoCommandRunner();

  run(_command: string, options: CommandOptions): Promise<CommandResult> {
    if (options.stdin === undefined) {
      return Promise.resolve({ code: 0, success: true, stdout: "", stderr: "" });
    }
    return this.#real.run(Deno.execPath(), { ...options, args: SLEEPER });
  }
}

Deno.test("cancelling a run blocked writing to a subprocess ends as E_CANCELLED", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqt-cancel-" });
  try {
    const cache = await TranslationCache.open(dir, {
      sourceLocale: "en_us",
      targetLocale: "ja_jp",
      provider: "claude-code",
      promptVersion: 1,
      glossaryVersion: "none",
    });
    const unit: TranslationUnit = {
      id: "quest.A.quest_desc",
      key: "quest.A.quest_desc",
      kind: "quest_desc",
      index: -1,
      // Large enough that the request cannot fit in a pipe buffer.
      text: "Assemble the contraption. ".repeat(80_000),
      protectedTokens: [],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    try {
      const error = await assertRejects(
        () =>
          translateUnits([unit], {
            provider: new ClaudeCodeProvider({ runner: new IgnoresStdinRunner() }),
            cache,
            sourceLocale: "en_us",
            targetLocale: "ja_jp",
            glossary: {},
            model: "haiku",
            fallbackModel: "sonnet",
            batchSize: 8,
            batchChars: 10_000_000,
            concurrency: 1,
            retries: 2,
            signal: controller.signal,
            sleep: () => Promise.resolve(),
          }),
        AppError,
      );
      assertEquals(error.code, "E_CANCELLED");
      assertEquals(
        Date.now() - started < PROMPT_MS,
        true,
        "cancellation did not take effect promptly",
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
