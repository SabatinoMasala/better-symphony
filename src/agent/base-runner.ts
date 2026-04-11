/**
 * Base Agent Runner
 * Shared infrastructure for spawning agent CLI processes with stream-json/jsonl output.
 * Handles yolobox wrapping, env vars, abort/timeout/stall detection, transcript writing,
 * and event emission. Subclasses provide buildArgs() and handleStreamMessage().
 */

import { readFileSync, appendFileSync, writeFileSync } from "fs";
import type {
  ServiceConfig,
  Issue,
  AgentEvent,
  AgentEventType,
  LiveSession,
} from "../config/types.js";
import { AgentError } from "../config/types.js";
import { logger } from "../logging/logger.js";
import { createSession, updateSessionEvent } from "./session.js";

// ── Shared Utilities ────────────────────────────────────────────

const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\u001B\].*?\u0007)/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(/\r/g, "");
}

const YOLOBOX_BANNER_RE = /[ \t]*[█╗╔╚╝═║░▒▓]+[█╗╔╚╝═║░▒▓ \t]*\n?/g;
function filterYoloboxBanner(stderr: string): string {
  const filtered = stderr.replace(YOLOBOX_BANNER_RE, "").trim();
  if (filtered.length < stderr.trim().length) {
    return filtered ? `[yolobox] ${filtered}` : "[yolobox]";
  }
  return stderr;
}

// ── Cached System Prompts ───────────────────────────────────────

const LINEAR_SYSTEM_PROMPT_PATH = new URL("../prompts/linear-system-prompt.md", import.meta.url).pathname;
let _linearSystemPrompt: string | null = null;
export function getLinearSystemPrompt(): string {
  if (_linearSystemPrompt === null) {
    _linearSystemPrompt = readFileSync(LINEAR_SYSTEM_PROMPT_PATH, "utf-8");
  }
  return _linearSystemPrompt;
}

const GITHUB_SYSTEM_PROMPT_PATH = new URL("../prompts/github-system-prompt.md", import.meta.url).pathname;
let _githubSystemPrompt: string | null = null;
export function getGitHubSystemPrompt(): string {
  if (_githubSystemPrompt === null) {
    _githubSystemPrompt = readFileSync(GITHUB_SYSTEM_PROMPT_PATH, "utf-8");
  }
  return _githubSystemPrompt;
}

