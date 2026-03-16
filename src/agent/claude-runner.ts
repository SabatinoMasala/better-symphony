/**
 * Claude Runner
 * Launches Claude CLI in print mode with stream-json output.
 * Parses structured JSON events for real-time monitoring.
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

// Built-in system prompt for Linear CLI access
const LINEAR_SYSTEM_PROMPT_PATH = new URL("../prompts/linear-system-prompt.md", import.meta.url).pathname;
let _linearSystemPrompt: string | null = null;
function getLinearSystemPrompt(): string {
  if (_linearSystemPrompt === null) {
    _linearSystemPrompt = readFileSync(LINEAR_SYSTEM_PROMPT_PATH, "utf-8");
  }
  return _linearSystemPrompt;
}

// Built-in system prompt for GitHub CLI access
const GITHUB_SYSTEM_PROMPT_PATH = new URL("../prompts/github-system-prompt.md", import.meta.url).pathname;
let _githubSystemPrompt: string | null = null;
function getGitHubSystemPrompt(): string {
  if (_githubSystemPrompt === null) {
    _githubSystemPrompt = readFileSync(GITHUB_SYSTEM_PROMPT_PATH, "utf-8");
  }
  return _githubSystemPrompt;
}

// Strip ANSI escape sequences
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\u001B\].*?\u0007)/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(/\r/g, "");
}

/** Safely extract text from an array of content blocks (handles nested/object values) */
function extractBlockText(blocks: any[]): string {
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

export type AgentEventCallback = (event: AgentEvent) => void;

export interface ClaudeRunnerOptions {
  config: ServiceConfig;
  issue: Issue;
  workspacePath: string;
  prompt: string;
  attempt: number | null;
  onEvent: AgentEventCallback;
  abortSignal: AbortSignal;
  /** If set, write a human-readable transcript to this file path */
  transcriptPath?: string;
  /** If true, run Claude inside a Docker sandbox container */
  sandbox?: boolean;
}

export class ClaudeRunner {
  private options: ClaudeRunnerOptions;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private session: LiveSession | null = null;
  private sandboxName: string | null = null;

  constructor(options: ClaudeRunnerOptions) {
    this.options = options;
    // Initialize transcript file with header
    if (options.transcriptPath) {
      const header = `# Agent Transcript: ${options.issue.identifier}\nStarted: ${new Date().toISOString()}\n`;
      writeFileSync(options.transcriptPath, header, "utf-8");
    }
  }

  /**
   * Ensure the Docker sandbox container exists, creating it if necessary.
   * Returns the sandbox container name.
   */
  private async ensureSandbox(): Promise<string> {
    const { issue, workspacePath } = this.options;
    const sandboxName = issue.identifier;

    // Check if sandbox already exists
    const checkProc = Bun.spawn(["docker", "sandbox", "ls", "--format", "{{.Name}}"], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
    });

    const checkOutput = await new Response(checkProc.stdout).text();
    await checkProc.exited;

    const existingSandboxes = checkOutput.trim().split("\n").filter(Boolean);

    if (!existingSandboxes.includes(sandboxName)) {
      logger.info("Creating Docker sandbox", {
        issue_identifier: issue.identifier,
        sandbox_name: sandboxName,
      });

      // Create the sandbox: docker sandbox create --name SYM-123 -t <template> claude .
      const template = this.options.config.agent.sandbox_template ?? "claude-symphony:v1";
      const createProc = Bun.spawn([
        "docker", "sandbox", "create",
        "--name", sandboxName,
        "-t", template,
        "claude", "."
      ], {
        cwd: workspacePath,
        stdout: "pipe",
        stderr: "pipe",
      });

      const createStderr = await new Response(createProc.stderr).text();
      const createExitCode = await createProc.exited;

      if (createExitCode !== 0) {
        throw new AgentError("sandbox_failed", `Failed to create sandbox: ${createStderr.slice(0, 200)}`);
      }

      logger.info("Docker sandbox created", {
        issue_identifier: issue.identifier,
        sandbox_name: sandboxName,
      });
    } else {
      logger.info("Docker sandbox already exists", {
        issue_identifier: issue.identifier,
        sandbox_name: sandboxName,
      });
    }

    return sandboxName;
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
    const { config, issue, workspacePath, prompt } = this.options;

    // Create session
    const sessionId = `claude-${Date.now()}`;
    this.session = createSession(sessionId, "turn-1", null);

    this.emitEvent("session_started", {
      session_id: sessionId,
      issue_identifier: issue.identifier,
    });

    try {
      await this.launchClaude(prompt);
    } finally {
      this.cleanup();
    }
  }

  private async launchClaude(prompt: string): Promise<void> {
    const { config, workspacePath, issue, sandbox } = this.options;

    // Build Claude args: -p PROMPT --verbose --output-format stream-json --permission-mode X
    const claudeArgs: string[] = [
      "-p",
      prompt,
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      config.agent.permission_mode,
    ];

    if (config.agent.max_turns > 0) {
      claudeArgs.push("--max-turns", String(config.agent.max_turns));
    }

    // Build system prompt: built-in CLI docs + optional user-provided prompt
    const systemPromptParts: string[] = [getLinearSystemPrompt(), getGitHubSystemPrompt()];
    if (config.agent.append_system_prompt) {
      systemPromptParts.push(config.agent.append_system_prompt);
    }
    claudeArgs.push("--append-system-prompt", systemPromptParts.join("\n\n"));

    let spawnArgs: string[];

    // Build the base command: either wrapped in yolobox or direct
    // yolobox: yolobox <binary> [...yolobox_arguments] -- <claudeArgs>
    // direct:  <binary> <claudeArgs>
    const { binary, yolobox, yolobox_arguments } = config.agent;

    // When running in yolobox, mount symphony dir and forward env vars into the container
    const symphonyRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
    const linearCliPath = new URL("../linear-cli.ts", import.meta.url).pathname;
    const yoloboxExtraArgs: string[] = [];
    if (yolobox) {
      // Mount symphony source so $SYMPHONY_LINEAR path works inside the container
      yoloboxExtraArgs.push("--mount", `${symphonyRoot}:${symphonyRoot}`);
      // Forward env vars that yolobox doesn't auto-forward
      const envVars: Record<string, string> = {
        SYMPHONY_LINEAR: linearCliPath,
        SYMPHONY_WORKSPACE: workspacePath,
        SYMPHONY_ISSUE_ID: issue.id,
        SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      };
      if (process.env.LINEAR_API_KEY) {
        envVars.LINEAR_API_KEY = process.env.LINEAR_API_KEY;
      }
      for (const [key, value] of Object.entries(envVars)) {
        yoloboxExtraArgs.push("--env", `${key}=${value}`);
      }
    }

    const baseArgs = yolobox
      ? ["yolobox", binary, ...yoloboxExtraArgs, ...yolobox_arguments, "--", ...claudeArgs]
      : [binary, ...claudeArgs];

    if (sandbox) {
      // Ensure sandbox container exists
      this.sandboxName = await this.ensureSandbox();

      // Run via docker sandbox: docker sandbox run SANDBOX_NAME -- <baseArgs>
      spawnArgs = [
        "docker", "sandbox", "run",
        this.sandboxName,
        "--",
        ...baseArgs,
      ];

      logger.info("Launching Claude in sandbox", {
        issue_identifier: issue.identifier,
        sandbox_name: this.sandboxName,
        cwd: workspacePath,
        binary,
        yolobox,
        permission_mode: config.agent.permission_mode,
      });
    } else {
      // Run directly
      spawnArgs = baseArgs;

      logger.info("Launching Claude", {
        issue_identifier: issue.identifier,
        cwd: workspacePath,
        binary,
        yolobox,
        permission_mode: config.agent.permission_mode,
      });
    }

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
        // Resolve path to linear-cli so agents can call it from any cwd
        SYMPHONY_LINEAR: new URL("../linear-cli.ts", import.meta.url).pathname,
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
      logger.warn("Claude turn timeout", {
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
          logger.warn("Claude stall detected", {
            issue_identifier: issue.identifier,
            stall_timeout_ms: stallTimeoutMs,
          });
          killProc();
        }, stallTimeoutMs);
      }
    };
    resetStallTimer();

    try {
      await this.readStreamJson(resetStallTimer);
    } finally {
      clearTimeout(timeout);
      if (stallTimer) clearTimeout(stallTimer);
      this.options.abortSignal.removeEventListener("abort", killProc);
    }

    // Read stderr
    const stderrText = this.proc.stderr && typeof this.proc.stderr !== "number"
      ? await new Response(this.proc.stderr).text()
      : "";

    const exitCode = await this.proc.exited;

    logger.info("Claude process exited", {
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
      this.emitEvent("turn_failed", { exitCode, stderr: stderrText.slice(0, 500) });
      throw new AgentError("turn_failed", `Claude exited with code ${exitCode}: ${stderrText.slice(0, 200)}`);
    }

    this.emitEvent("turn_completed", { exitCode });
  }

  /**
   * Read stdout as stream-json lines and dispatch events.
   * Ported from apps/tui/src/claude/runner.ts
   */
  private async readStreamJson(onActivity: () => void): Promise<void> {
    const stdout = this.proc!.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new AgentError("agent_not_found", "Claude stdout not available as stream");
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

  private handleStreamMessage(message: any): void {
    const msgType = message.type;

    if (msgType === "system") {
      this.handleSystemMessage(message);
    } else if (msgType === "assistant") {
      this.handleAssistantMessage(message);
    } else if (msgType === "user") {
      this.handleToolResult(message);
    } else if (msgType === "result") {
      this.handleResultMessage(message);
    }
  }

  private handleSystemMessage(message: any): void {
    if (message.subtype === "init") {
      const model = message.model ?? "unknown";
      const sessionId = message.session_id;

      if (sessionId && this.session) {
        this.session.session_id = sessionId;
      }

      logger.info("Claude session init", {
        issue_identifier: this.options.issue.identifier,
        model,
        session_id: sessionId,
      });

      this.writeTranscript(`\n## Session Init\nModel: ${model}\n`);

      if (this.session) {
        updateSessionEvent(this.session, "system:init", `model=${model}`);
      }
    }
  }

  private handleAssistantMessage(message: any): void {
    const content = message.message?.content ?? [];
    const issueId = this.options.issue.identifier;

    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        const text = stripAnsi(block.text.trim());
        this.emitEvent("assistant_message", { text: text.slice(0, 500) });

        logger.debug(text.slice(0, 200), { issue_identifier: issueId });
        this.writeTranscript(`\n### Assistant\n${text}\n`);

        if (this.session) {
          updateSessionEvent(this.session, "assistant", text.slice(0, 200));
        }
      }

      if (block.type === "tool_use") {
        const name = block.name ?? "unknown";
        const input = block.input ?? {};
        const detail =
          input.command ??
          input.file_path ??
          input.pattern ??
          input.description ??
          input.query ??
          input.url ??
          input.prompt ??
          "";
        const truncated = detail ? String(detail).slice(0, 120) : "";

        this.emitEvent("tool_use", { tool: name, detail: truncated });

        logger.info(truncated ? `${name} ${truncated}` : name, {
          issue_identifier: issueId,
        });
        this.writeTranscript(`\n### Tool: ${name}\n${truncated}\n`);

        if (this.session) {
          updateSessionEvent(this.session, `tool:${name}`, truncated);
        }
      }
    }
  }

  private handleToolResult(message: any): void {
    const result = message.tool_use_result;
    const issueId = this.options.issue.identifier;

    if (!result) {
      // No tool_use_result — try to extract from message content
      const contentBlocks = message.message?.content;
      if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
        const isError = contentBlocks[0]?.is_error;
        const text = extractBlockText(contentBlocks);
        if (isError) {
          this.emitEvent("tool_result", { error: true, message: text.slice(0, 200) });
          logger.error(`x ${text.slice(0, 200)}`, { issue_identifier: issueId });
        } else if (text) {
          const summary = `-> ${text.slice(0, 200)}`;
          this.emitEvent("tool_result", { summary });
          logger.debug(summary, { issue_identifier: issueId });
        }
      }
      return;
    }

    if (result.file) {
      const path = result.file.filePath?.split("/").pop() ?? "";
      const lines = result.file.numLines ?? "?";
      const summary = `-> ${path} (${lines} lines)`;
      this.emitEvent("tool_result", { summary });
      logger.debug(summary, { issue_identifier: issueId });
      if (this.session) updateSessionEvent(this.session, "tool_result", summary);
      return;
    }

    if (result.stdout !== undefined) {
      const output = result.stdout || result.stderr || "";
      const summary = !output.trim()
        ? "-> (no output)"
        : `-> (${output.trim().split("\n").length} lines)`;
      this.emitEvent("tool_result", { summary });
      logger.debug(summary, { issue_identifier: issueId });
      if (this.session) updateSessionEvent(this.session, "tool_result", summary);
      return;
    }

    const isError = message.message?.content?.[0]?.is_error;
    if (isError) {
      const errContent = message.message.content[0].content ?? "";
      this.emitEvent("tool_result", { error: true, message: errContent.slice(0, 200) });
      logger.error(`x ${errContent.slice(0, 200)}`, { issue_identifier: issueId });
      if (this.session) updateSessionEvent(this.session, "tool_result", errContent.slice(0, 200));
      return;
    }

    // Fallback: extract text from message content blocks
    const contentBlocks = message.message?.content;
    if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
      const text = extractBlockText(contentBlocks);
      const summary = text
        ? `-> ${text.slice(0, 200)}`
        : "-> (tool result)";
      this.emitEvent("tool_result", { summary });
      logger.debug(summary, { issue_identifier: issueId });
      if (this.session) updateSessionEvent(this.session, "tool_result", summary.slice(0, 200));
    } else {
      this.emitEvent("tool_result", { summary: "-> (tool result)" });
      logger.debug("-> (tool result)", { issue_identifier: issueId });
      if (this.session) updateSessionEvent(this.session, "tool_result", "(tool result)");
    }
  }

  private handleResultMessage(message: any): void {
    const costUsd = message.total_cost_usd ?? undefined;
    const durationMs = message.duration_ms ?? undefined;
    const isError = message.is_error ?? false;
    const numTurns = message.num_turns ?? undefined;

    // Extract usage from result if available
    const usage = message.usage;
    if (usage && this.session) {
      updateSessionTokens(this.session, {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      });

      this.emitEvent("token_usage_updated", {
        usage,
        cost_usd: costUsd,
      });
    }

    if (costUsd !== undefined && this.session) {
      this.session.cost_usd = costUsd;
    }
    if (durationMs !== undefined && this.session) {
      this.session.duration_ms = durationMs;
    }

    const parts: string[] = [];
    if (costUsd !== undefined) parts.push(`$${costUsd.toFixed(4)}`);
    if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
    if (numTurns !== undefined) parts.push(`${numTurns} turns`);

    const suffix = parts.length ? ` (${parts.join(", ")})` : "";

    logger.info(`Claude ${isError ? "failed" : "completed"}${suffix}`, {
      issue_identifier: this.options.issue.identifier,
      cost_usd: costUsd,
      duration_ms: durationMs,
      num_turns: numTurns,
      is_error: isError,
    });

    this.writeTranscript(`\n## Result\n${isError ? "Failed" : "Completed"}${suffix}\n`);
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