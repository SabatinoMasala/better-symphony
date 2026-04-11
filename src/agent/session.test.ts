import { describe, expect, test } from "bun:test";
import {
  createSession,
  updateSessionTurnId,
  updateSessionEvent,
  updateSessionTokens,
  createEmptyTotals,
  updateTotals,
  parseRateLimits,
} from "./session.js";

describe("createSession", () => {
  test("returns correct shape and defaults", () => {
    const s = createSession("thread-1", "turn-1", "1234");

    expect(s.session_id).toBe("thread-1-turn-1");
    expect(s.thread_id).toBe("thread-1");
    expect(s.turn_id).toBe("turn-1");
    expect(s.process_pid).toBe("1234");
    expect(s.last_event).toBeNull();
    expect(s.last_activity_at).toBeNull();
    expect(s.last_message).toBeNull();
    expect(s.input_tokens).toBe(0);
    expect(s.output_tokens).toBe(0);
    expect(s.total_tokens).toBe(0);
    expect(s.last_reported_input_tokens).toBe(0);
    expect(s.last_reported_output_tokens).toBe(0);
    expect(s.last_reported_total_tokens).toBe(0);
    expect(s.turn_count).toBe(1);
    expect(s.cost_usd).toBe(0);
    expect(s.duration_ms).toBe(0);
  });

  test("accepts null pid", () => {
    const s = createSession("t", "u", null);
    expect(s.process_pid).toBeNull();
  });
});

describe("updateSessionTurnId", () => {
  test("updates turn_id, session_id, and increments turn_count", () => {
    const s = createSession("thread-1", "turn-1", null);
    expect(s.turn_count).toBe(1);

    updateSessionTurnId(s, "turn-2");
    expect(s.turn_id).toBe("turn-2");
    expect(s.session_id).toBe("thread-1-turn-2");
    expect(s.turn_count).toBe(2);
  });
});

describe("updateSessionEvent", () => {
  test("sets last_event and last_activity_at", () => {
    const s = createSession("t", "u", null);
    updateSessionEvent(s, "tool:Bash");

    expect(s.last_event).toBe("tool:Bash");
    expect(s.last_activity_at).toBeInstanceOf(Date);
  });

  test("sets last_message when message provided", () => {
    const s = createSession("t", "u", null);
    updateSessionEvent(s, "assistant", "hello world");
    expect(s.last_message).toBe("hello world");
  });

  test("does not overwrite last_message when message is undefined", () => {
    const s = createSession("t", "u", null);
    updateSessionEvent(s, "assistant", "first");
    updateSessionEvent(s, "tool:Read");
    expect(s.last_message).toBe("first");
  });

  test("truncates message to 500 chars", () => {
    const s = createSession("t", "u", null);
    const longMsg = "x".repeat(600);
    updateSessionEvent(s, "assistant", longMsg);
    expect(s.last_message!.length).toBe(500);
  });
});

describe("updateSessionTokens", () => {
  test("calculates deltas on first report", () => {
    const s = createSession("t", "u", null);
    const deltas = updateSessionTokens(s, {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });

    expect(deltas).toEqual({ delta_input: 100, delta_output: 50, delta_total: 150 });
    expect(s.input_tokens).toBe(100);
    expect(s.output_tokens).toBe(50);
    expect(s.total_tokens).toBe(150);
  });

  test("calculates incremental deltas on subsequent reports", () => {
    const s = createSession("t", "u", null);
    updateSessionTokens(s, { input_tokens: 100, output_tokens: 50, total_tokens: 150 });

    const deltas = updateSessionTokens(s, {
      input_tokens: 250,
      output_tokens: 80,
      total_tokens: 330,
    });

    expect(deltas).toEqual({ delta_input: 150, delta_output: 30, delta_total: 180 });
    expect(s.input_tokens).toBe(250);
    expect(s.output_tokens).toBe(80);
  });

  test("prevents negative deltas (double-counting guard)", () => {
    const s = createSession("t", "u", null);
    updateSessionTokens(s, { input_tokens: 200, output_tokens: 100, total_tokens: 300 });

    // Simulate a lower report (shouldn't happen but guard against it)
    const deltas = updateSessionTokens(s, {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });

    expect(deltas).toEqual({ delta_input: 0, delta_output: 0, delta_total: 0 });
  });

  test("handles missing usage fields", () => {
    const s = createSession("t", "u", null);
    const deltas = updateSessionTokens(s, {});

    expect(deltas).toEqual({ delta_input: 0, delta_output: 0, delta_total: 0 });
    expect(s.input_tokens).toBe(0);
  });
});

describe("createEmptyTotals", () => {
  test("returns zeroed totals", () => {
    const t = createEmptyTotals();
    expect(t).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    });
  });
});

describe("updateTotals", () => {
  test("accumulates deltas", () => {
    const t = createEmptyTotals();

    updateTotals(t, { delta_input: 100, delta_output: 50, delta_total: 150 });
    expect(t.input_tokens).toBe(100);
    expect(t.output_tokens).toBe(50);
    expect(t.total_tokens).toBe(150);

    updateTotals(t, { delta_input: 200, delta_output: 30, delta_total: 230 });
    expect(t.input_tokens).toBe(300);
    expect(t.output_tokens).toBe(80);
    expect(t.total_tokens).toBe(380);
  });
});

describe("parseRateLimits", () => {
  test("extracts valid fields", () => {
    const result = parseRateLimits({
      requests_limit: 100,
      requests_remaining: 95,
      tokens_limit: 50000,
      tokens_remaining: 48000,
    });

    expect(result).toEqual({
      requests_limit: 100,
      requests_remaining: 95,
      tokens_limit: 50000,
      tokens_remaining: 48000,
    });
  });

  test("ignores non-number fields", () => {
    const result = parseRateLimits({
      requests_limit: "not a number",
      requests_remaining: 95,
      extra_field: 42,
    });

    expect(result).toEqual({ requests_remaining: 95 });
  });

  test("returns null for null input", () => {
    expect(parseRateLimits(null)).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(parseRateLimits("string")).toBeNull();
    expect(parseRateLimits(42)).toBeNull();
  });

  test("returns null when no valid fields", () => {
    expect(parseRateLimits({ foo: "bar" })).toBeNull();
  });

  test("returns null for empty object", () => {
    expect(parseRateLimits({})).toBeNull();
  });

  test("extracts all six fields when present", () => {
    const result = parseRateLimits({
      requests_limit: 100,
      requests_remaining: 90,
      requests_reset: 1700000000,
      tokens_limit: 50000,
      tokens_remaining: 45000,
      tokens_reset: 1700000060,
    });

    expect(result).toEqual({
      requests_limit: 100,
      requests_remaining: 90,
      requests_reset: 1700000000,
      tokens_limit: 50000,
      tokens_remaining: 45000,
      tokens_reset: 1700000060,
    });
  });
});
