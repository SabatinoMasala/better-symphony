import { describe, expect, test } from "bun:test";
import type { Issue, ServiceConfig, OrchestratorState, RunAttempt, RunningEntry } from "../config/types.js";
import {
  selectCandidates,
  sortByDispatchPriority,
  getAvailableSlots,
  calculateBackoffDelay,
  CONTINUATION_RETRY_DELAY_MS,
} from "./scheduler.js";
import { createOrchestratorState, addRunning, claimIssue } from "./state.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "SYM-1",
    title: "Test issue",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    children: [],
    comments: [],
    created_at: new Date("2025-01-01"),
    updated_at: null,
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<ServiceConfig["agent"]> & {
  tracker?: Partial<ServiceConfig["tracker"]>;
}): ServiceConfig {
  const { tracker: trackerOverrides, ...agentOverrides } = overrides ?? {};
  return {
    tracker: {
      kind: "linear",
      endpoint: "",
      api_key: "key",
      project_slug: "proj",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Closed"],
      error_states: ["Error"],
      repo: "",
      schedule: "",
      required_labels: [],
      excluded_labels: [],
      ...trackerOverrides,
    },
    polling: { interval_ms: 30000 },
    workspace: { root: "/tmp" },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 30000,
    },
    agent: {
      binary: "claude",
      mode: "default",
      max_concurrent_agents: 5,
      max_turns: 0,
      max_retries: 3,
      max_retry_backoff_ms: 600000,
      max_concurrent_agents_by_state: new Map(),
      turn_timeout_ms: 600000,
      stall_timeout_ms: 300000,
      max_iterations: 0,
      yolobox: false,
      yolobox_arguments: [],
      permission_mode: "acceptEdits",
      append_system_prompt: null,
      fallback_binary: null,
      ...agentOverrides,
    },
  };
}

function makeRunningEntry(issue: Issue): RunningEntry {
  return {
    issue,
    attempt: {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt: 1,
      workspace_path: "/tmp/ws",
      started_at: new Date(),
      status: "StreamingTurn",
    } as RunAttempt,
    session: null,
    worker: Promise.resolve(),
    abortController: new AbortController(),
  };
}

// ── selectCandidates ─────────────────────────────────────────────

