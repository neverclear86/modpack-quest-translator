/**
 * `Deno.Command`-shaped seam so tests can script subprocess behaviour without
 * spawning anything. Arguments are always an array: no shell, ever.
 */
export interface CommandResult {
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  args: string[];
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CommandRunner {
  run(command: string, options: CommandOptions): Promise<CommandResult>;
}

export class CommandNotFoundError extends Error {
  constructor(readonly command: string, options?: { cause?: unknown }) {
    super(`Command not found: ${command}`, options);
    this.name = "CommandNotFoundError";
  }
}

export class CommandTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`Command ${command} timed out after ${timeoutMs}ms`);
    this.name = "CommandTimeoutError";
  }
}

/** The real runner. Spawns directly via Deno.Command; never through a shell. */
export class DenoCommandRunner implements CommandRunner {
  async run(command: string, options: CommandOptions): Promise<CommandResult> {
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(command, {
        args: options.args,
        stdin: options.stdin === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) throw new CommandNotFoundError(command, { cause });
      throw cause;
    }

    if (options.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(options.stdin));
      } finally {
        await writer.close().catch(() => {});
        writer.releaseLock();
      }
    }

    let timer: number | undefined;
    let timedOut = false;
    const kill = (signal: Deno.Signal) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    };

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        // Escalate if the child ignores SIGTERM.
        setTimeout(() => kill("SIGKILL"), 2000);
      }, options.timeoutMs);
    }

    const onAbort = () => kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const output = await child.output();
      if (timedOut) throw new CommandTimeoutError(command, options.timeoutMs!);
      const decoder = new TextDecoder();
      return {
        code: output.code,
        success: output.success,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
