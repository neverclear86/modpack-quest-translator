import { EXIT_CODES } from "../errors.ts";
import { run } from "./run.ts";

/**
 * Binary entry point. Ctrl+C flips an AbortSignal rather than killing the
 * process outright, so in-flight subprocesses are terminated, the cache stays
 * consistent (it is flushed after every batch) and no half-written archive can
 * exist (packaging is the last step and is atomic).
 */
async function main(): Promise<void> {
  const controller = new AbortController();
  let interrupted = false;

  const onInterrupt = () => {
    if (interrupted) {
      // A second Ctrl+C means the user wants out now.
      Deno.exit(EXIT_CODES.E_CANCELLED);
    }
    interrupted = true;
    console.error("\ninterrupted: finishing the current batch and exiting cleanly...");
    controller.abort();
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
    const code = await run(Deno.args, { signal: controller.signal });
    Deno.exit(interrupted && code !== 0 ? EXIT_CODES.E_CANCELLED : code);
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

export { run } from "./run.ts";