describe("selectCandidates", () => {
  test("returns eligible issues in active state", () => {
    const issues = [
      makeIssue({ id: "a", identifier: "SYM-1", state: "Todo" }),
      makeIssue({ id: "b", identifier: "SYM-2", state: "In Progress" }),
    ];
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig();

    const result = selectCandidates(issues, state, config);
    expect(result.eligible).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  test("skips issues not in active state", () => {
    const issues = [
      makeIssue({ id: "a", state: "Done" }),
      makeIssue({ id: "b", state: "Backlog" }),
    ];
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig();

    const result = selectCandidates(issues, state, config);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("not in active states");
  });

  test("skips issues missing required fields", () => {
    const issues = [
      makeIssue({ id: "", state: "Todo" }),
      makeIssue({ id: "a", identifier: "", state: "Todo" }),
      makeIssue({ id: "b", title: "", state: "Todo" }),
      makeIssue({ id: "c", state: "" }),
    ];
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig();

    const result = selectCandidates(issues, state, config);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped).toHaveLength(4);
    for (const s of result.skipped) {
      expect(s.reason).toContain("missing required fields");
    }
  });

  test("skips already running issues", () => {
    const issue = makeIssue({ id: "a", state: "Todo" });
    const state = createOrchestratorState(30000, 5);
    addRunning(state, makeRunningEntry(issue));

    const result = selectCandidates([issue], state, makeConfig());
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped[0].reason).toBe("already running");
  });

  test("skips already claimed issues", () => {
    const issue = makeIssue({ id: "a", state: "Todo" });
    const state = createOrchestratorState(30000, 5);
    claimIssue(state, "a");

    const result = selectCandidates([issue], state, makeConfig());
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped[0].reason).toBe("already claimed");
  });

  test("skips when global concurrency limit reached", () => {
    const state = createOrchestratorState(30000, 1);
    const running = makeIssue({ id: "r", state: "Todo" });
    addRunning(state, makeRunningEntry(running));

    const candidate = makeIssue({ id: "c", state: "Todo" });
    const config = makeConfig({ max_concurrent_agents: 1 });

    const result = selectCandidates([candidate], state, config);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("global concurrency");
  });

  test("skips when per-state concurrency limit reached", () => {
    const state = createOrchestratorState(30000, 5);
    const running = makeIssue({ id: "r", state: "Todo" });
    addRunning(state, makeRunningEntry(running));

    const candidate = makeIssue({ id: "c", state: "Todo" });
    const byState = new Map([["todo", 1]]);
    const config = makeConfig({ max_concurrent_agents_by_state: byState });

    const result = selectCandidates([candidate], state, config);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("per-state concurrency");
  });

  test("skips Todo issues blocked by non-terminal blockers", () => {
    const issue = makeIssue({
      id: "a",
      state: "Todo",
      blocked_by: [
        { id: "blocker-1", identifier: "SYM-99", state: "In Progress" },
      ],
    });
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig();

    const result = selectCandidates([issue], state, config);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("blocked by SYM-99");
  });

  test("allows Todo issues when blocker is in terminal state", () => {
    const issue = makeIssue({
      id: "a",
      state: "Todo",
      blocked_by: [
        { id: "blocker-1", identifier: "SYM-99", state: "Done" },
      ],
    });
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig();

    const result = selectCandidates([issue], state, config);
    expect(result.eligible).toHaveLength(1);
  });

  test("skips issues with symphony:error label", () => {
    const issue = makeIssue({ id: "a", state: "Todo", labels: ["symphony:error"] });
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig();

    const result = selectCandidates([issue], state, config);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("symphony:error");
  });

  test("symphony:error label check is case-insensitive", () => {
    const issue = makeIssue({ id: "a", state: "Todo", labels: ["Symphony:Error"] });
    const state = createOrchestratorState(30000, 5);

    const result = selectCandidates([issue], state, makeConfig());
    expect(result.eligible).toHaveLength(0);
  });

  test("skips issues missing required labels", () => {
    const issue = makeIssue({ id: "a", state: "Todo", labels: ["agent:dev"] });
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig({ tracker: { required_labels: ["agent:dev", "priority:high"] } });

    const result = selectCandidates([issue], state, config);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped[0].reason).toContain('missing required label "priority:high"');
  });

  test("passes when all required labels present", () => {
    const issue = makeIssue({ id: "a", state: "Todo", labels: ["agent:dev", "priority:high"] });
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig({ tracker: { required_labels: ["agent:dev", "priority:high"] } });

    const result = selectCandidates([issue], state, config);
    expect(result.eligible).toHaveLength(1);
  });

  test("skips issues with excluded labels", () => {
    const issue = makeIssue({ id: "a", state: "Todo", labels: ["wontfix"] });
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig({ tracker: { excluded_labels: ["wontfix"] } });

    const result = selectCandidates([issue], state, config);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped[0].reason).toContain('excluded label "wontfix"');
  });

  test("eligible results are sorted by dispatch priority", () => {
    const issues = [
      makeIssue({ id: "a", identifier: "SYM-3", state: "Todo", priority: 3 }),
      makeIssue({ id: "b", identifier: "SYM-1", state: "Todo", priority: 1 }),
      makeIssue({ id: "c", identifier: "SYM-2", state: "Todo", priority: 2 }),
    ];
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig();

    const result = selectCandidates(issues, state, config);
    expect(result.eligible.map((i) => i.priority)).toEqual([1, 2, 3]);
  });

  test("active state matching is case-insensitive", () => {
    const issue = makeIssue({ id: "a", state: "todo" }); // lowercase
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig(); // active_states: ["Todo", "In Progress"]

    const result = selectCandidates([issue], state, config);
    expect(result.eligible).toHaveLength(1);
  });
});

// ── sortByDispatchPriority ───────────────────────────────────────