/** Safely extract text from an array of content blocks (handles nested/object values) */
export function extractBlockText(blocks: any[]): string {
  return blocks
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (typeof b?.text === "string") return b.text;
      if (typeof b?.content === "string") return b.content;
      if (Array.isArray(b?.content)) return extractBlockText(b.content);
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

// ── Runner Options & Base Class ─────────────────────────────────

export type AgentEventCallback = (event: AgentEvent) => void;

export interface RunnerOptions {
  config: ServiceConfig;
  issue: Issue;
  workspacePath: string;
  prompt: string;
  attempt: number | null;
  onEvent: AgentEventCallback;
  abortSignal: AbortSignal;
  transcriptPath?: string;
}

export abstract class BaseRunner {
  protected options: RunnerOptions;
  protected proc: ReturnType<typeof Bun.spawn> | null = null;
  protected session: LiveSession | null = null;
  protected lastAssistantMessage: string | null = null;

  /** Display name for log messages (e.g. "Claude", "Codex") */
  protected abstract readonly runnerName: string;

  private transcriptInitialized = false;

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  private initTranscript(): void {
    if (this.transcriptInitialized || !this.options.transcriptPath) return;
    this.transcriptInitialized = true;
    const header = `# Agent Transcript (${this.runnerName}): ${this.options.issue.identifier}\nStarted: ${new Date().toISOString()}\n`;
    writeFileSync(this.options.transcriptPath, header, "utf-8");
  }

  // ── Abstract Methods ────────────────────────────────────────

  /** Build CLI arguments for this runner (without binary name or yolobox wrapping). */
  protected abstract buildArgs(prompt: string): string[];

  /** Handle a single parsed JSON message from stdout. */
  protected abstract handleStreamMessage(message: any): void;

  // ── Public API ──────────────────────────────────────────────

  getSession(): LiveSession | null {
    return this.session;
  }

  async run(): Promise<void> {
    this.initTranscript();
    const { issue, prompt } = this.options;

    const sessionId = `${this.runnerName.toLowerCase()}-${Date.now()}`;
    this.session = createSession(sessionId, "turn-1", null);

    this.emitEvent("session_started", {
      session_id: sessionId,
      issue_identifier: issue.identifier,
    });

    try {
      await this.launch(prompt);
    } finally {
      this.cleanup();
    }
  }

  terminate(): void {
    try {
      this.proc?.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        this.proc?.kill("SIGKILL");
      } catch {}
    }, 5000);
  }

  // ── Process Lifecycle ───────────────────────────────────────

  private async launch(prompt: string): Promise<void> {
    const { config, workspacePath, issue } = this.options;
    const agentArgs = this.buildArgs(prompt);

    // Build spawn command: optionally wrapped in yolobox
    const spawnArgs = this.buildSpawnArgs(agentArgs);

    logger.info(`Launching ${this.runnerName}`, {
      issue_identifier: issue.identifier,
      cwd: workspacePath,
      binary: config.agent.binary,
      yolobox: config.agent.yolobox,
    });

    this.proc = Bun.spawn(spawnArgs, {
      cwd: workspacePath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: this.buildEnv(),
    });

    if (this.session) {
      this.session.process_pid = this.proc.pid?.toString() ?? null;
    }

    const killProc = () => {
      try { this.proc?.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { this.proc?.kill("SIGKILL"); } catch {}
      }, 5000);
    };

    if (this.options.abortSignal.aborted) {
      killProc();
      throw new AgentError("turn_cancelled", "Run aborted before start");
    }
    this.options.abortSignal.addEventListener("abort", killProc, { once: true });

    // Turn timeout
    const timeoutMs = config.agent.turn_timeout_ms;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      logger.warn(`${this.runnerName} turn timeout`, {
        issue_identifier: issue.identifier,
        timeout_ms: timeoutMs,
      });
      killProc();
    }, timeoutMs);

    // Stall detection
    const stallTimeoutMs = config.agent.stall_timeout_ms;
    let stallTimer: Timer | null = null;
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (stallTimeoutMs > 0) {
        stallTimer = setTimeout(() => {
          logger.warn(`${this.runnerName} stall detected`, {
            issue_identifier: issue.identifier,
            stall_timeout_ms: stallTimeoutMs,
          });
          killProc();
        }, stallTimeoutMs);
      }
    };
    resetStallTimer();

    try {
      await this.readStream(resetStallTimer);
    } finally {
      clearTimeout(timeout);
      if (stallTimer) clearTimeout(stallTimer);
      this.options.abortSignal.removeEventListener("abort", killProc);
    }

    // Read stderr
    const rawStderr = this.proc.stderr && typeof this.proc.stderr !== "number"
      ? await new Response(this.proc.stderr).text()
      : "";
    const stderrText = filterYoloboxBanner(rawStderr);

    const exitCode = await this.proc.exited;

    logger.info(`${this.runnerName} process exited`, {
      issue_identifier: issue.identifier,
      exitCode,
    });

    if (timedOut) {
      this.emitEvent("turn_failed", { exitCode, reason: "timeout" });
      throw new AgentError("turn_timeout", `Turn timed out after ${timeoutMs}ms`);
    }

    if (this.options.abortSignal.aborted) {
      this.emitEvent("turn_cancelled", { exitCode });
      throw new AgentError("turn_cancelled", "Run aborted");
    }

    if (exitCode !== 0) {
      const errorContext = this.lastAssistantMessage || stderrText.slice(0, 500);
      this.emitEvent("turn_failed", { exitCode, stderr: stderrText.slice(0, 500) });
      throw new AgentError("turn_failed", `${this.runnerName} exited with code ${exitCode}: ${errorContext.slice(0, 200)}`);
    }

    this.emitEvent("turn_completed", { exitCode });
  }

  // ── Spawn Helpers ───────────────────────────────────────────

  private buildSpawnArgs(agentArgs: string[]): string[] {
    const { config, workspacePath, issue } = this.options;
    const { binary, yolobox, yolobox_arguments } = config.agent;

    if (!yolobox) {
      return [binary, ...agentArgs];
    }

    // yolobox: yolobox <binary> [...yolobox_arguments] -- <agentArgs>
    const symphonyRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
    const linearCliPath = new URL("../linear-cli.ts", import.meta.url).pathname;

    const yoloboxExtraArgs: string[] = [];
    // Mount symphony source so $SYMPHONY_LINEAR path works inside the container
    yoloboxExtraArgs.push("--mount", `${symphonyRoot}:${symphonyRoot}`);

    // Forward env vars that yolobox doesn't auto-forward
    const envVars: Record<string, string> = {
      SYMPHONY_LINEAR: linearCliPath,
      SYMPHONY_WORKSPACE: workspacePath,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    };
    if (config.tracker.api_key) {
      envVars.SYMPHONY_LINEAR_API_KEY = config.tracker.api_key;
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      envVars.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    for (const [key, value] of Object.entries(envVars)) {
      yoloboxExtraArgs.push("--env", `${key}=${value}`);
    }

    return ["yolobox", binary, ...yoloboxExtraArgs, ...yolobox_arguments, "--", ...agentArgs];
  }

  private buildEnv(): Record<string, string | undefined> {
    const { config, workspacePath, issue } = this.options;
    return {
      ...process.env,
      SYMPHONY_WORKSPACE: workspacePath,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_LINEAR: new URL("../linear-cli.ts", import.meta.url).pathname,
      ...(config.tracker.api_key ? { SYMPHONY_LINEAR_API_KEY: config.tracker.api_key } : {}),
    };
  }

  // ── Stream Reading ──────────────────────────────────────────

  private async readStream(onActivity: () => void): Promise<void> {
    const stdout = this.proc!.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new AgentError("agent_not_found", `${this.runnerName} stdout not available as stream`);
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (this.options.abortSignal.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          onActivity();

          let message: any;
          try {
            message = JSON.parse(trimmed);
          } catch {
            continue;
          }

          this.handleStreamMessage(message);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const message = JSON.parse(buffer.trim());
        this.handleStreamMessage(message);
      } catch {}
    }
  }

  // ── Shared Helpers ──────────────────────────────────────────

  protected writeTranscript(line: string): void {
    if (!this.options.transcriptPath) return;
    try {
      appendFileSync(this.options.transcriptPath, line + "\n", "utf-8");
    } catch {}
  }

  protected emitEvent(eventType: AgentEventType, payload?: unknown): void {
    const event: AgentEvent = {
      event: eventType,
      timestamp: new Date(),
      process_pid: this.session?.process_pid || this.proc?.pid?.toString(),
      payload,
    };

    if (this.session) {
      event.usage = {
        input_tokens: this.session.input_tokens,
        output_tokens: this.session.output_tokens,
        total_tokens: this.session.total_tokens,
      };
      event.cost_usd = this.session.cost_usd;
      event.duration_ms = this.session.duration_ms;
    }

    this.options.onEvent(event);
  }

  private cleanup(): void {
    this.terminate();
  }
}
