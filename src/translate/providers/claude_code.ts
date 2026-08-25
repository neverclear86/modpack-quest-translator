import {
  CommandNotFoundError,
  type CommandRunner,
  CommandTimeoutError,
  DenoCommandRunner,
} from "../../util/command.ts";
import {
  type BatchRequest,
  type BatchResponse,
  FatalProviderError,
  type PreflightReport,
  TransientProviderError,
  type TranslateOptions,
  type TranslationProvider,
} from "../types.ts";
import { buildUserPrompt, RESULT_SCHEMA, TRANSLATION_SYSTEM_PROMPT } from "./prompt.ts";

export interface ClaudeCodeProviderOptions {
  runner?: CommandRunner;
  /** Binary to spawn. Always an argv array, never a shell string. */
  binary?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  maxTurns?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TURNS = 2;

/** Substrings that mean "try again later" rather than "this will never work". */
const TRANSIENT_MARKERS = [
  "rate limit",
  "rate_limit",
  "overloaded",
  "529",
  "503",
  "502",
  "500 internal",
  "timed out",
  "timeout",
  "econnreset",
  "connection reset",
  "socket hang up",
  "network",
  "temporarily unavailable",
  "try again",
];

/** Substrings that mean retrying is pointless. */
const FATAL_MARKERS = [
  "invalid api key",
  "not logged in",
  "please run /login",
  "unauthorized",
  "authentication",
  "unknown model",
  "invalid model",
  "invalid schema",
  "json schema",
  "credit balance",
  "budget",
];

interface ClaudeResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
}

/**
 * v1 default provider. Drives an already-installed, already-authenticated
 * Claude Code CLI through a subprocess; never calls Anthropic HTTP APIs.
 * See DESIGN.md §6.6.
 */
export class ClaudeCodeProvider implements TranslationProvider {
  readonly id = "claude-code";
  readonly #runner: CommandRunner;
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #maxBudgetUsd?: number;
  readonly #maxTurns: number;
  #supportsMaxTurns?: boolean;

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.#runner = options.runner ?? new DenoCommandRunner();
    this.#binary = options.binary ?? "claude";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBudgetUsd = options.maxBudgetUsd;
    this.#maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  }

