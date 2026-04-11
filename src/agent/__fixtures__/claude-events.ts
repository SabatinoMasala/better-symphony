/**
 * Real Claude stream-json event fixtures.
 * Captured from `claude -p ... --output-format stream-json`.
 */

export const systemInit = {
  type: "system",
  subtype: "init",
  session_id: "sess_abc123",
  model: "claude-sonnet-4-20250514",
  tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
};

export const assistantText = {
  type: "assistant",
  message: {
    id: "msg_01XYZ",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "I'll start by reading the existing code to understand the structure.",
      },
    ],
    model: "claude-sonnet-4-20250514",
    stop_reason: "end_turn",
  },
};

export const assistantToolUse = {
  type: "assistant",
  message: {
    id: "msg_02ABC",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_01DEF",
        name: "Read",
        input: {
          file_path: "/workspace/src/index.ts",
        },
      },
    ],
    model: "claude-sonnet-4-20250514",
    stop_reason: "tool_use",
  },
};

export const assistantToolUseBash = {
  type: "assistant",
  message: {
    id: "msg_03GHI",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_02JKL",
        name: "Bash",
        input: {
          command: "git status",
        },
      },
    ],
    model: "claude-sonnet-4-20250514",
    stop_reason: "tool_use",
  },
};

export const assistantMixedContent = {
  type: "assistant",
  message: {
    id: "msg_04MNO",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Let me check the file structure first.",
      },
      {
        type: "tool_use",
        id: "toolu_03PQR",
        name: "Glob",
        input: {
          pattern: "src/**/*.ts",
        },
      },
    ],
    model: "claude-sonnet-4-20250514",
    stop_reason: "tool_use",
  },
};

export const userToolResultFile = {
  type: "user",
  tool_use_result: {
    file: {
      filePath: "/workspace/src/index.ts",
      numLines: 42,
    },
  },
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01DEF",
        content: "file contents here...",
      },
    ],
  },
};

export const userToolResultStdout = {
  type: "user",
  tool_use_result: {
    stdout: "On branch main\nnothing to commit, working tree clean\n",
    stderr: "",
  },
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_02JKL",
        content: "On branch main\nnothing to commit, working tree clean\n",
      },
    ],
  },
};

export const userToolResultError = {
  type: "user",
  tool_use_result: undefined,
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_99ERR",
        is_error: true,
        content: "Command failed with exit code 1: npm test",
      },
    ],
  },
};

export const userToolResultNoOutput = {
  type: "user",
  tool_use_result: {
    stdout: "",
    stderr: "",
  },
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_04STU",
        content: "",
      },
    ],
  },
};

export const resultSuccess = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.0342,
  duration_ms: 45200,
  num_turns: 8,
  usage: {
    input_tokens: 12500,
    output_tokens: 3200,
  },
  result: "Task completed successfully.",
};

export const resultError = {
  type: "result",
  subtype: "error",
  is_error: true,
  total_cost_usd: 0.012,
  duration_ms: 15000,
  num_turns: 3,
  usage: {
    input_tokens: 5000,
    output_tokens: 800,
  },
  result: "Error: Could not complete task.",
};

export const resultNoUsage = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.001,
  duration_ms: 2000,
  num_turns: 1,
};
