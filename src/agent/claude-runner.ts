/**
 * Claude Runner
 * Launches Claude CLI in print mode with stream-json output.
 * Parses structured JSON events for real-time monitoring.
 */

import { logger } from "../logging/logger.js";
import { updateSessionEvent, updateSessionTokens } from "./session.js";
import {
  BaseRunner,
  stripAnsi,
  extractBlockText,
  getLinearSystemPrompt,
  getGitHubSystemPrompt,
} from "./base-runner.js";

// Re-export types for backward compatibility (used by orchestrator imports)
export type { RunnerOptions as ClaudeRunnerOptions, AgentEventCallback } from "./base-runner.js";

export class ClaudeRunner extends BaseRunner {
  protected readonly runnerName = "Claude";

  protected buildArgs(prompt: string): string[] {
    const { config } = this.options;

    const args: string[] = [
      "-p",
      prompt,
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      config.agent.permission_mode,
    ];

    if (config.agent.max_turns > 0) {
      args.push("--max-turns", String(config.agent.max_turns));
    }

    // Build system prompt: built-in CLI docs + optional user-provided prompt
    const systemPromptParts: string[] = [getLinearSystemPrompt(), getGitHubSystemPrompt()];
    if (config.agent.append_system_prompt) {
      systemPromptParts.push(config.agent.append_system_prompt);
    }
    args.push("--append-system-prompt", systemPromptParts.join("\n\n"));

    return args;
  }

  protected handleStreamMessage(message: any): void {
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
        this.lastAssistantMessage = text;
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
}
