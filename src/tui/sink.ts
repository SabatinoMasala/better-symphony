/**
 * TUI Log Sink
 * Bridges the Symphony logger to the TUI's log buffer.
 */

import type { LogSink, LogEntry } from "../logging/logger.js";
import type { LogLine } from "./types.js";

export type LogLineCallback = (line: LogLine) => void;

export function createTuiSink(onLine: LogLineCallback): LogSink {
  return (entry: LogEntry) => {
    const type: LogLine["type"] =
      entry.level === "error"
        ? "error"
        : entry.level === "warn"
          ? "info"
          : entry.level === "info"
            ? "info"
            : "comment";

    // Extract source from context, fallback to "symphony"
    const source =
      (entry.context.issue_identifier as string) ??
      "orchestrator";

    // Build message with relevant context
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

    onLine({
      source,
      message,
      type,
      timestamp: Date.now(),
    });
  };
}
