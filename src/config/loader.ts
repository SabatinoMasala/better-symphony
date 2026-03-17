/**
 * Workflow Loader
 * Parses WORKFLOW.md with YAML front matter + prompt template
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from "fs";
import { parse as parseYaml } from "yaml";
import { tmpdir, homedir } from "os";
import { resolve, join, isAbsolute, sep } from "path";
import { Liquid } from "liquidjs";
import type {
  WorkflowDefinition,
  WorkflowConfig,
  ServiceConfig,
  AgentBinary,
  Issue,
  ChildIssue,
  WorkflowError,
} from "./types.js";
import { WorkflowError as WFError } from "./types.js";

const liquid = new Liquid({ strictVariables: true, strictFilters: true });

// ── Defaults ────────────────────────────────────────────────────

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_HOOK_TIMEOUT_MS = 60000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_MAX_TURNS = 0; // Infinite
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300000;
const DEFAULT_TURN_TIMEOUT_MS = 3600000;
const DEFAULT_STALL_TIMEOUT_MS = 300000;
const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_CLAUDE_BINARY = "claude";
const DEFAULT_PERMISSION_MODE = "acceptEdits";

// ── Loader ──────────────────────────────────────────────────────

export function loadWorkflow(filePath: string): WorkflowDefinition {
  if (!existsSync(filePath)) {
    throw new WFError("missing_workflow_file", `Workflow file not found: ${filePath}`);
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new WFError("missing_workflow_file", `Failed to read workflow file: ${filePath}`);
  }

  let config: WorkflowConfig = {};
  let prompt_template = content;

  // Parse YAML front matter if present
  if (content.startsWith("---")) {
    const endIndex = content.indexOf("\n---", 3);
    if (endIndex !== -1) {
      const frontMatter = content.slice(4, endIndex);
      prompt_template = content.slice(endIndex + 4).trim();

      try {
        const parsed = parseYaml(frontMatter);
        if (parsed !== null && typeof parsed !== "object") {
          throw new WFError(
            "workflow_front_matter_not_a_map",
            "YAML front matter must be a map/object"
          );
        }
        config = (parsed as WorkflowConfig) || {};
      } catch (err) {
        if (err instanceof WFError) throw err;
        throw new WFError(
          "workflow_parse_error",
          `Failed to parse YAML front matter: ${(err as Error).message}`
        );
      }
    }
  }

  return { config, prompt_template };
}

// ── Environment Expansion ───────────────────────────────────────

function expandEnvVar(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith("$")) {
    const envName = value.slice(1);
    const envValue = process.env[envName];
    return envValue || undefined;
  }
  return value;
}

function expandPath(value: string | undefined): string | undefined {
  if (!value) return value;

  // Expand $VAR
  if (value.startsWith("$")) {
    const envValue = expandEnvVar(value);
    if (envValue) value = envValue;
  }

  // Expand ~
  if (value.startsWith("~")) {
    value = join(homedir(), value.slice(1));
  }

  // Resolve to absolute if it contains path separators
  if (value.includes(sep) || value.includes("/")) {
    return resolve(value);
  }

  return value;
}

function parseIntOr<T extends number>(value: T | string | undefined, defaultValue: T): T {
  if (value === undefined) return defaultValue;
  if (typeof value === "number") return value as T;
  const parsed = parseInt(value, 10);
  return (isNaN(parsed) ? defaultValue : parsed) as T;
}

function parseStateList(value: string[] | string | undefined, defaults: string[]): string[] {
  if (!value) return defaults;
  if (Array.isArray(value)) return value;
  return value.split(",").map((s) => s.trim());
}

// ── Service Config Builder ──────────────────────────────────────

export function buildServiceConfig(workflow: WorkflowDefinition): ServiceConfig {
  const cfg = workflow.config;

  // Tracker config
  const trackerKind = cfg.tracker?.kind || "linear";
  if (trackerKind !== "linear" && trackerKind !== "github-pr" && trackerKind !== "github-issues") {
    throw new WFError("workflow_parse_error", `Unsupported tracker kind: ${trackerKind}`);
  }

  const apiKey = expandEnvVar(cfg.tracker?.api_key) || process.env.LINEAR_API_KEY || "";
  const projectSlug = cfg.tracker?.project_slug || "";
  const repo = cfg.tracker?.repo || "";

  // Workspace root
  let workspaceRoot = expandPath(cfg.workspace?.root);
  if (!workspaceRoot) {
    workspaceRoot = join(tmpdir(), "symphony_workspaces");
  }

  // Parse state-based concurrency limits
  const byStateMap = new Map<string, number>();
  const byState = cfg.agent?.max_concurrent_agents_by_state;
  if (byState) {
    for (const [state, limit] of Object.entries(byState)) {
      const normalizedState = state.trim().toLowerCase();
      const parsedLimit = parseIntOr(limit, 0);
      if (parsedLimit > 0) {
        byStateMap.set(normalizedState, parsedLimit);
      }
    }
  }

  // Resolve binary: `binary` takes precedence over deprecated `harness`
  const binary = (cfg.agent?.binary || cfg.agent?.harness || DEFAULT_CLAUDE_BINARY) as AgentBinary;

  return {
    tracker: {
      kind: trackerKind as "linear" | "github-pr",
      // Linear-specific (empty for github-pr)
      endpoint: cfg.tracker?.endpoint || DEFAULT_LINEAR_ENDPOINT,
      api_key: apiKey,
      project_slug: projectSlug,
      active_states: parseStateList(cfg.tracker?.active_states, 
        trackerKind === "github-pr" ? ["Open"] : 
        trackerKind === "github-issues" ? ["open"] : 
        DEFAULT_ACTIVE_STATES),
      terminal_states: parseStateList(cfg.tracker?.terminal_states, 
        trackerKind === "github-pr" ? ["Closed"] : 
        trackerKind === "github-issues" ? ["closed"] : 
        DEFAULT_TERMINAL_STATES),
      // GitHub-specific (empty for linear)
      repo: repo,
      // Shared
      required_labels: parseStateList(cfg.tracker?.required_labels, []),
      excluded_labels: parseStateList(cfg.tracker?.excluded_labels, []),
    },
    polling: {
      interval_ms: parseIntOr(cfg.polling?.interval_ms, DEFAULT_POLL_INTERVAL_MS),
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      after_create: cfg.hooks?.after_create || null,
      before_run: cfg.hooks?.before_run || null,
      after_run: cfg.hooks?.after_run || null,
      before_remove: cfg.hooks?.before_remove || null,
      timeout_ms: parseIntOr(cfg.hooks?.timeout_ms, DEFAULT_HOOK_TIMEOUT_MS),
    },
    agent: {
      binary,
      mode: cfg.agent?.mode === "ralph_loop" ? "ralph_loop" : "default",
      max_concurrent_agents: parseIntOr(cfg.agent?.max_concurrent_agents, DEFAULT_MAX_CONCURRENT_AGENTS),
      max_turns: parseIntOr(cfg.agent?.max_turns, DEFAULT_MAX_TURNS),
      max_retries: parseIntOr(cfg.agent?.max_retries, DEFAULT_MAX_RETRIES),
      max_retry_backoff_ms: parseIntOr(cfg.agent?.max_retry_backoff_ms, DEFAULT_MAX_RETRY_BACKOFF_MS),
      max_concurrent_agents_by_state: byStateMap,
      turn_timeout_ms: parseIntOr(cfg.agent?.turn_timeout_ms, DEFAULT_TURN_TIMEOUT_MS),
      stall_timeout_ms: parseIntOr(cfg.agent?.stall_timeout_ms, DEFAULT_STALL_TIMEOUT_MS),
      max_iterations: parseIntOr(cfg.agent?.max_iterations, 0),
      yolobox: cfg.agent?.yolobox === true,
      yolobox_arguments: Array.isArray(cfg.agent?.yolobox_arguments) ? cfg.agent.yolobox_arguments : [],
      permission_mode: cfg.agent?.permission_mode || DEFAULT_PERMISSION_MODE,
      append_system_prompt: cfg.agent?.append_system_prompt || null,
    },
  };
}

// ── Validation ──────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateServiceConfig(config: ServiceConfig): ValidationResult {
  const errors: string[] = [];

  if (!config.tracker.kind) {
    errors.push("tracker.kind is required");
  }

  if (config.tracker.kind === "linear") {
    if (!config.tracker.api_key) {
      errors.push("tracker.api_key is required (set LINEAR_API_KEY or tracker.api_key in WORKFLOW.md)");
    }
    if (!config.tracker.project_slug) {
      errors.push("tracker.project_slug is required for Linear tracker");
    }
  }

  if (config.tracker.kind === "github-pr") {
    if (!config.tracker.repo) {
      errors.push("tracker.repo is required for GitHub PR tracker (e.g., 'owner/repo')");
    }
  }

  if (config.tracker.kind === "github-issues") {
    if (!config.tracker.repo) {
      errors.push("tracker.repo is required for GitHub Issues tracker (e.g., 'owner/repo')");
    }
  }

  const validBinaries = ["claude", "codex", "opencode"];
  if (!validBinaries.includes(config.agent.binary)) {
    errors.push(`agent.binary must be one of: ${validBinaries.join(", ")}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ── Prompt Rendering ────────────────────────────────────────────

export async function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null
): Promise<string> {
  if (!template.trim()) {
    return "You are working on an issue from Linear.";
  }

  try {
    const result = await liquid.parseAndRender(template, {
      issue: {
        ...issue,
        labels: issue.labels,
        blocked_by: issue.blocked_by,
        comments: issue.comments,
      },
      attempt,
    });
    return result;
  } catch (err) {
    throw new WFError(
      "template_render_error",
      `Failed to render prompt template: ${(err as Error).message}`
    );
  }
}

/**
 * Render prompt for ralph_loop mode (subtask-aware)
 */
