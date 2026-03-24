/**
 * Scheduler
 * Issue sorting and dispatch eligibility
 */

import type { Issue, ServiceConfig, OrchestratorState } from "../config/types.js";
import * as state from "./state.js";

// ── Candidate Filtering ─────────────────────────────────────────

export interface CandidateResult {
  eligible: Issue[];
  skipped: Array<{
    issue: Issue;
    reason: string;
  }>;
}

/**
 * Filter and sort candidate issues for dispatch
 */
export function selectCandidates(
  issues: Issue[],
  orchState: OrchestratorState,
  config: ServiceConfig
): CandidateResult {
  const eligible: Issue[] = [];
  const skipped: Array<{ issue: Issue; reason: string }> = [];

  const activeStates = new Set(config.tracker.active_states.map((s) => s.trim().toLowerCase()));
  const terminalStates = new Set(config.tracker.terminal_states.map((s) => s.trim().toLowerCase()));

  for (const issue of issues) {
    const result = checkEligibility(issue, orchState, config, activeStates, terminalStates);
    if (result.eligible) {
      eligible.push(issue);
    } else {
      skipped.push({ issue, reason: result.reason });
    }
  }

  // Sort by priority
  sortByDispatchPriority(eligible);

  return { eligible, skipped };
}

interface EligibilityResult {
  eligible: boolean;
  reason: string;
}

function checkEligibility(
  issue: Issue,
  orchState: OrchestratorState,
  config: ServiceConfig,
  activeStates: Set<string>,
  terminalStates: Set<string>
): EligibilityResult {
  // Required fields
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return { eligible: false, reason: "missing required fields" };
  }

  const normalizedState = issue.state.trim().toLowerCase();

  // State checks
  if (!activeStates.has(normalizedState)) {
    return { eligible: false, reason: `state "${issue.state}" not in active states` };
  }

  if (terminalStates.has(normalizedState)) {
    return { eligible: false, reason: `state "${issue.state}" is terminal` };
  }

  // Already running check
  if (state.isIssueRunning(orchState, issue.id)) {
    return { eligible: false, reason: "already running" };
  }

  // Already claimed check
  if (state.isIssueClaimed(orchState, issue.id)) {
    return { eligible: false, reason: "already claimed" };
  }

  // Global concurrency check
  const runningCount = state.getRunningCount(orchState);
  if (runningCount >= config.agent.max_concurrent_agents) {
    return { eligible: false, reason: "global concurrency limit reached" };
  }

  // Per-state concurrency check
  const stateLimit = config.agent.max_concurrent_agents_by_state.get(normalizedState);
  if (stateLimit !== undefined) {
    const stateCount = state.getRunningByState(orchState, normalizedState);
    if (stateCount >= stateLimit) {
      return { eligible: false, reason: `per-state concurrency limit reached for "${issue.state}"` };
    }
  }

  // Blocker check for Todo state
  if (normalizedState === "todo" && issue.blocked_by.length > 0) {
    for (const blocker of issue.blocked_by) {
      if (blocker.state) {
        const blockerState = blocker.state.trim().toLowerCase();
        if (!terminalStates.has(blockerState)) {
          return {
            eligible: false,
            reason: `blocked by ${blocker.identifier || blocker.id} (state: ${blocker.state})`,
          };
        }
      }
    }
  }

  // Symphony error label check
  const issueLabels = new Set(issue.labels.map((l) => l.toLowerCase()));
  if (issueLabels.has("symphony:error")) {
    return { eligible: false, reason: "symphony:error label present" };
  }

  // Required labels check
  if (config.tracker.required_labels.length > 0) {
    for (const requiredLabel of config.tracker.required_labels) {
      if (!issueLabels.has(requiredLabel.toLowerCase())) {
        return {
          eligible: false,
          reason: `missing required label "${requiredLabel}"`,
        };
      }
    }
  }

  // Excluded labels check
  if (config.tracker.excluded_labels.length > 0) {
    for (const excludedLabel of config.tracker.excluded_labels) {
      if (issueLabels.has(excludedLabel.toLowerCase())) {
        return {
          eligible: false,
          reason: `has excluded label "${excludedLabel}"`,
        };
      }
    }
  }

  return { eligible: true, reason: "" };
}

/**
 * Sort issues by dispatch priority (in-place)
 * 1. priority ascending (1..4 preferred, null last)
 * 2. created_at oldest first
 * 3. identifier lexicographic tie-breaker
 */
export function sortByDispatchPriority(issues: Issue[]): void {
  issues.sort((a, b) => {
    // Priority: lower is better, null sorts last
    const aPrio = a.priority ?? 999;
    const bPrio = b.priority ?? 999;
    if (aPrio !== bPrio) {
      return aPrio - bPrio;
    }

    // Created at: older is better
    const aTime = a.created_at?.getTime() ?? Date.now();
    const bTime = b.created_at?.getTime() ?? Date.now();
    if (aTime !== bTime) {
      return aTime - bTime;
    }

    // Identifier: lexicographic
    return a.identifier.localeCompare(b.identifier);
  });
}

// ── Concurrency Helpers ─────────────────────────────────────────

/**
 * Get available global slots
 */
export function getAvailableSlots(
  orchState: OrchestratorState,
  config: ServiceConfig
): number {
  return Math.max(0, config.agent.max_concurrent_agents - state.getRunningCount(orchState));
}

/**
 * Calculate backoff delay for retry
 */
export function calculateBackoffDelay(attempt: number, maxBackoffMs: number): number {
  // delay = min(10000 * 2^(attempt - 1), max_retry_backoff_ms)
  const delay = 10000 * Math.pow(2, attempt - 1);
  return Math.min(delay, maxBackoffMs);
}

/**
 * Continuation retry delay (after successful completion)
 */
export const CONTINUATION_RETRY_DELAY_MS = 1000;
