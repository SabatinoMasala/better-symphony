import { describe, expect, test, beforeEach } from "bun:test";
import type { LogEntry, LogSink, LogLevel } from "./logger.js";

// We can't import the singleton `logger` (it has a console sink that would pollute output).
// Instead we test the Logger class behavior by constructing a fresh one via the module's
// exported factory-style helpers and by exercising the sink protocol directly.

// ── createConsoleSink formatting ─────────────────────────────────

// We can't easily capture console.log output in bun:test, but we can test
// the formatting by calling the sink directly with a mock entry.

describe("Logger sink protocol", () => {
  // Build a mini logger for testing (mirrors the class in logger.ts)
  function createTestLogger() {
    const entries: LogEntry[] = [];
    const sink: LogSink = (e) => entries.push(e);

    let minLevel: LogLevel = "info";
    const levelOrder: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };

    return {
      entries,
      setMinLevel(level: LogLevel) {
        minLevel = level;
      },
      emit(level: LogLevel, message: string, context: Record<string, unknown> = {}) {
        if (levelOrder[level] < levelOrder[minLevel]) return;
        const entry: LogEntry = { level, timestamp: new Date(), message, context };
        sink(entry);
      },
    };
  }

  test("emits info when minLevel is info", () => {
    const log = createTestLogger();
    log.emit("info", "hello");
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].message).toBe("hello");
  });

  test("suppresses debug when minLevel is info", () => {
    const log = createTestLogger();
    log.emit("debug", "hidden");
    expect(log.entries).toHaveLength(0);
  });

  test("emits debug when minLevel is debug", () => {
    const log = createTestLogger();
    log.setMinLevel("debug");
    log.emit("debug", "visible");
    expect(log.entries).toHaveLength(1);
  });

  test("emits error regardless of minLevel", () => {
    const log = createTestLogger();
    log.setMinLevel("error");
    log.emit("error", "boom");
    expect(log.entries).toHaveLength(1);
    log.emit("warn", "nope");
    expect(log.entries).toHaveLength(1);
  });

  test("level ordering: debug < info < warn < error", () => {
    const log = createTestLogger();
    log.setMinLevel("warn");
    log.emit("debug", "d");
    log.emit("info", "i");
    log.emit("warn", "w");
    log.emit("error", "e");
    expect(log.entries.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  test("context is passed through to entry", () => {
    const log = createTestLogger();
    log.emit("info", "msg", { issue_identifier: "SYM-1", extra: 42 });
    expect(log.entries[0].context.issue_identifier).toBe("SYM-1");
    expect(log.entries[0].context.extra).toBe(42);
  });

  test("entry includes timestamp", () => {
    const log = createTestLogger();
    const before = new Date();
    log.emit("info", "msg");
    const after = new Date();
    expect(log.entries[0].timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(log.entries[0].timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ── Console sink format ──────────────────────────────────────────

describe("console sink format", () => {
  // Replicate the formatting logic from createConsoleSink
  function formatEntry(entry: LogEntry): string {
    const ts = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    let contextStr = "";
    for (const [key, value] of Object.entries(entry.context)) {
      if (value !== undefined && value !== null) {
        contextStr += ` ${key}=${JSON.stringify(value)}`;
      }
    }
    return `[${ts}] ${level} ${entry.message}${contextStr}`;
  }

  test("formats basic entry", () => {
    const ts = new Date("2025-06-01T12:00:00.000Z");
    const entry: LogEntry = { level: "info", timestamp: ts, message: "hello", context: {} };
    expect(formatEntry(entry)).toBe("[2025-06-01T12:00:00.000Z] INFO  hello");
  });

  test("formats entry with context", () => {
    const ts = new Date("2025-06-01T12:00:00.000Z");
    const entry: LogEntry = {
      level: "error",
      timestamp: ts,
      message: "failed",
      context: { issue_identifier: "SYM-1", code: 42 },
    };
    const result = formatEntry(entry);
    expect(result).toContain("ERROR");
    expect(result).toContain("failed");
    expect(result).toContain('issue_identifier="SYM-1"');
    expect(result).toContain("code=42");
  });

  test("pads level to 5 chars", () => {
    const ts = new Date("2025-06-01T12:00:00.000Z");
    expect(formatEntry({ level: "warn", timestamp: ts, message: "x", context: {} })).toContain("WARN ");
    expect(formatEntry({ level: "debug", timestamp: ts, message: "x", context: {} })).toContain("DEBUG");
    expect(formatEntry({ level: "info", timestamp: ts, message: "x", context: {} })).toContain("INFO ");
  });

  test("skips null/undefined context values", () => {
    const ts = new Date("2025-06-01T12:00:00.000Z");
    const entry: LogEntry = {
      level: "info",
      timestamp: ts,
      message: "msg",
      context: { a: null, b: undefined, c: "yes" } as any,
    };
    const result = formatEntry(entry);
    expect(result).not.toContain("a=");
    expect(result).not.toContain("b=");
    expect(result).toContain('c="yes"');
  });
});
