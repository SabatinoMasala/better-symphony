/**
 * GitHub Issues Tracker for Symphony
 * Implements Tracker interface using gh CLI for GitHub Issues (not PRs)
 */

import type { Issue, Comment } from "../config/types.js";
import type { Tracker, TrackerConfig, FetchOptions } from "./interface.js";
import { execSync } from "child_process";

/**
 * Raw GitHub issue structure from gh CLI JSON output
 */
interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  labels: { name: string }[];
  state: string; // "OPEN" or "CLOSED"
  assignees: { login: string }[];
  milestone: { title: string } | null;
  createdAt: string;
  updatedAt: string;
  comments?: { author: { login: string }; body: string; createdAt: string }[];
}

/**
 * GitHub Issues Tracker
 * Fetches issues from a GitHub repository using the gh CLI
 */
export class GitHubIssuesTracker implements Tracker {
  private repo: string;
  private excludedLabels: string[];
  private requiredLabels: string[];
  private activeStates: string[];
  private terminalStates: string[];

  /**
   * Create a new GitHub Issues tracker
   * @param config - Tracker configuration (must include repo)
   * @throws Error if repo is not specified
   */
  constructor(config: TrackerConfig) {
    if (!config.repo) {
      throw new Error("GitHub Issues tracker requires 'repo' in config (e.g., 'owner/repo')");
    }
    this.repo = config.repo;
    this.excludedLabels = config.excluded_labels ?? [];
    this.requiredLabels = config.required_labels ?? [];
    this.activeStates = config.active_states ?? ["open"];
    this.terminalStates = config.terminal_states ?? ["closed"];
  }

  /**
   * Execute a gh CLI command
   * @param args - Arguments to pass to gh
   * @returns Command output as string
   */
  private gh(args: string): string {
    try {
      return execSync(`gh ${args}`, {
        encoding: "utf-8",
        timeout: 30000,
        env: { ...process.env, GH_REPO: this.repo },
      }).trim();
    } catch (err: any) {
      throw new Error(`gh CLI failed: ${err.message}`);
    }
  }

  /**
   * Execute a gh CLI command and parse JSON output
   * @param args - Arguments to pass to gh
   * @returns Parsed JSON response
   */
  private ghJson<T>(args: string): T {
    const output = this.gh(args);
    return JSON.parse(output) as T;
  }

  /**
   * Convert a GitHub issue to Symphony Issue format
   * @param issue - Raw GitHub issue from gh CLI
   * @returns Symphony Issue object
   */
  private issueToSymphonyIssue(issue: GitHubIssue): Issue {
    return {
      id: `ISSUE-${issue.number}`,
      identifier: `ISSUE-${issue.number}`,
      title: issue.title,
      description: issue.body || "",
      priority: null,
      url: `https://github.com/${this.repo}/issues/${issue.number}`,
      branch_name: null,
      state: issue.state === "OPEN" ? "open" : "closed",
      labels: issue.labels.map((l) => l.name),
      author: issue.author.login,
      number: issue.number,
      children: [],
      blocked_by: [],
      comments: (issue.comments ?? []).map((c) => ({
        id: `${issue.number}-${c.createdAt}`,
        body: c.body,
        created_at: new Date(c.createdAt),
        user: c.author.login,
      })),
      created_at: new Date(issue.createdAt),
      updated_at: new Date(issue.updatedAt),
    };
  }

  /**
   * Fetch issues that are candidates for processing
   * @param options - Fetch options (labels, states, limit)
   * @returns Array of Symphony Issues
   */
  async fetchCandidates(options: FetchOptions): Promise<Issue[]> {
    const excludeLabels = [...this.excludedLabels, ...(options.excludedLabels ?? [])];
    const requireLabels = [...this.requiredLabels, ...(options.requiredLabels ?? [])];
    const activeStates = options.activeStates ?? this.activeStates;

    // Build state filter - gh issue list uses "open" or "closed"
    const stateFilter = activeStates.includes("open") ? "open" : "closed";

    // Build label filter for required labels
    const labelFilter = requireLabels.length > 0
      ? requireLabels.map((l) => `--label "${l}"`).join(" ")
      : "";

    // Fetch issues with full details
    const issues = this.ghJson<GitHubIssue[]>(
      `issue list --state ${stateFilter} ${labelFilter} --json number,title,body,author,labels,state,assignees,milestone,createdAt,updatedAt`
    );

    // Filter by excluded labels
    const filtered = issues.filter((issue) => {
      const issueLabels = issue.labels.map((l) => l.name);

      // Must not have any excluded labels
      if (excludeLabels.some((el) => issueLabels.includes(el))) {
        return false;
      }

      return true;
    });

    // Sort by created date (oldest first)
    filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Apply limit
    const limited = options.limit ? filtered.slice(0, options.limit) : filtered;

    return limited.map((issue) => this.issueToSymphonyIssue(issue));
  }