  async preflight(): Promise<PreflightReport> {
    let version: string;
    try {
      const result = await this.#runner.run(this.#binary, {
        args: ["--version"],
        timeoutMs: 30_000,
      });
      if (!result.success) {
        return {
          ok: false,
          problem: `\`${this.#binary} --version\` exited with code ${result.code}`,
          hint: "Check that Claude Code is installed and on PATH.",
        };
      }
      version = result.stdout.trim();
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        return {
          ok: false,
          problem: `Could not find the \`${this.#binary}\` command`,
          hint: "Install Claude Code and make sure it is on PATH: " +
            "https://claude.com/claude-code. This tool never runs `claude update`.",
        };
      }
      return { ok: false, problem: describe(error), hint: "Could not run the Claude Code CLI." };
    }

    let auth: string;
    try {
      const result = await this.#runner.run(this.#binary, {
        args: ["auth", "status", "--json"],
        timeoutMs: 30_000,
      });
      // Only three fields are read. The CLI also returns an email and an org id;
      // both are dropped here and never reach a log, cache or output file.
      const parsed = JSON.parse(result.stdout) as {
        loggedIn?: boolean;
        authMethod?: string;
        subscriptionType?: string;
      };
      if (parsed.loggedIn !== true) {
        return {
          ok: false,
          version,
          problem: "Claude Code is not logged in",
          hint: "Run `claude auth login` and try again.",
        };
      }
      auth = [parsed.authMethod, parsed.subscriptionType].filter(Boolean).join(", ") || "logged in";
    } catch (error) {
      return {
        ok: false,
        version,
        problem: `Could not read Claude Code authentication status: ${describe(error)}`,
        hint: "Run `claude auth status` to check, then `claude auth login` if needed.",
      };
    }

    return { ok: true, version, auth };
  }

  async translateBatch(
    request: BatchRequest,
    options: TranslateOptions,
  ): Promise<BatchResponse> {
    const args = await this.#buildArgs(options);
    const stdin = buildUserPrompt(JSON.stringify(request), options.repairNote);

    let result;
    try {
      result = await this.#runner.run(this.#binary, {
        args,
        stdin,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.#timeoutMs,
      });
    } catch (error) {
      if (error instanceof CommandTimeoutError) {
        throw new TransientProviderError(
          `Claude Code did not respond within ${error.timeoutMs}ms`,
          { cause: error },
        );
      }
      if (error instanceof CommandNotFoundError) {
        throw new FatalProviderError(`Could not find the \`${this.#binary}\` command`, {
          cause: error,
          hint: "Install Claude Code and make sure it is on PATH.",
        });
      }
      throw new TransientProviderError(`Claude Code could not be run: ${describe(error)}`, {
        cause: error,
      });
    }

    let parsed: ClaudeResult;
    try {
      parsed = JSON.parse(result.stdout) as ClaudeResult;
    } catch {
      const detail = (result.stderr || result.stdout || "").trim().slice(0, 400);
      throw classify(
        `Claude Code returned output that was not JSON (exit ${result.code})` +
          (detail ? `: ${detail}` : ""),
      );
    }

    if (parsed.is_error === true || (parsed.subtype && parsed.subtype !== "success")) {
      throw classify(parsed.result ?? `Claude Code reported ${parsed.subtype ?? "an error"}`);
    }

    const items = extractItems(parsed);
    if (!items) {
      throw new TransientProviderError(
        "Claude Code returned no schema-validated structured result",
      );
    }

    return {
      items,
      model: options.model,
      usage: parsed.usage
        ? {
          inputTokens: parsed.usage.input_tokens,
          outputTokens: parsed.usage.output_tokens,
          cacheReadInputTokens: parsed.usage.cache_read_input_tokens,
          cacheCreationInputTokens: parsed.usage.cache_creation_input_tokens,
        }
        : undefined,
      costUsd: parsed.total_cost_usd,
    };
  }

  async #buildArgs(options: TranslateOptions): Promise<string[]> {
    const args: string[] = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(RESULT_SCHEMA),
      "--model",
      options.model,
    ];
    if (options.effort) args.push("--effort", options.effort);
    // --tools is variadic, so it must be followed by another flag: keeping it
    // mid-list guarantees commander stops consuming after the empty value.
    args.push("--tools", "");
    args.push("--no-session-persistence");
    args.push("--disable-slash-commands");
    if (await this.#hasMaxTurns()) args.push("--max-turns", String(this.#maxTurns));
    if (this.#maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(this.#maxBudgetUsd));
    }
    args.push("--system-prompt", TRANSLATION_SYSTEM_PROMPT);
    return args;
  }

  /**
   * `--max-turns` is absent from some CLI versions (2.1.241 does not have it),
   * so it is only passed when advertised. With `--tools ""` a single turn is
   * structurally guaranteed either way.
   */
  async #hasMaxTurns(): Promise<boolean> {
    if (this.#supportsMaxTurns !== undefined) return this.#supportsMaxTurns;
    try {
      const result = await this.#runner.run(this.#binary, {
        args: ["--help"],
        timeoutMs: 30_000,
      });
      this.#supportsMaxTurns = result.stdout.includes("--max-turns");
    } catch {
      this.#supportsMaxTurns = false;
    }
    return this.#supportsMaxTurns;
  }
}

function extractItems(parsed: ClaudeResult): { id: string; text: string }[] | undefined {
  const fromStructured = asItems(parsed.structured_output);
  if (fromStructured) return fromStructured;
  if (typeof parsed.result === "string") {
    try {
      return asItems(JSON.parse(parsed.result));
    } catch {
      // Prose, not JSON. Never scraped.
      return undefined;
    }
  }
  return undefined;
}

function asItems(value: unknown): { id: string; text: string }[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  const out: { id: string; text: string }[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return undefined;
    const { id, text } = item as { id?: unknown; text?: unknown };
    if (typeof id !== "string" || typeof text !== "string") return undefined;
    out.push({ id, text });
  }
  return out;
}

function classify(message: string): Error {
  const lower = message.toLowerCase();
  if (FATAL_MARKERS.some((marker) => lower.includes(marker))) {
    return new FatalProviderError(message, {
      hint: "Check `claude auth status`, the requested --model, and your plan limits.",
    });
  }
  if (TRANSIENT_MARKERS.some((marker) => lower.includes(marker))) {
    return new TransientProviderError(message);
  }
  // Unknown failures are retried: a bounded retry is cheaper than a false stop.
  return new TransientProviderError(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
