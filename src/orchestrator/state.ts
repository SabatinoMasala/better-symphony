/**
 * Orchestrator State Management
 */

import type {
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  Issue,
  TokenTotals,
  RateLimitInfo,
} from "../config/types.js";
import { createEmptyTotals } from "../agent/session.js";

export function createOrchestratorState(
  pollIntervalMs: number,
  maxConcurrentAgents: number
): OrchestratorState {
  return {
    poll_interval_ms: pollIntervalMs,
    max_concurrent_agents: maxConcurrentAgents,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    token_totals: createEmptyTotals(),
    rate_limits: null,
    ended_seconds: 0,
  };
}

// ── Claim Management ────────────────────────────────────────────

export function claimIssue(state: OrchestratorState, issueId: string): boolean {
  if (state.claimed.has(issueId)) {
    return false;
  }
  state.claimed.add(issueId);
  return true;
}

export function releaseClaim(state: OrchestratorState, issueId: string): void {
  state.claimed.delete(issueId);
}

export function isIssueClaimed(state: OrchestratorState, issueId: string): boolean {
  return state.claimed.has(issueId);
}

// ── Running Management ──────────────────────────────────────────

export function addRunning(state: OrchestratorState, entry: RunningEntry): void {
  state.running.set(entry.issue.id, entry);
}

export function removeRunning(state: OrchestratorState, issueId: string): RunningEntry | undefined {
  const entry = state.running.get(issueId);
  if (entry) {
    state.running.delete(issueId);

    // Add runtime to ended seconds
    const runtimeMs = Date.now() - entry.attempt.started_at.getTime();
    state.ended_seconds += runtimeMs / 1000;
  }
  return entry;
}

export function getRunning(state: OrchestratorState, issueId: string): RunningEntry | undefined {
  return state.running.get(issueId);
}

export function isIssueRunning(state: OrchestratorState, issueId: string): boolean {
  return state.running.has(issueId);
}

export function getRunningCount(state: OrchestratorState): number {
  return state.running.size;
}

export function getRunningByState(state: OrchestratorState, stateName: string): number {
  const normalized = stateName.trim().toLowerCase();
  let count = 0;
  for (const entry of state.running.values()) {
    if (entry.issue.state.trim().toLowerCase() === normalized) {
      count++;
    }
  }
  return count;
}

// ── Retry Management ────────────────────────────────────────────

export function addRetry(state: OrchestratorState, entry: RetryEntry): void {
  // Cancel existing retry if any
  const existing = state.retry_attempts.get(entry.issue_id);
  if (existing) {
    clearTimeout(existing.timer_handle);
  }
  state.retry_attempts.set(entry.issue_id, entry);
}

export function removeRetry(state: OrchestratorState, issueId: string): RetryEntry | undefined {
  const entry = state.retry_attempts.get(issueId);
  if (entry) {
    clearTimeout(entry.timer_handle);
    state.retry_attempts.delete(issueId);
  }
  return entry;
}

export function getRetry(state: OrchestratorState, issueId: string): RetryEntry | undefined {
  return state.retry_attempts.get(issueId);
}

// ── Token/Rate Limit Updates ────────────────────────────────────

export function updateTotals(
  state: OrchestratorState,
  deltas: { delta_input: number; delta_output: number; delta_total: number }
): void {
  state.token_totals.input_tokens += deltas.delta_input;
  state.token_totals.output_tokens += deltas.delta_output;
  state.token_totals.total_tokens += deltas.delta_total;
}

export function updateRateLimits(state: OrchestratorState, limits: RateLimitInfo): void {
  state.rate_limits = limits;
}

// ── Snapshot for Observability ──────────────────────────────────

export interface RuntimeSnapshot {
  running: Array<{
    issue_id: string;
    issue_identifier: string;
    state: string;
    started_at: Date;
    turn_count: number;
    session_id: string | null;
    workflow: string | null;
  }>;
  retrying: Array<{
    issue_id: string;
    identifier: string;
    attempt: number;
    due_at: Date;
    error: string | null;
    workflow: string | null;
  }>;
  workflows: Array<{
    name: string;
    max_concurrent_agents: number;
    running_count: number;
  }>;
  token_totals: TokenTotals;
  rate_limits: RateLimitInfo | null;
}

export function createSnapshot(state: OrchestratorState, workflowName: string | null = null): RuntimeSnapshot {
  const now = Date.now();

  // Calculate live seconds_running including active sessions
  let activeSeconds = 0;
  for (const entry of state.running.values()) {
    activeSeconds += (now - entry.attempt.started_at.getTime()) / 1000;
  }

  const running = Array.from(state.running.values()).map((entry) => ({
    issue_id: entry.issue.id,
    issue_identifier: entry.issue.identifier,
    state: entry.issue.state,
    started_at: entry.attempt.started_at,
    turn_count: entry.session?.turn_count ?? 0,
    session_id: entry.session?.session_id ?? null,
    workflow: workflowName,
  }));

  const retrying = Array.from(state.retry_attempts.values()).map((entry) => ({
    issue_id: entry.issue_id,
    identifier: entry.identifier,
    attempt: entry.attempt,
    due_at: new Date(entry.due_at_ms),
    error: entry.error,
    workflow: workflowName,
  }));

  return {
    running,
    retrying,
    workflows: [{
      name: workflowName ?? "default",
      max_concurrent_agents: state.max_concurrent_agents,
      running_count: running.length,
    }],
    token_totals: {
      ...state.token_totals,
      seconds_running: state.ended_seconds + activeSeconds,
    },
    rate_limits: state.rate_limits,
  };
}
