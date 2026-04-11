import { describe, expect, test } from "bun:test";
import type {
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  Issue,
  RunAttempt,
} from "../config/types.js";
import {
  createOrchestratorState,
  claimIssue,
  releaseClaim,
  isIssueClaimed,
  addRunning,
  removeRunning,
  getRunning,
  isIssueRunning,
  getRunningCount,
  getRunningByState,
  addRetry,
  removeRetry,
  getRetry,
  updateTotals,
  updateRateLimits,
  createSnapshot,
} from "./state.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "SYM-1",
    title: "Test",
    description: null,
    priority: null,
    state: "In Progress",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    children: [],
    comments: [],
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function makeRunningEntry(overrides?: {
  issue?: Partial<Issue>;
  startedAt?: Date;
}): RunningEntry {
  const issue = makeIssue(overrides?.issue);
  return {
    issue,
    attempt: {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt: 1,
      workspace_path: "/tmp/ws",
      started_at: overrides?.startedAt ?? new Date(),
      status: "StreamingTurn",
    } as RunAttempt,
    session: null,
    worker: Promise.resolve(),
    abortController: new AbortController(),
  };
}

function makeRetryEntry(issueId: string, overrides?: Partial<RetryEntry>): RetryEntry {
  return {
    issue_id: issueId,
    identifier: `SYM-${issueId}`,
    attempt: 1,
    due_at_ms: Date.now() + 10000,
    timer_handle: setTimeout(() => {}, 99999),
    error: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("createOrchestratorState", () => {
  test("returns correct shape and defaults", () => {
    const s = createOrchestratorState(30000, 5);

    expect(s.poll_interval_ms).toBe(30000);
    expect(s.max_concurrent_agents).toBe(5);
    expect(s.running.size).toBe(0);
    expect(s.claimed.size).toBe(0);
    expect(s.retry_attempts.size).toBe(0);
    expect(s.completed.size).toBe(0);
    expect(s.token_totals.input_tokens).toBe(0);
    expect(s.token_totals.output_tokens).toBe(0);
    expect(s.token_totals.total_tokens).toBe(0);
    expect(s.token_totals.seconds_running).toBe(0);
    expect(s.rate_limits).toBeNull();
    expect(s.ended_seconds).toBe(0);
  });
});

describe("claim management", () => {
  test("claimIssue succeeds on first claim", () => {
    const s = createOrchestratorState(30000, 5);
    expect(claimIssue(s, "a")).toBe(true);
    expect(s.claimed.has("a")).toBe(true);
  });

  test("claimIssue returns false on duplicate", () => {
    const s = createOrchestratorState(30000, 5);
    claimIssue(s, "a");
    expect(claimIssue(s, "a")).toBe(false);
  });

  test("releaseClaim removes claim", () => {
    const s = createOrchestratorState(30000, 5);
    claimIssue(s, "a");
    releaseClaim(s, "a");
    expect(s.claimed.has("a")).toBe(false);
  });

  test("releaseClaim on unclaimed id is a no-op", () => {
    const s = createOrchestratorState(30000, 5);
    releaseClaim(s, "nonexistent"); // should not throw
    expect(s.claimed.size).toBe(0);
  });

  test("isIssueClaimed", () => {
    const s = createOrchestratorState(30000, 5);
    expect(isIssueClaimed(s, "a")).toBe(false);
    claimIssue(s, "a");
    expect(isIssueClaimed(s, "a")).toBe(true);
  });

  test("claim and release cycle allows re-claim", () => {
    const s = createOrchestratorState(30000, 5);
    claimIssue(s, "a");
    releaseClaim(s, "a");
    expect(claimIssue(s, "a")).toBe(true);
  });
});

describe("running management", () => {
  test("addRunning and getRunning", () => {
    const s = createOrchestratorState(30000, 5);
    const entry = makeRunningEntry({ issue: { id: "x" } });
    addRunning(s, entry);

    expect(getRunning(s, "x")).toBe(entry);
    expect(isIssueRunning(s, "x")).toBe(true);
    expect(getRunningCount(s)).toBe(1);
  });

  test("getRunning returns undefined for unknown id", () => {
    const s = createOrchestratorState(30000, 5);
    expect(getRunning(s, "nope")).toBeUndefined();
  });

  test("isIssueRunning returns false for unknown id", () => {
    const s = createOrchestratorState(30000, 5);
    expect(isIssueRunning(s, "nope")).toBe(false);
  });

  test("removeRunning returns and deletes entry", () => {
    const s = createOrchestratorState(30000, 5);
    const entry = makeRunningEntry({ issue: { id: "x" } });
    addRunning(s, entry);

    const removed = removeRunning(s, "x");
    expect(removed).toBe(entry);
    expect(isIssueRunning(s, "x")).toBe(false);
    expect(getRunningCount(s)).toBe(0);
  });

  test("removeRunning accumulates ended_seconds", () => {
    const s = createOrchestratorState(30000, 5);
    const startedAt = new Date(Date.now() - 5000); // 5 seconds ago
    const entry = makeRunningEntry({ issue: { id: "x" }, startedAt });
    addRunning(s, entry);

    removeRunning(s, "x");
    // Should have accumulated ~5 seconds (allow some tolerance)
    expect(s.ended_seconds).toBeGreaterThan(4);
    expect(s.ended_seconds).toBeLessThan(7);
  });

  test("removeRunning returns undefined for unknown id", () => {
    const s = createOrchestratorState(30000, 5);
    expect(removeRunning(s, "nope")).toBeUndefined();
  });

  test("getRunningByState counts correctly", () => {
    const s = createOrchestratorState(30000, 5);
    addRunning(s, makeRunningEntry({ issue: { id: "a", state: "In Progress" } }));
    addRunning(s, makeRunningEntry({ issue: { id: "b", state: "In Progress" } }));
    addRunning(s, makeRunningEntry({ issue: { id: "c", state: "Todo" } }));

    expect(getRunningByState(s, "In Progress")).toBe(2);
    expect(getRunningByState(s, "Todo")).toBe(1);
    expect(getRunningByState(s, "Done")).toBe(0);
  });

  test("getRunningByState is case-insensitive", () => {
    const s = createOrchestratorState(30000, 5);
    addRunning(s, makeRunningEntry({ issue: { id: "a", state: "In Progress" } }));

    expect(getRunningByState(s, "in progress")).toBe(1);
    expect(getRunningByState(s, "IN PROGRESS")).toBe(1);
  });
});

describe("retry management", () => {
  test("addRetry and getRetry", () => {
    const s = createOrchestratorState(30000, 5);
    const entry = makeRetryEntry("x");
    addRetry(s, entry);

    expect(getRetry(s, "x")).toBe(entry);
  });

  test("addRetry replaces existing retry and clears old timer", () => {
    const s = createOrchestratorState(30000, 5);
    const entry1 = makeRetryEntry("x", { attempt: 1 });
    const entry2 = makeRetryEntry("x", { attempt: 2 });

    addRetry(s, entry1);
    addRetry(s, entry2);

    expect(getRetry(s, "x")?.attempt).toBe(2);
    expect(s.retry_attempts.size).toBe(1);
  });

  test("removeRetry returns and deletes entry", () => {
    const s = createOrchestratorState(30000, 5);
    const entry = makeRetryEntry("x");
    addRetry(s, entry);

    const removed = removeRetry(s, "x");
    expect(removed).toBe(entry);
    expect(getRetry(s, "x")).toBeUndefined();
  });

  test("removeRetry returns undefined for unknown id", () => {
    const s = createOrchestratorState(30000, 5);
    expect(removeRetry(s, "nope")).toBeUndefined();
  });
});

describe("updateTotals", () => {
  test("accumulates deltas", () => {
    const s = createOrchestratorState(30000, 5);
    updateTotals(s, { delta_input: 100, delta_output: 50, delta_total: 150 });
    updateTotals(s, { delta_input: 200, delta_output: 30, delta_total: 230 });

    expect(s.token_totals.input_tokens).toBe(300);
    expect(s.token_totals.output_tokens).toBe(80);
    expect(s.token_totals.total_tokens).toBe(380);
  });
});

describe("updateRateLimits", () => {
  test("sets rate limits", () => {
    const s = createOrchestratorState(30000, 5);
    const limits = { requests_limit: 100, requests_remaining: 90 };
    updateRateLimits(s, limits);
    expect(s.rate_limits).toBe(limits);
  });

  test("overwrites previous limits", () => {
    const s = createOrchestratorState(30000, 5);
    updateRateLimits(s, { requests_limit: 100 });
    updateRateLimits(s, { requests_limit: 200 });
    expect(s.rate_limits?.requests_limit).toBe(200);
  });
});

describe("createSnapshot", () => {
  test("empty state produces empty snapshot", () => {
    const s = createOrchestratorState(30000, 5);
    const snap = createSnapshot(s, "my-workflow");

    expect(snap.running).toHaveLength(0);
    expect(snap.retrying).toHaveLength(0);
    expect(snap.workflows).toHaveLength(1);
    expect(snap.workflows[0].name).toBe("my-workflow");
    expect(snap.workflows[0].max_concurrent_agents).toBe(5);
    expect(snap.workflows[0].running_count).toBe(0);
    expect(snap.workflows[0].is_cron).toBe(false);
    expect(snap.token_totals.input_tokens).toBe(0);
    expect(snap.rate_limits).toBeNull();
  });

  test("snapshot includes running entries", () => {
    const s = createOrchestratorState(30000, 5);
    addRunning(
      s,
      makeRunningEntry({ issue: { id: "a", identifier: "SYM-1", state: "In Progress" } })
    );

    const snap = createSnapshot(s, "wf");
    expect(snap.running).toHaveLength(1);
    expect(snap.running[0].issue_id).toBe("a");
    expect(snap.running[0].issue_identifier).toBe("SYM-1");
    expect(snap.running[0].state).toBe("In Progress");
    expect(snap.running[0].workflow).toBe("wf");
    expect(snap.workflows[0].running_count).toBe(1);
  });

  test("snapshot includes retry entries", () => {
    const s = createOrchestratorState(30000, 5);
    const dueAt = Date.now() + 5000;
    addRetry(s, makeRetryEntry("r1", { identifier: "SYM-99", attempt: 2, due_at_ms: dueAt, error: "timeout" }));

    const snap = createSnapshot(s, "wf");
    expect(snap.retrying).toHaveLength(1);
    expect(snap.retrying[0].issue_id).toBe("r1");
    expect(snap.retrying[0].identifier).toBe("SYM-99");
    expect(snap.retrying[0].attempt).toBe(2);
    expect(snap.retrying[0].error).toBe("timeout");
    expect(snap.retrying[0].workflow).toBe("wf");
  });

  test("snapshot accumulates seconds_running from active + ended", () => {
    const s = createOrchestratorState(30000, 5);
    s.ended_seconds = 10;

    // Add a running entry started 2 seconds ago
    const startedAt = new Date(Date.now() - 2000);
    addRunning(s, makeRunningEntry({ issue: { id: "a" }, startedAt }));

    const snap = createSnapshot(s);
    // Should be ~12 seconds (10 ended + ~2 active)
    expect(snap.token_totals.seconds_running).toBeGreaterThan(11);
    expect(snap.token_totals.seconds_running).toBeLessThan(14);
  });

  test("snapshot uses default workflow name when null", () => {
    const s = createOrchestratorState(30000, 5);
    const snap = createSnapshot(s);
    expect(snap.workflows[0].name).toBe("default");
  });

  test("snapshot respects isCron flag", () => {
    const s = createOrchestratorState(30000, 5);
    const snap = createSnapshot(s, "cron-wf", true);
    expect(snap.workflows[0].is_cron).toBe(true);
  });

  test("snapshot includes token totals", () => {
    const s = createOrchestratorState(30000, 5);
    updateTotals(s, { delta_input: 500, delta_output: 200, delta_total: 700 });

    const snap = createSnapshot(s);
    expect(snap.token_totals.input_tokens).toBe(500);
    expect(snap.token_totals.output_tokens).toBe(200);
    expect(snap.token_totals.total_tokens).toBe(700);
  });

  test("snapshot includes rate limits", () => {
    const s = createOrchestratorState(30000, 5);
    updateRateLimits(s, { tokens_remaining: 42000 });

    const snap = createSnapshot(s);
    expect(snap.rate_limits?.tokens_remaining).toBe(42000);
  });
});
