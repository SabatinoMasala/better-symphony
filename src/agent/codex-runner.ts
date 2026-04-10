/**
 * Codex Runner
 * Launches OpenAI Codex CLI in non-interactive mode with JSON Lines output.
 * Parses structured events for real-time monitoring.
 *
 * Codex CLI: `codex exec PROMPT --json --full-auto`
 * System prompt: injected via `-c developer_instructions="..."`
 * Output: newline-delimited JSON (thread.started, item.*, turn.*, error)
 */

import { logger } from "../logging/logger.js";
import { updateSessionEvent, updateSessionTokens } from "./session.js";
import {
  BaseRunner,
  stripAnsi,
  getLinearSystemPrompt,
  getGitHubSystemPrompt,
} from "./base-runner.js";

export class CodexRunner extends BaseRunner {
  protected readonly runnerName = "Codex";
  private startedAt: number = 0;

  async run(): Promise<void> {
    this.startedAt = Date.now();
    return super.run();
  }

  protected buildArgs(prompt: string): string[] {
    const { config } = this.options;
    const args: string[] = ["exec"];

    // Inject system prompt via -c developer_instructions="..."
    const systemPromptParts: string[] = [getLinearSystemPrompt(), getGitHubSystemPrompt()];
    if (config.agent.append_system_prompt) {
      systemPromptParts.push(config.agent.append_system_prompt);
    }
    const systemPrompt = systemPromptParts.join("\n\n");
    if (systemPrompt) {
      args.push("-c", `developer_instructions=${JSON.stringify(systemPrompt)}`);
    }

    args.push(prompt);

    // JSON Lines output for machine-readable streaming
    args.push("--json");

    // Permission mode mapping
    const permissionMode = config.agent.permission_mode;
    if (permissionMode === "bypassPermissions" || permissionMode === "dangerMode") {
      args.push("--full-auto", "--sandbox", "danger-full-access");
    } else {
      args.push("--full-auto");
    }

    // Skip session persistence for ephemeral agent runs
    args.push("--ephemeral");

    return args;
  }

  // ── Event Dispatch ──────────────────────────────────────────

  protected handleStreamMessage(message: any): void {
    switch (message.type) {
      case "thread.started":
        this.handleThreadStarted(message);
        break;
      case "turn.started":
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

  // ── Event Handlers ──────────────────────────────────────────

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
      // Shape: { command: "/bin/bash -lc '...'", status: "in_progress" }
      const command = item.command ?? "";
      this.emitEvent("tool_use", { tool: "Bash", detail: command.slice(0, 120) });

      logger.info(`Bash ${command.slice(0, 120)}`, { issue_identifier: issueId });
      this.writeTranscript(`\n### Tool: Bash\n${command.slice(0, 120)}\n`);

      if (this.session) {
        updateSessionEvent(this.session, "tool:Bash", command.slice(0, 120));
      }
    } else if (itemType === "file_change") {
      // Shape: { changes: [{ path: "/abs/path", kind: "add"|"modify" }], status: "in_progress" }
      const detail = formatChanges(item.changes);

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
      // Shape: { command, aggregated_output, exit_code, status: "completed"|"failed" }
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
      // Shape: { changes: [{ path, kind }], status: "completed"|"failed" }
      const detail = formatChanges(item.changes);
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
}

/** Format a Codex file_change changes array into a human-readable string */
export function formatChanges(changes: any[] | undefined): string {
  if (!changes?.length) return "file";
  return changes.map((c: any) => {
    const name = (c.path ?? "").split("/").pop() ?? c.path ?? "";
    return c.kind ? `${name} (${c.kind})` : name;
  }).join(", ");
}
