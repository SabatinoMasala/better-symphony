/**
 * Abstract Tracker Interface
 * All tracker implementations (Linear, GitHub PR, etc.) must implement this
 */

import type { Issue, ChildIssue, Comment } from "../config/types.js";

export interface TrackerConfig {
  kind: "linear" | "github-pr" | "github-issues" | "cron" | "jira";
  // Linear-specific
  api_key?: string;
  endpoint?: string;
  project_slug?: string;
  active_states?: string[];
  terminal_states?: string[];
  // GitHub-specific
  repo?: string;
  // Cron-specific
  schedule?: string;
  // Shared
  required_labels?: string[];
  excluded_labels?: string[];
}

export interface FetchOptions {
  requiredLabels?: string[];
  excludedLabels?: string[];
  activeStates?: string[];
  limit?: number;
}

export interface Tracker {
  /** Fetch issues/PRs that are candidates for processing */
  fetchCandidates(options: FetchOptions): Promise<Issue[]>;

  /** Get a single issue/PR by identifier */
  getIssue(identifier: string): Promise<Issue | null>;

  /** Get issues/PRs by their terminal state (for cleanup) */
  fetchTerminalIssues(terminalStates: string[]): Promise<Issue[]>;

  /** Batch fetch states for multiple issues */
  fetchStatesByIds(ids: string[]): Promise<Map<string, string>>;

  /** Add or update a comment on an issue/PR */
  upsertComment(issueId: string, body: string, commentId?: string): Promise<string>;

  /** Add a label to an issue/PR */
  addLabel(issueId: string, label: string): Promise<void>;

  /** Remove a label from an issue/PR */
  removeLabel(issueId: string, label: string): Promise<void>;

  /** Update issue state/status */
  updateState(issueId: string, state: string): Promise<void>;

  /** Get rate limit state (for throttling) */
  getRateLimitState(): { remaining: number; limit: number; reset: number };
}

export async function createTracker(config: TrackerConfig): Promise<Tracker> {
  switch (config.kind) {
    case "linear": {
      const { LinearTracker } = await import("./linear-tracker.js");
      return new LinearTracker(config);
    }
    case "github-pr": {
      const { GitHubPRTracker } = await import("./github-pr-tracker.js");
      return new GitHubPRTracker(config);
    }
    case "github-issues": {
      const { GitHubIssuesTracker } = await import("./github-issues-tracker.js");
      return new GitHubIssuesTracker(config);
    }
    case "cron": {
      const { CronTracker } = await import("./cron-tracker.js");
      return new CronTracker(config);
    }
    case "jira": {
      const { JiraTracker } = await import("./jira.js");
      return new JiraTracker(config);
    }
    default:
      throw new Error(`Unknown tracker kind: ${(config as any).kind}`);
  }
}
