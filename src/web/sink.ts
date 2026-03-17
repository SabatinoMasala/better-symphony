/**
 * Web Log Sink
 * Buffers log lines for SSE streaming to the web dashboard.
 */

import type { LogSink, LogEntry } from "../logging/logger.js";
import type { LogLine } from "../tui/types.js";

export class WebLogBuffer {
  private buffer: LogLine[] = [];
  private pending: LogLine[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(line: LogLine): void {
    this.buffer.push(line);
    this.pending.push(line);
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }
  }

  /** Return and clear accumulated lines since last drain. */
  drain(): LogLine[] {
    const lines = this.pending;
    this.pending = [];
    return lines;
  }

  /** Return the last N lines from the full buffer. */
  getRecent(n: number): LogLine[] {
    return this.buffer.slice(-n);
  }
}

export function createWebSink(buffer: WebLogBuffer): LogSink {
  return (entry: LogEntry) => {
    const type: LogLine["type"] =
      entry.level === "error"
        ? "error"
        : entry.level === "warn"
          ? "info"
          : entry.level === "info"
            ? "info"
            : "comment";

    const source =
      (entry.context.issue_identifier as string) ?? "orchestrator";

    let message = entry.message;
    const extras: string[] = [];
    for (const [key, value] of Object.entries(entry.context)) {
      if (key === "issue_identifier" || key === "issue_id" || key === "session_id") continue;
      if (value !== undefined && value !== null) {
        extras.push(`${key}=${value}`);
      }
    }
    if (extras.length > 0) {
      message += ` (${extras.join(", ")})`;
    }

    buffer.push({ source, message, type, timestamp: Date.now() });
  };
}