  /**
   * Get a single issue by identifier
   * @param identifier - Issue identifier (e.g., "ISSUE-123" or "123")
   * @returns Symphony Issue or null if not found
   */
  async getIssue(identifier: string): Promise<Issue | null> {
    const number = identifier.replace("ISSUE-", "");
    try {
      const issue = this.ghJson<GitHubIssue>(
        `issue view ${number} --json number,title,body,author,labels,state,assignees,milestone,createdAt,updatedAt,comments`
      );
      return this.issueToSymphonyIssue(issue);
    } catch {
      return null;
    }
  }

  /**
   * Fetch issues in terminal states (for cleanup)
   * @param terminalStates - Array of terminal state names
   * @returns Array of Symphony Issues in terminal states
   */
  async fetchTerminalIssues(terminalStates: string[]): Promise<Issue[]> {
    // For GitHub Issues, "terminal" typically means closed
    // Or having the excluded label
    if (this.excludedLabels.length === 0 && !terminalStates.includes("closed")) {
      return [];
    }

    // Fetch closed issues with excluded labels
    const labelFilter = this.excludedLabels.length > 0
      ? `--label "${this.excludedLabels[0]}"`
      : "";

    const state = terminalStates.includes("closed") ? "closed" : "all";

    const issues = this.ghJson<GitHubIssue[]>(
      `issue list --state ${state} ${labelFilter} --json number,title,body,author,labels,state,createdAt,updatedAt`
    );

    return issues.map((issue) => this.issueToSymphonyIssue(issue));
  }

  /**
   * Batch fetch states for multiple issues
   * @param ids - Array of issue identifiers
   * @returns Map of identifier to state
   */
  async fetchStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const id of ids) {
      const issue = await this.getIssue(id);
      if (issue) {
        result.set(id, issue.state);
      }
    }
    return result;
  }

  /**
   * Add or update a comment on an issue
   * @param issueId - Issue identifier
   * @param body - Comment body
   * @param commentId - Optional comment ID for updates (not supported by gh CLI)
   * @returns URL of the created comment
   */
  async upsertComment(issueId: string, body: string, commentId?: string): Promise<string> {
    const number = issueId.replace("ISSUE-", "");
    // gh doesn't support editing comments easily, so we just add new ones
    const escapedBody = body.replace(/"/g, '\\"').replace(/`/g, '\\`');
    const result = this.gh(`issue comment ${number} --body "${escapedBody}"`);
    // Extract comment URL from result
    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    return match ? match[0] : "";
  }

  /**
   * Add a label to an issue
   * @param issueId - Issue identifier
   * @param label - Label name to add
   */
  async addLabel(issueId: string, label: string): Promise<void> {
    const number = issueId.replace("ISSUE-", "");
    this.gh(`issue edit ${number} --add-label "${label}"`);
  }

  /**
   * Remove a label from an issue
   * @param issueId - Issue identifier
   * @param label - Label name to remove
   */
  async removeLabel(issueId: string, label: string): Promise<void> {
    const number = issueId.replace("ISSUE-", "");
    this.gh(`issue edit ${number} --remove-label "${label}"`);
  }

  /**
   * Update issue state (open/close)
   * @param issueId - Issue identifier
   * @param state - New state ("open" or "closed")
   */
  async updateState(issueId: string, state: string): Promise<void> {
    const number = issueId.replace("ISSUE-", "");
    const normalizedState = state.toLowerCase();

    if (normalizedState === "closed" || normalizedState === "close") {
      this.gh(`issue close ${number}`);
    } else if (normalizedState === "open" || normalizedState === "reopen") {
      this.gh(`issue reopen ${number}`);
    }
    // Other states are handled via labels
  }

  /**
   * Get rate limit state
   * gh CLI handles rate limiting internally, so return generous defaults
   */
  getRateLimitState() {
    return {
      remaining: 5000,
      limit: 5000,
      reset: Date.now() + 3600000,
    };
  }
}
