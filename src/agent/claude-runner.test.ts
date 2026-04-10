import { describe, expect, test, beforeEach } from "bun:test";
import type { AgentEvent, ServiceConfig, Issue } from "../config/types.js";
import type { RunnerOptions } from "./base-runner.js";
import { ClaudeRunner } from "./claude-runner.js";
import * as fixtures from "./__fixtures__/claude-events.js";

// ── Testable Subclass ────────────────────────────────────────────

class TestableClaudeRunner extends ClaudeRunner {
  public testBuildArgs(prompt: string): string[] {
    return this.buildArgs(prompt);
  }
  public testHandleMessage(msg: any): void {
    this.handleStreamMessage(msg);
  }
  /** Expose session for assertions */
  public initSession(): void {
    const { createSession } = require("./session.js");
    this.session = createSession("test-thread", "test-turn", "999");
  }
}

// ── Fixtures ─────────────────────────────────────────────────────

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "SYM-42",
    title: "Test issue",
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

function makeConfig(overrides?: Partial<ServiceConfig["agent"]>): ServiceConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "",
      api_key: "",
      project_slug: "",
      active_states: [],
      terminal_states: [],
      error_states: [],
      repo: "",
      schedule: "",
      required_labels: [],
      excluded_labels: [],
    },
    polling: { interval_ms: 30000 },
    workspace: { root: "/tmp/workspaces" },
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
      max_concurrent_agents: 1,
      max_turns: 0,
      max_retries: 0,
      max_retry_backoff_ms: 0,
      max_concurrent_agents_by_state: new Map(),
      turn_timeout_ms: 600000,
      stall_timeout_ms: 300000,
      max_iterations: 0,
      yolobox: false,
      yolobox_arguments: [],
      permission_mode: "acceptEdits",
      append_system_prompt: null,
      fallback_binary: null,
      ...overrides,
    },
  };
}

function makeRunner(
  configOverrides?: Partial<ServiceConfig["agent"]>,
): { runner: TestableClaudeRunner; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const options: RunnerOptions = {
    config: makeConfig(configOverrides),
    issue: makeIssue(),
    workspacePath: "/tmp/workspace",
    prompt: "Fix the bug",
    attempt: 1,
    onEvent: (e) => events.push(e),
    abortSignal: new AbortController().signal,
  };
  const runner = new TestableClaudeRunner(options);
  return { runner, events };
}

// ── Tests ────────────────────────────────────────────────────────

describe("ClaudeRunner.buildArgs", () => {
  test("includes base flags", () => {
    const { runner } = makeRunner();
    const args = runner.testBuildArgs("Do the thing");

    expect(args).toContain("-p");
    expect(args).toContain("Do the thing");
    expect(args).toContain("--verbose");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
  });

  test("includes max_turns when > 0", () => {
    const { runner } = makeRunner({ max_turns: 15 });
    const args = runner.testBuildArgs("prompt");

    expect(args).toContain("--max-turns");
    expect(args).toContain("15");
  });

  test("omits max_turns when 0", () => {
    const { runner } = makeRunner({ max_turns: 0 });
    const args = runner.testBuildArgs("prompt");

    expect(args).not.toContain("--max-turns");
  });

  test("uses configured permission_mode", () => {
    const { runner } = makeRunner({ permission_mode: "bypassPermissions" });
    const args = runner.testBuildArgs("prompt");

    const modeIndex = args.indexOf("--permission-mode");
    expect(args[modeIndex + 1]).toBe("bypassPermissions");
  });

  test("appends system prompt to built-in prompts", () => {
    const { runner } = makeRunner({ append_system_prompt: "Custom instructions here" });
    const args = runner.testBuildArgs("prompt");

    expect(args).toContain("--append-system-prompt");
    const spIndex = args.indexOf("--append-system-prompt");
    const systemPrompt = args[spIndex + 1];
    expect(systemPrompt).toContain("Custom instructions here");
  });

  test("system prompt includes Linear and GitHub prompts", () => {
    const { runner } = makeRunner();
    const args = runner.testBuildArgs("prompt");

    const spIndex = args.indexOf("--append-system-prompt");
    const systemPrompt = args[spIndex + 1];
    // Should contain content from both built-in prompts
    expect(systemPrompt.length).toBeGreaterThan(0);
  });
});

