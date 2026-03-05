/**
 * Symphony Configuration Types
 */

// ── Issue Domain Model ──────────────────────────────────────────

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface ChildIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  state_type: string; // "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled"
  sort_order: number;
  assignee: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface Comment {
  id: string;
  body: string;
  user: string | null;
  created_at: Date | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  children: ChildIssue[];
  comments: Comment[];
  created_at: Date | null;
  updated_at: Date | null;
  // GitHub PR specific (optional)
  base_branch?: string;
  author?: string;
  files_changed?: number;
  number?: number;
}

// ── Workflow Definition ─────────────────────────────────────────

export interface WorkflowDefinition {
  config: WorkflowConfig;
  prompt_template: string;
}

export interface WorkflowConfig {
  tracker?: TrackerConfig;
  polling?: PollingConfig;
  workspace?: WorkspaceConfig;
  hooks?: HooksConfig;
  agent?: AgentConfig;
}

export interface TrackerConfig {
  kind: "linear" | "github-pr" | "github-issues";
  // Linear-specific
  endpoint?: string;
  api_key?: string;
  project_slug?: string;
  active_states?: string[] | string;
  terminal_states?: string[] | string;
  // GitHub-specific
  repo?: string;
  // Shared
  /** Labels that must be present on an issue for it to be picked up */
  required_labels?: string[] | string;
  /** Labels that exclude an issue from being picked up */
  excluded_labels?: string[] | string;
}

export interface PollingConfig {
  interval_ms?: number | string;
}

export interface WorkspaceConfig {
  root?: string;
}

export interface HooksConfig {
  after_create?: string;
  before_run?: string;
  after_run?: string;
  before_remove?: string;
  timeout_ms?: number | string;
}

export type AgentHarness = "claude" | "codex" | "opencode";

export interface AgentConfig {
  /** Agent harness: which CLI to use */
  harness?: AgentHarness;
  /** Agent mode: "default" or "ralph_loop" (external subtask orchestration) */
  mode?: "default" | "ralph_loop";
  max_concurrent_agents?: number | string;
  max_turns?: number | string;
  max_retries?: number | string;
  max_retry_backoff_ms?: number | string;
  max_concurrent_agents_by_state?: Record<string, number | string>;
  turn_timeout_ms?: number | string;
  stall_timeout_ms?: number | string;
  /** Ralph loop: max subtasks per run (default: unlimited) */
  max_iterations?: number | string;
  /** Claude harness: binary name or path (default: "claude") */
  binary?: string;
  /** Claude harness: permission mode (default: "acceptEdits") */
  permission_mode?: string;
  /** Claude harness: append to system prompt */
  append_system_prompt?: string;
  /** Docker sandbox template image (e.g. "claude-symphony:v1") */
  sandbox_template?: string;
}

// ── Service Config (Typed View) ─────────────────────────────────

export interface ServiceConfig {
  tracker: {
    kind: "linear" | "github-pr" | "github-issues";
    // Linear-specific (required for linear, empty string for github-pr)
    endpoint: string;
    api_key: string;
    project_slug: string;
    active_states: string[];
    terminal_states: string[];
    // GitHub-specific
    repo: string;
    // Shared
    required_labels: string[];
    excluded_labels: string[];
  };
  polling: {
    interval_ms: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
  agent: {
    harness: AgentHarness;
    mode: "default" | "ralph_loop";
    max_concurrent_agents: number;
    max_turns: number;
    max_retries: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Map<string, number>;
    turn_timeout_ms: number;
    stall_timeout_ms: number;
    max_iterations: number;
    binary: string;
    permission_mode: string;
    append_system_prompt: string | null;
    /** Docker sandbox template image (e.g. "claude-symphony:v1") */
    sandbox_template: string | null;
  };
}

// ── Workspace ───────────────────────────────────────────────────

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

// ── Run Attempt ─────────────────────────────────────────────────

export type RunAttemptStatus =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";

export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  attempt: number | null;
  workspace_path: string;
  started_at: Date;
  status: RunAttemptStatus;
  error?: string;
}

// ── Live Session ────────────────────────────────────────────────

export interface LiveSession {
  session_id: string;
  thread_id: string;
  turn_id: string;
  process_pid: string | null;
  last_event: string | null;
  last_activity_at: Date | null;
  last_message: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number;
  cost_usd: number;
  duration_ms: number;
}

// ── Retry Entry ─────────────────────────────────────────────────

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: Timer;
  error: string | null;
}

// ── Running Entry ───────────────────────────────────────────────

export interface RunningEntry {
  issue: Issue;
  attempt: RunAttempt;
  session: LiveSession | null;
  worker: Promise<void>;
  abortController: AbortController;
}

// ── Token/Rate Limit Tracking ───────────────────────────────────

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface RateLimitInfo {
  requests_limit?: number;
  requests_remaining?: number;
  requests_reset?: number;
  tokens_limit?: number;
  tokens_remaining?: number;
  tokens_reset?: number;
}

// ── Orchestrator Runtime State ──────────────────────────────────

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  token_totals: TokenTotals;
  rate_limits: RateLimitInfo | null;
  ended_seconds: number;
}

// ── Agent Events ────────────────────────────────────────────────

export type AgentEventType =
  | "session_started"
  | "startup_failed"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_ended_with_error"
  | "turn_input_required"
  | "tool_use"
  | "tool_result"
  | "assistant_message"
  | "notification"
  | "other_message"
  | "malformed"
  | "token_usage_updated";

export interface AgentEvent {
  event: AgentEventType;
  timestamp: Date;
  process_pid?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  cost_usd?: number;
  duration_ms?: number;
  payload?: unknown;
  message?: string;
}

// ── Errors ──────────────────────────────────────────────────────

export type WorkflowErrorClass =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error";

export class WorkflowError extends Error {
  constructor(
    public readonly errorClass: WorkflowErrorClass,
    message: string
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export type TrackerErrorClass =
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload"
  | "linear_missing_end_cursor";

export class TrackerError extends Error {
  constructor(
    public readonly errorClass: TrackerErrorClass,
    message: string
  ) {
    super(message);
    this.name = "TrackerError";
  }
}

export type AgentErrorClass =
  | "agent_not_found"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "process_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  | "sandbox_failed";

export class AgentError extends Error {
  constructor(
    public readonly errorClass: AgentErrorClass,
    message: string
  ) {
    super(message);
    this.name = "AgentError";
  }
}
