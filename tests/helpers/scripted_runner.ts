import {
  CommandNotFoundError,
  CommandTimeoutError,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "../../src/util/command.ts";

export interface RecordedCall {
  command: string;
  args: string[];
  stdin?: string;
}

interface Script {
  match: string[];
  code?: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
}

/** Scripts subprocess behaviour so no test ever spawns a real process. */
export class ScriptedRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  killed = false;
  #scripts: Script[] = [];
  #missing = false;

  on(match: string[], result: Omit<Script, "match">): this {
    this.#scripts.push({ match, ...result });
    return this;
  }

  onMissing(): this {
    this.#missing = true;
    return this;
  }

  run(command: string, options: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args: [...options.args], stdin: options.stdin });
    if (this.#missing) return Promise.reject(new CommandNotFoundError(command));

    const script = this.#scripts.find((s) => s.match.every((m) => options.args.includes(m)));
    if (!script) {
      return Promise.resolve({ code: 127, success: false, stdout: "", stderr: "no script" });
    }
    if (script.hang) {
      this.killed = true;
      return Promise.reject(new CommandTimeoutError(command, options.timeoutMs ?? 0));
    }
    const code = script.code ?? 0;
    return Promise.resolve({
      code,
      success: code === 0,
      stdout: script.stdout ?? "",
      stderr: script.stderr ?? "",
    });
  }
}
