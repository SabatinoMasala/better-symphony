import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition, Issue } from "./types.js";
import {
  buildServiceConfig,
  validateServiceConfig,
  renderPrompt,
  renderSubtaskPrompt,
  renderCronPrompt,
} from "./loader.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeWorkflow(config: any = {}): WorkflowDefinition {
  return { config, prompt_template: "" };
}

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "SYM-42",
    title: "Fix the login bug",
    description: "Users cannot log in with SSO",
    priority: 2,
    state: "In Progress",
    branch_name: "fix/login-sso",
    url: "https://linear.app/team/SYM-42",
    labels: ["bug", "auth"],
    blocked_by: [],
    children: [],
    comments: [{ id: "c1", body: "Urgent fix needed", user: "alice", created_at: null }],
    created_at: new Date("2025-06-01"),
    updated_at: null,
    ...overrides,
  };
}

// ── buildServiceConfig ───────────────────────────────────────────

describe("buildServiceConfig", () => {
  test("returns defaults for empty config", () => {
    const sc = buildServiceConfig(makeWorkflow());

    expect(sc.tracker.kind).toBe("linear");
    expect(sc.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(sc.tracker.terminal_states).toContain("Done");
    expect(sc.tracker.error_states).toEqual(["Error"]);
    expect(sc.polling.interval_ms).toBe(30000);
    expect(sc.agent.binary).toBe("claude");
    expect(sc.agent.mode).toBe("default");
    expect(sc.agent.max_concurrent_agents).toBe(5);
    expect(sc.agent.max_turns).toBe(0);
    expect(sc.agent.max_retries).toBe(3);
    expect(sc.agent.permission_mode).toBe("acceptEdits");
    expect(sc.agent.yolobox).toBe(false);
    expect(sc.agent.yolobox_arguments).toEqual([]);
    expect(sc.agent.append_system_prompt).toBeNull();
    expect(sc.agent.fallback_binary).toBeNull();
    expect(sc.hooks.after_create).toBeNull();
  });

  test("parses tracker kind", () => {
    const sc = buildServiceConfig(makeWorkflow({ tracker: { kind: "github-pr" } }));
    expect(sc.tracker.kind).toBe("github-pr");
  });

  test("throws on invalid tracker kind", () => {
    expect(() =>
      buildServiceConfig(makeWorkflow({ tracker: { kind: "jira" } }))
    ).toThrow("Unsupported tracker kind");
  });

  test("github-pr gets correct default active/terminal states", () => {
    const sc = buildServiceConfig(makeWorkflow({ tracker: { kind: "github-pr" } }));
    expect(sc.tracker.active_states).toEqual(["Open"]);
    expect(sc.tracker.terminal_states).toEqual(["Closed"]);
  });

  test("github-issues gets correct default active/terminal states", () => {
    const sc = buildServiceConfig(makeWorkflow({ tracker: { kind: "github-issues" } }));
    expect(sc.tracker.active_states).toEqual(["open"]);
    expect(sc.tracker.terminal_states).toEqual(["closed"]);
  });

  test("cron gets correct default active/terminal states", () => {
    const sc = buildServiceConfig(makeWorkflow({ tracker: { kind: "cron" } }));
    expect(sc.tracker.active_states).toEqual(["scheduled"]);
    expect(sc.tracker.terminal_states).toEqual(["completed"]);
  });

  test("custom active_states as array", () => {
    const sc = buildServiceConfig(
      makeWorkflow({ tracker: { active_states: ["Ready", "Doing"] } })
    );
    expect(sc.tracker.active_states).toEqual(["Ready", "Doing"]);
  });

  test("custom active_states as CSV string", () => {
    const sc = buildServiceConfig(
      makeWorkflow({ tracker: { active_states: "Ready, Doing" } })
    );
    expect(sc.tracker.active_states).toEqual(["Ready", "Doing"]);
  });

  test("parses integer values from strings", () => {
    const sc = buildServiceConfig(
      makeWorkflow({
        polling: { interval_ms: "60000" },
        agent: { max_turns: "25", max_retries: "5" },
      })
    );
    expect(sc.polling.interval_ms).toBe(60000);
    expect(sc.agent.max_turns).toBe(25);
    expect(sc.agent.max_retries).toBe(5);
  });

  test("falls back to defaults for invalid integer strings", () => {
    const sc = buildServiceConfig(
      makeWorkflow({
        agent: { max_turns: "not_a_number" },
      })
    );
    expect(sc.agent.max_turns).toBe(0); // default
  });

  test("parses per-state concurrency limits", () => {
    const sc = buildServiceConfig(
      makeWorkflow({
        agent: {
          max_concurrent_agents_by_state: {
            "Todo": 2,
            "In Progress": "3",
          },
        },
      })
    );
    expect(sc.agent.max_concurrent_agents_by_state.get("todo")).toBe(2);
    expect(sc.agent.max_concurrent_agents_by_state.get("in progress")).toBe(3);
  });

  test("skips zero-value per-state limits", () => {
    const sc = buildServiceConfig(
      makeWorkflow({
        agent: {
          max_concurrent_agents_by_state: { "Todo": 0 },
        },
      })
    );
    expect(sc.agent.max_concurrent_agents_by_state.has("todo")).toBe(false);
  });

  test("parses binary from harness (deprecated)", () => {
    const sc = buildServiceConfig(makeWorkflow({ agent: { harness: "codex" } }));
    expect(sc.agent.binary).toBe("codex");
  });

  test("binary takes precedence over harness", () => {
    const sc = buildServiceConfig(
      makeWorkflow({ agent: { binary: "codex", harness: "claude" } })
    );
    expect(sc.agent.binary).toBe("codex");
  });

  test("parses ralph_loop mode", () => {
    const sc = buildServiceConfig(makeWorkflow({ agent: { mode: "ralph_loop" } }));
    expect(sc.agent.mode).toBe("ralph_loop");
  });

  test("unknown mode falls back to default", () => {
    const sc = buildServiceConfig(makeWorkflow({ agent: { mode: "unknown" } }));
    expect(sc.agent.mode).toBe("default");
  });

  test("yolobox defaults to false", () => {
    const sc = buildServiceConfig(makeWorkflow());
    expect(sc.agent.yolobox).toBe(false);
  });

  test("yolobox set to true", () => {
    const sc = buildServiceConfig(makeWorkflow({ agent: { yolobox: true } }));
    expect(sc.agent.yolobox).toBe(true);
  });

  test("parses hooks", () => {
    const sc = buildServiceConfig(
      makeWorkflow({
        hooks: {
          after_create: "git clone {{issue.url}}",
          before_run: "npm install",
          timeout_ms: 60000,
        },
      })
    );
    expect(sc.hooks.after_create).toBe("git clone {{issue.url}}");
    expect(sc.hooks.before_run).toBe("npm install");
    expect(sc.hooks.timeout_ms).toBe(60000);
    expect(sc.hooks.after_run).toBeNull();
  });

  test("parses required and excluded labels", () => {
    const sc = buildServiceConfig(
      makeWorkflow({
        tracker: {
          required_labels: ["agent:dev"],
          excluded_labels: "wontfix,duplicate",
        },
      })
    );
    expect(sc.tracker.required_labels).toEqual(["agent:dev"]);
    expect(sc.tracker.excluded_labels).toEqual(["wontfix", "duplicate"]);
  });

  test("fallback_binary parses correctly", () => {
    const sc = buildServiceConfig(makeWorkflow({ agent: { fallback_binary: "codex" } }));
    expect(sc.agent.fallback_binary).toBe("codex");
  });
});

// ── validateServiceConfig ────────────────────────────────────────

describe("validateServiceConfig", () => {
  test("valid linear config", () => {
    const sc = buildServiceConfig(
      makeWorkflow({
        tracker: { kind: "linear", api_key: "key", project_slug: "proj" },
      })
    );
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("linear without api_key is invalid", () => {
    const sc = buildServiceConfig(makeWorkflow({ tracker: { kind: "linear" } }));
    // api_key might come from env, force empty
    sc.tracker.api_key = "";
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("api_key"))).toBe(true);
  });

  test("linear without project_slug is invalid", () => {
    const sc = buildServiceConfig(
      makeWorkflow({ tracker: { kind: "linear", api_key: "key" } })
    );
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("project_slug"))).toBe(true);
  });

  test("github-pr without repo is invalid", () => {
    const sc = buildServiceConfig(makeWorkflow({ tracker: { kind: "github-pr" } }));
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("repo"))).toBe(true);
  });

  test("github-issues without repo is invalid", () => {
    const sc = buildServiceConfig(makeWorkflow({ tracker: { kind: "github-issues" } }));
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("repo"))).toBe(true);
  });

  test("github-pr with repo is valid", () => {
    const sc = buildServiceConfig(
      makeWorkflow({ tracker: { kind: "github-pr", repo: "owner/repo" } })
    );
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(true);
  });

  test("cron without schedule is invalid", () => {
    const sc = buildServiceConfig(makeWorkflow({ tracker: { kind: "cron" } }));
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schedule"))).toBe(true);
  });

  test("cron with schedule is valid", () => {
    const sc = buildServiceConfig(
      makeWorkflow({ tracker: { kind: "cron", schedule: "*/5 * * * *" } })
    );
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(true);
  });

  test("invalid binary is flagged", () => {
    const sc = buildServiceConfig(makeWorkflow({ agent: { binary: "claude" } }));
    sc.agent.binary = "invalid" as any;
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("binary"))).toBe(true);
  });

  test("invalid fallback_binary is flagged", () => {
    const sc = buildServiceConfig(makeWorkflow({ agent: { binary: "claude" } }));
    sc.agent.fallback_binary = "invalid" as any;
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fallback_binary"))).toBe(true);
  });

  test("codex binary is valid", () => {
    const sc = buildServiceConfig(makeWorkflow({
      tracker: { kind: "github-pr", repo: "o/r" },
      agent: { binary: "codex" },
    }));
    const result = validateServiceConfig(sc);
    expect(result.valid).toBe(true);
  });
});