describe("sortByDispatchPriority", () => {
  test("sorts by priority ascending (lower is better)", () => {
    const issues = [
      makeIssue({ priority: 3 }),
      makeIssue({ priority: 1 }),
      makeIssue({ priority: 2 }),
    ];
    sortByDispatchPriority(issues);
    expect(issues.map((i) => i.priority)).toEqual([1, 2, 3]);
  });

  test("null priority sorts last", () => {
    const issues = [
      makeIssue({ priority: null, identifier: "A" }),
      makeIssue({ priority: 2, identifier: "B" }),
      makeIssue({ priority: 1, identifier: "C" }),
    ];
    sortByDispatchPriority(issues);
    expect(issues.map((i) => i.identifier)).toEqual(["C", "B", "A"]);
  });

  test("same priority: sorts by created_at oldest first", () => {
    const issues = [
      makeIssue({ priority: 1, created_at: new Date("2025-03-01"), identifier: "NEW" }),
      makeIssue({ priority: 1, created_at: new Date("2025-01-01"), identifier: "OLD" }),
    ];
    sortByDispatchPriority(issues);
    expect(issues.map((i) => i.identifier)).toEqual(["OLD", "NEW"]);
  });

  test("same priority + same created_at: sorts by identifier", () => {
    const d = new Date("2025-01-01");
    const issues = [
      makeIssue({ priority: 1, created_at: d, identifier: "SYM-3" }),
      makeIssue({ priority: 1, created_at: d, identifier: "SYM-1" }),
      makeIssue({ priority: 1, created_at: d, identifier: "SYM-2" }),
    ];
    sortByDispatchPriority(issues);
    expect(issues.map((i) => i.identifier)).toEqual(["SYM-1", "SYM-2", "SYM-3"]);
  });

  test("empty array is a no-op", () => {
    const issues: Issue[] = [];
    sortByDispatchPriority(issues);
    expect(issues).toHaveLength(0);
  });

  test("single element array", () => {
    const issues = [makeIssue()];
    sortByDispatchPriority(issues);
    expect(issues).toHaveLength(1);
  });
});

// ── getAvailableSlots ────────────────────────────────────────────

describe("getAvailableSlots", () => {
  test("returns max when nothing running", () => {
    const state = createOrchestratorState(30000, 5);
    const config = makeConfig({ max_concurrent_agents: 5 });
    expect(getAvailableSlots(state, config)).toBe(5);
  });

  test("returns remaining slots", () => {
    const state = createOrchestratorState(30000, 5);
    addRunning(state, makeRunningEntry(makeIssue({ id: "a" })));
    addRunning(state, makeRunningEntry(makeIssue({ id: "b" })));
    const config = makeConfig({ max_concurrent_agents: 5 });
    expect(getAvailableSlots(state, config)).toBe(3);
  });

  test("returns 0 when at capacity", () => {
    const state = createOrchestratorState(30000, 1);
    addRunning(state, makeRunningEntry(makeIssue({ id: "a" })));
    const config = makeConfig({ max_concurrent_agents: 1 });
    expect(getAvailableSlots(state, config)).toBe(0);
  });

  test("never returns negative", () => {
    const state = createOrchestratorState(30000, 1);
    addRunning(state, makeRunningEntry(makeIssue({ id: "a" })));
    addRunning(state, makeRunningEntry(makeIssue({ id: "b" })));
    // Max is 1 but 2 are running (edge case)
    const config = makeConfig({ max_concurrent_agents: 1 });
    expect(getAvailableSlots(state, config)).toBe(0);
  });
});

// ── calculateBackoffDelay ────────────────────────────────────────

describe("calculateBackoffDelay", () => {
  test("first attempt: 10s", () => {
    expect(calculateBackoffDelay(1, 600000)).toBe(10000);
  });

  test("second attempt: 20s", () => {
    expect(calculateBackoffDelay(2, 600000)).toBe(20000);
  });

  test("third attempt: 40s", () => {
    expect(calculateBackoffDelay(3, 600000)).toBe(40000);
  });

  test("caps at maxBackoffMs", () => {
    expect(calculateBackoffDelay(10, 60000)).toBe(60000);
  });

  test("large attempt number caps at max", () => {
    expect(calculateBackoffDelay(100, 600000)).toBe(600000);
  });
});

// ── Constants ────────────────────────────────────────────────────

describe("constants", () => {
  test("CONTINUATION_RETRY_DELAY_MS is 1000", () => {
    expect(CONTINUATION_RETRY_DELAY_MS).toBe(1000);
  });
});