export async function renderSubtaskPrompt(
  template: string,
  parentIssue: Issue,
  currentSubtask: ChildIssue,
  subtaskIndex: number,
  totalSubtasks: number,
  attempt: number | null
): Promise<string> {
  if (!template.trim()) {
    return `You are working on subtask ${currentSubtask.identifier}: ${currentSubtask.title}`;
  }

  try {
    const result = await liquid.parseAndRender(template, {
      // Parent issue context
      parent: {
        ...parentIssue,
        labels: parentIssue.labels,
        blocked_by: parentIssue.blocked_by,
        children: parentIssue.children,
        comments: parentIssue.comments,
      },
      // Also expose as 'issue' for backward compat
      issue: {
        ...parentIssue,
        labels: parentIssue.labels,
        blocked_by: parentIssue.blocked_by,
        children: parentIssue.children,
        comments: parentIssue.comments,
      },
      // Current subtask being worked on
      current_subtask: currentSubtask,
      subtask: currentSubtask, // alias
      // Loop context
      subtask_index: subtaskIndex,
      total_subtasks: totalSubtasks,
      is_first_subtask: subtaskIndex === 1,
      is_last_subtask: subtaskIndex === totalSubtasks,
      // Retry info
      attempt,
    });
    return result;
  } catch (err) {
    throw new WFError(
      "template_render_error",
      `Failed to render subtask prompt template: ${(err as Error).message}`
    );
  }
}

// ── File Watcher ────────────────────────────────────────────────

export type WorkflowChangeCallback = (workflow: WorkflowDefinition, config: ServiceConfig) => void;

export function watchWorkflow(
  filePath: string,
  onChange: WorkflowChangeCallback,
  onError: (err: Error) => void
): () => void {
  const handleChange = () => {
    try {
      const workflow = loadWorkflow(filePath);
      const config = buildServiceConfig(workflow);
      onChange(workflow, config);
    } catch (err) {
      onError(err as Error);
    }
  };

  // Use chokidar for robust file watching
  const watcher = watchFile(filePath, { interval: 1000 }, handleChange);

  return () => {
    unwatchFile(filePath, handleChange);
  };
}
