import { describe, expect, test, beforeEach } from "bun:test";
import type { AgentEvent, ServiceConfig, Issue } from "../config/types.js";
import type { RunnerOptions } from "./base-runner.js";
import { CodexRunner, formatChanges } from "./codex-runner.js";
import * as fixtures from "./__fixtures__/codex-events.js";

// ── Testable Subclass ────────────────────────────────────────────

class TestableCodexRunner extends CodexRunner {
  public testBuildArgs(prompt: string): string[] {
    return this.buildArgs(prompt);
  }
  public testHandleMessage(msg: any): void {
    this.handleStreamMessage(msg);
  }
  public initSession(): void {
    const { createSession } = require("./session.js");
    this.session = createSession("test-thread", "test-turn", "999");
  }
}

// ── Fixtures ─────────────────────────────────────────────────────

function makeIssue(): Issue {
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
      binary: "codex",
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
): { runner: TestableCodexRunner; events: AgentEvent[] } {
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
  const runner = new TestableCodexRunner(options);
  return { runner, events };
}

// ── formatChanges ────────────────────────────────────────────────

describe("formatChanges", () => {
  test("single file with kind", () => {
    expect(formatChanges([{ path: "/a/b/utils.ts", kind: "modify" }])).toBe(
      "utils.ts (modify)"
    );
  });

  test("multiple files", () => {
    const result = formatChanges([
      { path: "/a/index.ts", kind: "add" },
      { path: "/a/config.ts", kind: "modify" },
    ]);
    expect(result).toBe("index.ts (add), config.ts (modify)");
  });

  test("file without kind", () => {
    expect(formatChanges([{ path: "/a/b/readme.md" }])).toBe("readme.md");
  });

  test("undefined changes", () => {
    expect(formatChanges(undefined)).toBe("file");
  });

  test("empty array", () => {
    expect(formatChanges([])).toBe("file");
  });

  test("file with empty path", () => {
    expect(formatChanges([{ path: "", kind: "add" }])).toBe(" (add)");
  });
});

// ── buildArgs ────────────────────────────────────────────────────

describe("CodexRunner.buildArgs", () => {
  test("starts with exec subcommand", () => {
    const { runner } = makeRunner();
    const args = runner.testBuildArgs("Do the thing");

    expect(args[0]).toBe("exec");
  });

  test("includes prompt, --json, --full-auto, --ephemeral", () => {
    const { runner } = makeRunner();
    const args = runner.testBuildArgs("Do the thing");

    expect(args).toContain("Do the thing");
    expect(args).toContain("--json");
    expect(args).toContain("--full-auto");
    expect(args).toContain("--ephemeral");
  });

  test("injects developer_instructions via -c flag", () => {
    const { runner } = makeRunner({ append_system_prompt: "Be concise" });
    const args = runner.testBuildArgs("prompt");

    const cIndex = args.indexOf("-c");
    expect(cIndex).toBeGreaterThan(-1);
    const devInstructions = args[cIndex + 1];
    expect(devInstructions).toMatch(/^developer_instructions=/);
    expect(devInstructions).toContain("Be concise");
  });

  test("bypassPermissions maps to --sandbox danger-full-access", () => {
    const { runner } = makeRunner({ permission_mode: "bypassPermissions" });
    const args = runner.testBuildArgs("prompt");

    expect(args).toContain("--full-auto");
    expect(args).toContain("--sandbox");
    expect(args).toContain("danger-full-access");
  });

  test("dangerMode maps to --sandbox danger-full-access", () => {
    const { runner } = makeRunner({ permission_mode: "dangerMode" });
    const args = runner.testBuildArgs("prompt");

    expect(args).toContain("--sandbox");
    expect(args).toContain("danger-full-access");
  });

  test("acceptEdits does not include --sandbox", () => {
    const { runner } = makeRunner({ permission_mode: "acceptEdits" });
    const args = runner.testBuildArgs("prompt");

    expect(args).toContain("--full-auto");
    expect(args).not.toContain("--sandbox");
  });

  test("prompt comes after -c flag and before --json", () => {
    const { runner } = makeRunner({ append_system_prompt: "instructions" });
    const args = runner.testBuildArgs("my prompt");

    const promptIndex = args.indexOf("my prompt");
    const jsonIndex = args.indexOf("--json");
    expect(promptIndex).toBeLessThan(jsonIndex);
  });
});

// ── Event Mapping ────────────────────────────────────────────────

