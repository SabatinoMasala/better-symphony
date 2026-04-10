import { describe, expect, test } from "bun:test";
import type { LogEntry } from "../logging/logger.js";
import { WebLogBuffer, createWebSink } from "./sink.js";

// ── WebLogBuffer ─────────────────────────────────────────────────

describe("WebLogBuffer", () => {
  test("push and getRecent", () => {
    const buf = new WebLogBuffer(100);
    buf.push({ source: "SYM-1", message: "hello", type: "line", timestamp: 1 });
    buf.push({ source: "SYM-2", message: "world", type: "info", timestamp: 2 });

    const recent = buf.getRecent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].message).toBe("hello");
    expect(recent[1].message).toBe("world");
  });

  test("getRecent returns last N items", () => {
    const buf = new WebLogBuffer(100);
    for (let i = 0; i < 10; i++) {
      buf.push({ source: "s", message: `msg-${i}`, type: "line", timestamp: i });
    }

    const last3 = buf.getRecent(3);
    expect(last3).toHaveLength(3);
    expect(last3[0].message).toBe("msg-7");
    expect(last3[1].message).toBe("msg-8");
    expect(last3[2].message).toBe("msg-9");
  });

  test("getRecent with n > buffer size returns all", () => {
    const buf = new WebLogBuffer(100);
    buf.push({ source: "s", message: "only", type: "line", timestamp: 1 });
    expect(buf.getRecent(50)).toHaveLength(1);
  });

  test("drain returns pending and clears them", () => {
    const buf = new WebLogBuffer(100);
    buf.push({ source: "s", message: "a", type: "line", timestamp: 1 });
    buf.push({ source: "s", message: "b", type: "line", timestamp: 2 });

    const first = buf.drain();
    expect(first).toHaveLength(2);
    expect(first[0].message).toBe("a");

    // Second drain should be empty
    const second = buf.drain();
    expect(second).toHaveLength(0);
  });

  test("drain does not affect getRecent", () => {
    const buf = new WebLogBuffer(100);
    buf.push({ source: "s", message: "a", type: "line", timestamp: 1 });
    buf.drain();
    buf.push({ source: "s", message: "b", type: "line", timestamp: 2 });

    // getRecent sees both (full buffer), drain only sees new
    expect(buf.getRecent(10)).toHaveLength(2);
    expect(buf.drain()).toHaveLength(1);
  });

  test("respects maxSize - evicts oldest entries", () => {
    const buf = new WebLogBuffer(3);
    for (let i = 0; i < 5; i++) {
      buf.push({ source: "s", message: `msg-${i}`, type: "line", timestamp: i });
    }

    const all = buf.getRecent(10);
    expect(all).toHaveLength(3);
    expect(all[0].message).toBe("msg-2");
    expect(all[1].message).toBe("msg-3");
    expect(all[2].message).toBe("msg-4");
  });

  test("empty buffer returns empty arrays", () => {
    const buf = new WebLogBuffer(100);
    expect(buf.getRecent(10)).toHaveLength(0);
    expect(buf.drain()).toHaveLength(0);
  });
});

// ── createWebSink ────────────────────────────────────────────────

describe("createWebSink", () => {
  function makeSink() {
    const buf = new WebLogBuffer(100);
    const sink = createWebSink(buf);
    return { buf, sink };
  }

  function makeEntry(overrides?: Partial<LogEntry>): LogEntry {
    return {
      level: "info",
      timestamp: new Date(),
      message: "test message",
      context: {},
      ...overrides,
    };
  }

  test("converts info entry to LogLine", () => {
    const { buf, sink } = makeSink();
    sink(makeEntry({ level: "info", message: "hello" }));

    const lines = buf.getRecent(1);
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("hello");
    expect(lines[0].type).toBe("info");
    expect(lines[0].source).toBe("orchestrator");
  });

  test("maps error level to error type", () => {
    const { buf, sink } = makeSink();
    sink(makeEntry({ level: "error" }));
    expect(buf.getRecent(1)[0].type).toBe("error");
  });

  test("maps warn level to info type", () => {
    const { buf, sink } = makeSink();
    sink(makeEntry({ level: "warn" }));
    expect(buf.getRecent(1)[0].type).toBe("info");
  });

  test("maps debug level to comment type", () => {
    const { buf, sink } = makeSink();
    sink(makeEntry({ level: "debug" }));
    expect(buf.getRecent(1)[0].type).toBe("comment");
  });

  test("extracts issue_identifier as source", () => {
    const { buf, sink } = makeSink();
    sink(makeEntry({ context: { issue_identifier: "SYM-42" } }));
    expect(buf.getRecent(1)[0].source).toBe("SYM-42");
  });

  test("defaults source to orchestrator when no issue_identifier", () => {
    const { buf, sink } = makeSink();
    sink(makeEntry({ context: {} }));
    expect(buf.getRecent(1)[0].source).toBe("orchestrator");
  });

  test("appends extra context to message", () => {
    const { buf, sink } = makeSink();
    sink(makeEntry({
      message: "hello",
      context: { issue_identifier: "SYM-1", exit_code: 0, path: "/tmp" },
    }));

    const line = buf.getRecent(1)[0];
    expect(line.message).toContain("hello");
    expect(line.message).toContain("exit_code=0");
    expect(line.message).toContain("path=/tmp");
    // issue_identifier, issue_id, session_id are excluded from extras
    expect(line.message).not.toContain("issue_identifier=");
  });

  test("skips null/undefined context values in extras", () => {
    const { buf, sink } = makeSink();
    sink(makeEntry({
      message: "msg",
      context: { a: null, b: undefined, c: "yes" } as any,
    }));

    const line = buf.getRecent(1)[0];
    expect(line.message).not.toContain("a=");
    expect(line.message).not.toContain("b=");
    expect(line.message).toContain("c=yes");
  });

  test("sets timestamp to current time", () => {
    const { buf, sink } = makeSink();
    const before = Date.now();
    sink(makeEntry());
    const after = Date.now();

    const ts = buf.getRecent(1)[0].timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
