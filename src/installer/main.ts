import { EXIT_CODES } from "../errors.ts";
import { runInstaller } from "./run.ts";

/**
 * Binary entry point.
 *
 * Compiled with --allow-read and --allow-write and nothing else: no network, no
 * subprocesses, no environment. Ctrl+C exits before the next write rather than
 * mid-write, and every individual write is atomic, so an interrupted run leaves
 * either the old file or the new one.
 */
async function main(): Promise<void> {
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    console.error("\n中断しました / interrupted");
    Deno.exit(EXIT_CODES.E_CANCELLED);
  };

  const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    try {
      Deno.addSignalListener(signal, onInterrupt);
    } catch {
      // Not every platform supports every signal.
    }
  }

  try {
    const code = await runInstaller(Deno.args, { isTerminal: Deno.stdin.isTerminal() });
    Deno.exit(interrupted ? EXIT_CODES.E_CANCELLED : code);
  } finally {
    for (const signal of signals) {
      try {
        Deno.removeSignalListener(signal, onInterrupt);
      } catch {
        // Never registered.
      }
    }
  }
}

if (import.meta.main) await main();

export { runInstaller } from "./run.ts";
