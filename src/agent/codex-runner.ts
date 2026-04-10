/**
 * Codex Runner
 * Launches OpenAI Codex CLI in non-interactive mode with JSON Lines output.
 * Parses structured events for real-time monitoring.
 *
 * Codex CLI reference: `codex exec PROMPT --json --full-auto`
 * Output: newline-delimited JSON events on stdout (thread.started, item.*, turn.*, error)
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
import { createSession, updateSessionEvent, updateSessionTokens } from "./session.js";
import type { ClaudeRunnerOptions, AgentEventCallback } from "./claude-runner.js";

// Strip ANSI escape sequences
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\u001B\].*?\u0007)/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(/\r/g, "");
}

// Filter out yolobox ASCII art banner from stderr
const YOLOBOX_BANNER_RE = /[ \t]*[█╗╔╚╝═║░▒▓]+[█╗╔╚╝═║░▒▓ \t]*\n?/g;
function filterYoloboxBanner(stderr: string): string {
  const filtered = stderr.replace(YOLOBOX_BANNER_RE, "").trim();
  if (filtered.length < stderr.trim().length) {
    return filtered ? `[yolobox] ${filtered}` : "[yolobox]";
  }
  return stderr;
}

// Built-in system prompts for CLI access
const LINEAR_SYSTEM_PROMPT_PATH = new URL("../prompts/linear-system-prompt.md", import.meta.url).pathname;
let _linearSystemPrompt: string | null = null;
function getLinearSystemPrompt(): string {
  if (_linearSystemPrompt === null) {
    _linearSystemPrompt = readFileSync(LINEAR_SYSTEM_PROMPT_PATH, "utf-8");
  }
  return _linearSystemPrompt;
}

const GITHUB_SYSTEM_PROMPT_PATH = new URL("../prompts/github-system-prompt.md", import.meta.url).pathname;
let _githubSystemPrompt: string | null = null;
function getGitHubSystemPrompt(): string {
  if (_githubSystemPrompt === null) {
    _githubSystemPrompt = readFileSync(GITHUB_SYSTEM_PROMPT_PATH, "utf-8");
  }
  return _githubSystemPrompt;
}

export class CodexRunner {
  private options: ClaudeRunnerOptions;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private session: LiveSession | null = null;
  private lastAssistantMessage: string | null = null;
  private startedAt: number = 0;

  constructor(options: ClaudeRunnerOptions) {
    this.options = options;
    if (options.transcriptPath) {
      const header = `# Agent Transcript (Codex): ${options.issue.identifier}\nStarted: ${new Date().toISOString()}\n`;
      writeFileSync(options.transcriptPath, header, "utf-8");
    }
  }

  private writeTranscript(line: string): void {
    if (!this.options.transcriptPath) return;
    try {
      appendFileSync(this.options.transcriptPath, line + "\n", "utf-8");
    } catch {}
  }

  getSession(): LiveSession | null {
    return this.session;
  }

  async run(): Promise<void> {
    const { issue, prompt } = this.options;

    const sessionId = `codex-${Date.now()}`;
    this.session = createSession(sessionId, "turn-1", null);
    this.startedAt = Date.now();

    this.emitEvent("session_started", {
      session_id: sessionId,
      issue_identifier: issue.identifier,
    });

    try {
      await this.launchCodex(prompt);
    } finally {
      this.cleanup();
    }
  }

  private async launchCodex(prompt: string): Promise<void> {
    const { config, workspacePath, issue } = this.options;

    // Codex exec takes the prompt as a positional argument after "exec"
    const codexArgs: string[] = ["exec"];

    // Inject system prompt via -c developer_instructions="..."
    const systemPromptParts: string[] = [getLinearSystemPrompt(), getGitHubSystemPrompt()];
    if (config.agent.append_system_prompt) {
      systemPromptParts.push(config.agent.append_system_prompt);
    }
    const systemPrompt = systemPromptParts.join("\n\n");
    if (systemPrompt) {
      codexArgs.push("-c", `developer_instructions=${JSON.stringify(systemPrompt)}`);
    }

    codexArgs.push(prompt);

    // JSON Lines output for machine-readable streaming
    codexArgs.push("--json");

    // Permission mode: Codex uses --full-auto and --sandbox flags
    // Map Symphony's permission modes to Codex equivalents
    const permissionMode = config.agent.permission_mode;
    if (permissionMode === "bypassPermissions" || permissionMode === "dangerMode") {
      codexArgs.push("--full-auto", "--sandbox", "danger-full-access");
    } else {
      // acceptEdits or similar → full-auto (required for non-interactive)
      codexArgs.push("--full-auto");
    }

    // Skip session persistence for ephemeral agent runs
    codexArgs.push("--ephemeral");

    let spawnArgs: string[];

    const { binary, yolobox, yolobox_arguments } = config.agent;

    // When running in yolobox, mount symphony dir and forward env vars
    const symphonyRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
    const linearCliPath = new URL("../linear-cli.ts", import.meta.url).pathname;
    const yoloboxExtraArgs: string[] = [];
    if (yolobox) {
      yoloboxExtraArgs.push("--mount", `${symphonyRoot}:${symphonyRoot}`);
      const envVars: Record<string, string> = {
        SYMPHONY_LINEAR: linearCliPath,
        SYMPHONY_WORKSPACE: workspacePath,
        SYMPHONY_ISSUE_ID: issue.id,
        SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      };
      if (config.tracker.api_key) {
        envVars.SYMPHONY_LINEAR_API_KEY = config.tracker.api_key;
      }
      for (const [key, value] of Object.entries(envVars)) {
        yoloboxExtraArgs.push("--env", `${key}=${value}`);
      }
    }

    const binaryName = binary === "codex" ? "codex" : binary;
    const baseArgs = yolobox
      ? ["yolobox", binaryName, ...yoloboxExtraArgs, ...yolobox_arguments, "--", ...codexArgs]
      : [binaryName, ...codexArgs];

    spawnArgs = baseArgs;

    logger.info("Launching Codex", {
      issue_identifier: issue.identifier,
      cwd: workspacePath,
      binary: binaryName,
      yolobox,
    });

    this.proc = Bun.spawn(spawnArgs, {
      cwd: workspacePath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SYMPHONY_WORKSPACE: workspacePath,
        SYMPHONY_ISSUE_ID: issue.id,
        SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
        SYMPHONY_LINEAR: new URL("../linear-cli.ts", import.meta.url).pathname,
        ...(config.tracker.api_key ? { SYMPHONY_LINEAR_API_KEY: config.tracker.api_key } : {}),
      },
    });

    if (this.session) {
      this.session.process_pid = this.proc.pid?.toString() ?? null;
    }

    // Kill on abort
    const killProc = () => {
      try {
        this.proc?.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          this.proc?.kill("SIGKILL");
        } catch {}
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
      logger.warn("Codex turn timeout", {
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
          logger.warn("Codex stall detected", {
            issue_identifier: issue.identifier,
            stall_timeout_ms: stallTimeoutMs,
          });
          killProc();
        }, stallTimeoutMs);
      }
    };
    resetStallTimer();

    try {
      await this.readJsonLines(resetStallTimer);
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

    logger.info("Codex process exited", {
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
      throw new AgentError("turn_failed", `Codex exited with code ${exitCode}: ${errorContext.slice(0, 200)}`);
    }

    this.emitEvent("turn_completed", { exitCode });
  }

  /**
   * Read stdout as JSON Lines and dispatch events.
   * Codex `--json` streams events like: thread.started, turn.started, item.started,
   * item.completed, turn.completed, turn.failed, error
   */
  private async readJsonLines(onActivity: () => void): Promise<void> {
    const stdout = this.proc!.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new AgentError("agent_not_found", "Codex stdout not available as stream");
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

  /**
   * Map Codex JSON Lines events to Symphony AgentEvents.
   *
   * Codex event types:
   *   thread.started  - session begins, contains thread_id
   *   turn.started    - agent turn begins
   *   turn.completed  - agent turn ends successfully
   *   turn.failed     - agent turn failed
   *   item.started    - an item (message, command, file change, etc.) begins
   *   item.completed  - an item completes
   *   error           - top-level error
   */
  private handleStreamMessage(message: any): void {
    const eventType = message.type;

    switch (eventType) {
      case "thread.started":
        this.handleThreadStarted(message);
        break;
      case "turn.started":
        // No-op, just note it for transcript
        this.writeTranscript("\n## Turn Started\n");
        break;
      case "turn.completed":
        this.handleTurnCompleted(message);
        break;
      case "turn.failed":
        this.handleTurnFailed(message);
        break;
      case "item.started":
        this.handleItemStarted(message);
        break;
      case "item.completed":
        this.handleItemCompleted(message);
        break;
      case "error":
        this.handleError(message);
        break;
    }
  }

  private handleThreadStarted(message: any): void {
    const threadId = message.thread_id;

    if (threadId && this.session) {
      this.session.session_id = threadId;
    }

    logger.info("Codex session started", {
      issue_identifier: this.options.issue.identifier,
      thread_id: threadId,
    });

    this.writeTranscript(`\n## Session Init\nThread: ${threadId}\n`);

    if (this.session) {
      updateSessionEvent(this.session, "system:init", `thread=${threadId}`);
    }
  }

  private handleTurnCompleted(message: any): void {
    const durationMs = Date.now() - this.startedAt;

    // Extract token usage from turn.completed
    // Shape: { usage: { input_tokens, cached_input_tokens, output_tokens } }
    const usage = message.usage;
    if (usage && this.session) {
      updateSessionTokens(this.session, {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      });

      this.emitEvent("token_usage_updated", { usage });
    }

    if (this.session) {
      this.session.duration_ms = durationMs;
    }

    const parts: string[] = [];
    if (durationMs) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
    if (usage?.input_tokens) parts.push(`${usage.input_tokens} in`);
    if (usage?.output_tokens) parts.push(`${usage.output_tokens} out`);
    const suffix = parts.length ? ` (${parts.join(", ")})` : "";

    logger.info(`Codex turn completed${suffix}`, {
      issue_identifier: this.options.issue.identifier,
      duration_ms: durationMs,
      input_tokens: usage?.input_tokens,
      output_tokens: usage?.output_tokens,
    });

    this.writeTranscript(`\n## Turn Completed${suffix}\n`);
  }

  private handleTurnFailed(message: any): void {
    const reason = message.reason ?? message.message ?? "unknown";

    logger.warn("Codex turn failed", {
      issue_identifier: this.options.issue.identifier,
      reason,
    });

    this.writeTranscript(`\n## Turn Failed\nReason: ${reason}\n`);
  }

  private handleItemStarted(message: any): void {
    const item = message.item;
    if (!item) return;

    const itemType = item.type;
    const issueId = this.options.issue.identifier;

    if (itemType === "command_execution") {
      // Real shape: { command: "/bin/bash -lc '...'", status: "in_progress" }
      const command = item.command ?? "";
      this.emitEvent("tool_use", { tool: "Bash", detail: command.slice(0, 120) });

      logger.info(`Bash ${command.slice(0, 120)}`, { issue_identifier: issueId });
      this.writeTranscript(`\n### Tool: Bash\n${command.slice(0, 120)}\n`);

      if (this.session) {
        updateSessionEvent(this.session, "tool:Bash", command.slice(0, 120));
      }
    } else if (itemType === "file_change") {
      // Real shape: { changes: [{ path: "/abs/path", kind: "add"|"modify" }], status: "in_progress" }
      const changes = item.changes ?? [];
      const detail = changes.map((c: any) => {
        const name = (c.path ?? "").split("/").pop() ?? c.path ?? "";
        return c.kind ? `${name} (${c.kind})` : name;
      }).join(", ") || "file";

      this.emitEvent("tool_use", { tool: "Edit", detail });

      logger.info(`Edit ${detail}`, { issue_identifier: issueId });
      this.writeTranscript(`\n### Tool: Edit\n${detail}\n`);

      if (this.session) {
        updateSessionEvent(this.session, "tool:Edit", detail);
      }
    } else if (itemType === "mcp_call") {
      const toolName = item.tool ?? item.name ?? "mcp";
      this.emitEvent("tool_use", { tool: toolName, detail: "" });

      logger.info(toolName, { issue_identifier: issueId });
      this.writeTranscript(`\n### Tool: ${toolName}\n`);

      if (this.session) {
        updateSessionEvent(this.session, `tool:${toolName}`, "");
      }
    } else if (itemType === "web_search") {
      const query = item.query ?? "";
      this.emitEvent("tool_use", { tool: "WebSearch", detail: query.slice(0, 120) });

      logger.info(`WebSearch ${query.slice(0, 120)}`, { issue_identifier: issueId });
      this.writeTranscript(`\n### Tool: WebSearch\n${query.slice(0, 120)}\n`);

      if (this.session) {
        updateSessionEvent(this.session, "tool:WebSearch", query.slice(0, 120));
      }
    }
  }

  private handleItemCompleted(message: any): void {
    const item = message.item;
    if (!item) return;

    const itemType = item.type;
    const issueId = this.options.issue.identifier;

    if (itemType === "agent_message" || itemType === "reasoning") {
      const text = stripAnsi((item.text ?? "").trim());
      if (text) {
        this.lastAssistantMessage = text;
        this.emitEvent("assistant_message", { text: text.slice(0, 500) });

        logger.debug(text.slice(0, 200), { issue_identifier: issueId });
        this.writeTranscript(`\n### Assistant\n${text}\n`);

        if (this.session) {
          updateSessionEvent(this.session, "assistant", text.slice(0, 200));
        }
      }
    } else if (itemType === "command_execution") {
      // Real shape: { command, aggregated_output, exit_code, status: "completed"|"failed" }
      const exitCode = item.exit_code;
      const output = item.aggregated_output ?? "";
      const outputLines = output.trim() ? output.trim().split("\n").length : 0;
      const failed = item.status === "failed";
      const summary = outputLines > 0
        ? `-> (${outputLines} lines, exit ${exitCode ?? "?"}${failed ? ", failed" : ""})`
        : `-> (no output, exit ${exitCode ?? "?"}${failed ? ", failed" : ""})`;

      this.emitEvent("tool_result", { summary, error: failed });
      logger.debug(summary, { issue_identifier: issueId });

      if (this.session) {
        updateSessionEvent(this.session, "tool_result", summary);
      }
    } else if (itemType === "file_change") {
      // Real shape: { changes: [{ path, kind }], status: "completed"|"failed" }
      const changes = item.changes ?? [];
      const detail = changes.map((c: any) => {
        const name = (c.path ?? "").split("/").pop() ?? c.path ?? "";
        return c.kind ? `${name} (${c.kind})` : name;
      }).join(", ") || "file";
      const failed = item.status === "failed";
      const summary = `-> ${detail}${failed ? " (failed)" : ""}`;

      this.emitEvent("tool_result", { summary, error: failed });
      logger.debug(summary, { issue_identifier: issueId });

      if (this.session) {
        updateSessionEvent(this.session, "tool_result", summary);
      }
    }
  }

  private handleError(message: any): void {
    const errorMessage = message.message ?? message.error ?? "Unknown error";

    logger.error(`Codex error: ${errorMessage}`, {
      issue_identifier: this.options.issue.identifier,
    });

    this.writeTranscript(`\n## Error\n${errorMessage}\n`);

    if (this.session) {
      updateSessionEvent(this.session, "error", errorMessage);
    }
  }

  private emitEvent(eventType: AgentEventType, payload?: unknown): void {
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

  private cleanup(): void {
    this.terminate();
  }
}
