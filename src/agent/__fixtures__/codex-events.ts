/**
 * Real Codex CLI JSON Lines event fixtures.
 * Captured from `codex exec ... --json`.
 */

export const threadStarted = {
  type: "thread.started",
  thread_id: "thread_abc123",
};

export const turnStarted = {
  type: "turn.started",
};

export const itemStartedCommandExecution = {
  type: "item.started",
  item: {
    type: "command_execution",
    command: "/bin/bash -lc 'git status'",
    status: "in_progress",
  },
};

export const itemStartedFileChange = {
  type: "item.started",
  item: {
    type: "file_change",
    changes: [
      { path: "/workspace/src/utils.ts", kind: "modify" },
    ],
    status: "in_progress",
  },
};

export const itemStartedFileChangeMultiple = {
  type: "item.started",
  item: {
    type: "file_change",
    changes: [
      { path: "/workspace/src/index.ts", kind: "add" },
      { path: "/workspace/src/config.ts", kind: "modify" },
    ],
    status: "in_progress",
  },
};

export const itemStartedMcpCall = {
  type: "item.started",
  item: {
    type: "mcp_call",
    tool: "linear_search",
  },
};

export const itemStartedWebSearch = {
  type: "item.started",
  item: {
    type: "web_search",
    query: "TypeScript generics tutorial",
  },
};

export const itemCompletedAgentMessage = {
  type: "item.completed",
  item: {
    type: "agent_message",
    text: "I've analyzed the codebase and identified the issue. The problem is in the error handling logic.",
  },
};

export const itemCompletedCommandExecution = {
  type: "item.completed",
  item: {
    type: "command_execution",
    command: "/bin/bash -lc 'npm test'",
    aggregated_output: "PASS src/index.test.ts\nTests: 5 passed\nTime: 1.2s\n",
    exit_code: 0,
    status: "completed",
  },
};

export const itemCompletedCommandExecutionFailed = {
  type: "item.completed",
  item: {
    type: "command_execution",
    command: "/bin/bash -lc 'npm test'",
    aggregated_output: "FAIL src/broken.test.ts\nError: assertion failed\n",
    exit_code: 1,
    status: "failed",
  },
};

export const itemCompletedCommandExecutionNoOutput = {
  type: "item.completed",
  item: {
    type: "command_execution",
    command: "/bin/bash -lc 'touch foo.txt'",
    aggregated_output: "",
    exit_code: 0,
    status: "completed",
  },
};

export const itemCompletedFileChange = {
  type: "item.completed",
  item: {
    type: "file_change",
    changes: [
      { path: "/workspace/src/utils.ts", kind: "modify" },
    ],
    status: "completed",
  },
};

export const itemCompletedFileChangeFailed = {
  type: "item.completed",
  item: {
    type: "file_change",
    changes: [
      { path: "/workspace/src/readonly.ts", kind: "modify" },
    ],
    status: "failed",
  },
};

export const turnCompleted = {
  type: "turn.completed",
  usage: {
    input_tokens: 8000,
    output_tokens: 2000,
    cached_input_tokens: 1500,
  },
};

export const turnCompletedNoUsage = {
  type: "turn.completed",
};

export const turnFailed = {
  type: "turn.failed",
  reason: "rate_limited",
};

export const errorEvent = {
  type: "error",
  message: "API rate limit exceeded",
};