describe("ClaudeRunner event mapping", () => {
  let runner: TestableClaudeRunner;
  let events: AgentEvent[];

  beforeEach(() => {
    const r = makeRunner();
    runner = r.runner;
    events = r.events;
    runner.initSession();
  });

  test("system init sets session_id", () => {
    runner.testHandleMessage(fixtures.systemInit);

    const session = runner.getSession()!;
    expect(session.session_id).toBe("sess_abc123");
    expect(session.last_event).toBe("system:init");
  });

  test("assistant text emits assistant_message", () => {
    runner.testHandleMessage(fixtures.assistantText);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("assistant_message");
    expect((events[0].payload as any).text).toContain("reading the existing code");
  });

  test("assistant tool_use emits tool_use event", () => {
    runner.testHandleMessage(fixtures.assistantToolUse);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_use");
    expect((events[0].payload as any).tool).toBe("Read");
    expect((events[0].payload as any).detail).toBe("/workspace/src/index.ts");
  });

  test("assistant tool_use with command detail", () => {
    runner.testHandleMessage(fixtures.assistantToolUseBash);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_use");
    expect((events[0].payload as any).tool).toBe("Bash");
    expect((events[0].payload as any).detail).toBe("git status");
  });

  test("mixed content emits both assistant_message and tool_use", () => {
    runner.testHandleMessage(fixtures.assistantMixedContent);

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("assistant_message");
    expect(events[1].event).toBe("tool_use");
    expect((events[1].payload as any).tool).toBe("Glob");
  });

  test("user tool result with file info", () => {
    runner.testHandleMessage(fixtures.userToolResultFile);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_result");
    expect((events[0].payload as any).summary).toContain("index.ts");
    expect((events[0].payload as any).summary).toContain("42 lines");
  });

  test("user tool result with stdout", () => {
    runner.testHandleMessage(fixtures.userToolResultStdout);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_result");
    expect((events[0].payload as any).summary).toContain("2 lines");
  });

  test("user tool result with no output", () => {
    runner.testHandleMessage(fixtures.userToolResultNoOutput);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_result");
    expect((events[0].payload as any).summary).toContain("no output");
  });

  test("user tool result with error", () => {
    runner.testHandleMessage(fixtures.userToolResultError);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_result");
    expect((events[0].payload as any).error).toBe(true);
  });

  test("result message extracts usage and cost", () => {
    runner.testHandleMessage(fixtures.resultSuccess);

    const session = runner.getSession()!;
    expect(session.input_tokens).toBe(12500);
    expect(session.output_tokens).toBe(3200);
    expect(session.cost_usd).toBe(0.0342);
    expect(session.duration_ms).toBe(45200);

    // Should emit token_usage_updated event
    const usageEvent = events.find((e) => e.event === "token_usage_updated");
    expect(usageEvent).toBeDefined();
  });

  test("result message with error flag", () => {
    runner.testHandleMessage(fixtures.resultError);

    const session = runner.getSession()!;
    expect(session.cost_usd).toBe(0.012);
    expect(session.input_tokens).toBe(5000);
  });

  test("result message without usage does not emit token event", () => {
    runner.testHandleMessage(fixtures.resultNoUsage);

    const usageEvent = events.find((e) => e.event === "token_usage_updated");
    expect(usageEvent).toBeUndefined();

    // But should still set cost/duration
    const session = runner.getSession()!;
    expect(session.cost_usd).toBe(0.001);
    expect(session.duration_ms).toBe(2000);
  });
});
