import { describe, expect, test } from "bun:test";
import { formatTokens, formatDuration, formatElapsed } from "./utils.js";

// ── formatTokens ─────────────────────────────────────────────────

describe("formatTokens", () => {
  test("formats millions", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(10_000_000)).toBe("10.0M");
  });

  test("formats thousands", () => {
    expect(formatTokens(1_000)).toBe("1.0K");
    expect(formatTokens(1_500)).toBe("1.5K");
    expect(formatTokens(999_999)).toBe("1000.0K");
  });

  test("formats small numbers as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  test("boundary: 999 is not K", () => {
    expect(formatTokens(999)).toBe("999");
  });

  test("boundary: 1000 is K", () => {
    expect(formatTokens(1000)).toBe("1.0K");
  });

  test("boundary: 999999 is K not M", () => {
    expect(formatTokens(999_999)).toContain("K");
  });

  test("boundary: 1000000 is M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });
});

// ── formatDuration ───────────────────────────────────────────────

describe("formatDuration", () => {
  test("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1)).toBe("1s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(59)).toBe("59s");
  });

  test("rounds fractional seconds", () => {
    expect(formatDuration(1.4)).toBe("1s");
    expect(formatDuration(1.6)).toBe("2s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(60)).toBe("1m 0s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(330)).toBe("5m 30s");
    expect(formatDuration(3599)).toBe("59m 59s");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(5400)).toBe("1h 30m");
    expect(formatDuration(7200)).toBe("2h 0m");
    expect(formatDuration(8100)).toBe("2h 15m");
  });

  test("large values", () => {
    expect(formatDuration(86400)).toBe("24h 0m");
  });
});

// ── formatElapsed ────────────────────────────────────────────────

describe("formatElapsed", () => {
  test("formats elapsed time from ISO string", () => {
    // 30 seconds ago
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    const result = formatElapsed(thirtySecondsAgo);
    // Should be approximately "30s" (allow ±2s for test execution)
    expect(result).toMatch(/^\d+s$/);
    const seconds = parseInt(result);
    expect(seconds).toBeGreaterThanOrEqual(28);
    expect(seconds).toBeLessThanOrEqual(32);
  });

  test("formats minutes for older timestamps", () => {
    const fiveMinutesAgo = new Date(Date.now() - 300_000).toISOString();
    const result = formatElapsed(fiveMinutesAgo);
    expect(result).toContain("5m");
  });

  test("formats hours for much older timestamps", () => {
    const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();
    const result = formatElapsed(twoHoursAgo);
    expect(result).toContain("2h");
  });
});