// ── renderPrompt ─────────────────────────────────────────────────

describe("renderPrompt", () => {
  test("renders issue fields into template", async () => {
    const template = "Fix: {{ issue.title }} ({{ issue.identifier }})";
    const result = await renderPrompt(template, makeIssue(), 1);
    expect(result).toBe("Fix: Fix the login bug (SYM-42)");
  });

  test("renders description", async () => {
    const template = "{{ issue.description }}";
    const result = await renderPrompt(template, makeIssue(), null);
    expect(result).toBe("Users cannot log in with SSO");
  });

  test("renders attempt number", async () => {
    const template = "Attempt: {{ attempt }}";
    const result = await renderPrompt(template, makeIssue(), 3);
    expect(result).toBe("Attempt: 3");
  });

  test("renders labels", async () => {
    const template = "Labels: {{ issue.labels | join: ', ' }}";
    const result = await renderPrompt(template, makeIssue(), null);
    expect(result).toBe("Labels: bug, auth");
  });

  test("empty template returns default prompt", async () => {
    const result = await renderPrompt("", makeIssue(), null);
    expect(result).toContain("working on an issue");
  });

  test("whitespace-only template returns default prompt", async () => {
    const result = await renderPrompt("   \n  ", makeIssue(), null);
    expect(result).toContain("working on an issue");
  });

  test("throws on invalid template syntax", async () => {
    const template = "{{ issue.nonexistent_var }}";
    await expect(renderPrompt(template, makeIssue(), null)).rejects.toThrow();
  });

  test("renders comments", async () => {
    const template = "{% for c in issue.comments %}{{ c.body }}{% endfor %}";
    const result = await renderPrompt(template, makeIssue(), null);
    expect(result).toBe("Urgent fix needed");
  });
});