describe("CodexRunner event mapping", () => {
  let runner: TestableCodexRunner;
  let events: AgentEvent[];

  beforeEach(() => {
    const r = makeRunner();
    runner = r.runner;
    events = r.events;
    runner.initSession();
  });

  test("thread.started sets session_id", () => {
    runner.testHandleMessage(fixtures.threadStarted);

    const session = runner.getSession()!;
    expect(session.session_id).toBe("thread_abc123");
    expect(session.last_event).toBe("system:init");
  });

  test("item.started command_execution emits tool_use", () => {
    runner.testHandleMessage(fixtures.itemStartedCommandExecution);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_use");
    expect((events[0].payload as any).tool).toBe("Bash");
    expect((events[0].payload as any).detail).toContain("git status");
  });

  test("item.started file_change emits tool_use with file name", () => {
    runner.testHandleMessage(fixtures.itemStartedFileChange);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_use");
    expect((events[0].payload as any).tool).toBe("Edit");
    expect((events[0].payload as any).detail).toContain("utils.ts");
  });

  test("item.started file_change multiple files", () => {
    runner.testHandleMessage(fixtures.itemStartedFileChangeMultiple);

    expect(events).toHaveLength(1);
    const detail = (events[0].payload as any).detail;
    expect(detail).toContain("index.ts (add)");
    expect(detail).toContain("config.ts (modify)");
  });

  test("item.started mcp_call emits tool_use", () => {
    runner.testHandleMessage(fixtures.itemStartedMcpCall);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_use");
    expect((events[0].payload as any).tool).toBe("linear_search");
  });

  test("item.started web_search emits tool_use", () => {
    runner.testHandleMessage(fixtures.itemStartedWebSearch);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_use");
    expect((events[0].payload as any).tool).toBe("WebSearch");
    expect((events[0].payload as any).detail).toContain("TypeScript generics");
  });

  test("item.completed agent_message emits assistant_message", () => {
    runner.testHandleMessage(fixtures.itemCompletedAgentMessage);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("assistant_message");
    expect((events[0].payload as any).text).toContain("analyzed the codebase");
  });

  test("item.completed command_execution emits tool_result with line count", () => {
    runner.testHandleMessage(fixtures.itemCompletedCommandExecution);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_result");
    const payload = events[0].payload as any;
    expect(payload.summary).toContain("3 lines");
    expect(payload.summary).toContain("exit 0");
    expect(payload.error).toBeFalsy();
  });

  test("item.completed command_execution failed", () => {
    runner.testHandleMessage(fixtures.itemCompletedCommandExecutionFailed);

    expect(events).toHaveLength(1);
    const payload = events[0].payload as any;
    expect(payload.summary).toContain("exit 1");
    expect(payload.summary).toContain("failed");
    expect(payload.error).toBe(true);
  });

  test("item.completed command_execution no output", () => {
    runner.testHandleMessage(fixtures.itemCompletedCommandExecutionNoOutput);

    expect(events).toHaveLength(1);
    const payload = events[0].payload as any;
    expect(payload.summary).toContain("no output");
  });

  test("item.completed file_change", () => {
    runner.testHandleMessage(fixtures.itemCompletedFileChange);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("tool_result");
    const payload = events[0].payload as any;
    expect(payload.summary).toContain("utils.ts");
    expect(payload.error).toBeFalsy();
  });

  test("item.completed file_change failed", () => {
    runner.testHandleMessage(fixtures.itemCompletedFileChangeFailed);

    expect(events).toHaveLength(1);
    const payload = events[0].payload as any;
    expect(payload.summary).toContain("failed");
    expect(payload.error).toBe(true);
  });

  test("turn.completed extracts token usage", () => {
    runner.testHandleMessage(fixtures.turnCompleted);

    const session = runner.getSession()!;
    expect(session.input_tokens).toBe(8000);
    expect(session.output_tokens).toBe(2000);

    const usageEvent = events.find((e) => e.event === "token_usage_updated");
    expect(usageEvent).toBeDefined();
  });

  test("turn.completed without usage does not crash", () => {
    runner.testHandleMessage(fixtures.turnCompletedNoUsage);

    const usageEvent = events.find((e) => e.event === "token_usage_updated");
    expect(usageEvent).toBeUndefined();
  });

  test("turn.failed is handled without crash", () => {
    // Should not throw
    runner.testHandleMessage(fixtures.turnFailed);
    // No events emitted directly from turnFailed (just logging)
    expect(events).toHaveLength(0);
  });

  test("error event is handled without crash", () => {
    runner.testHandleMessage(fixtures.errorEvent);

    const session = runner.getSession()!;
    expect(session.last_event).toBe("error");
  });

  test("item.started with no item is ignored", () => {
    runner.testHandleMessage({ type: "item.started" });
    expect(events).toHaveLength(0);
  });

  test("item.completed with no item is ignored", () => {
    runner.testHandleMessage({ type: "item.completed" });
    expect(events).toHaveLength(0);
  });
});