// ── renderSubtaskPrompt ──────────────────────────────────────────

describe("renderSubtaskPrompt", () => {
  test("renders subtask context", async () => {
    const template = "Subtask {{ subtask_index }}/{{ total_subtasks }}: {{ subtask.title }}";
    const subtask = {
      id: "sub-1",
      identifier: "SYM-43",
      title: "Fix SSO callback",
      description: null,
      priority: null,
      state: "Todo",
      state_type: "unstarted",
      sort_order: 1,
      assignee: null,
      created_at: null,
      updated_at: null,
    };

    const result = await renderSubtaskPrompt(template, makeIssue(), subtask, 1, 3, null);
    expect(result).toBe("Subtask 1/3: Fix SSO callback");
  });

  test("renders is_first_subtask and is_last_subtask", async () => {
    const template = "first={{ is_first_subtask }} last={{ is_last_subtask }}";
    const subtask = {
      id: "s", identifier: "S-1", title: "T", description: null,
      priority: null, state: "Todo", state_type: "unstarted",
      sort_order: 1, assignee: null, created_at: null, updated_at: null,
    };

    const first = await renderSubtaskPrompt(template, makeIssue(), subtask, 1, 3, null);
    expect(first).toBe("first=true last=false");

    const last = await renderSubtaskPrompt(template, makeIssue(), subtask, 3, 3, null);
    expect(last).toBe("first=false last=true");
  });

  test("empty template returns default", async () => {
    const subtask = {
      id: "s", identifier: "SYM-43", title: "Do stuff", description: null,
      priority: null, state: "Todo", state_type: "unstarted",
      sort_order: 1, assignee: null, created_at: null, updated_at: null,
    };
    const result = await renderSubtaskPrompt("", makeIssue(), subtask, 1, 1, null);
    expect(result).toContain("SYM-43");
    expect(result).toContain("Do stuff");
  });
});

// ── renderCronPrompt ─────────────────────────────────────────────

describe("renderCronPrompt", () => {
  test("renders cron context", async () => {
    const template = "Run #{{ cron.run_number }} at {{ cron.scheduled_at }}";
    const cronCtx = {
      schedule: "*/5 * * * *",
      run_number: 7,
      scheduled_at: "2025-06-01T09:00:00Z",
      triggered_at: "2025-06-01T09:00:01Z",
    };

    const result = await renderCronPrompt(template, cronCtx, makeIssue(), null);
    expect(result).toBe("Run #7 at 2025-06-01T09:00:00Z");
  });

  test("empty template returns default", async () => {
    const cronCtx = {
      schedule: "0 9 * * 1-5",
      run_number: 3,
      scheduled_at: "2025-06-01T09:00:00Z",
      triggered_at: "2025-06-01T09:00:01Z",
    };
    const result = await renderCronPrompt("", cronCtx, makeIssue(), null);
    expect(result).toContain("#3");
    expect(result).toContain("0 9 * * 1-5");
  });
});
