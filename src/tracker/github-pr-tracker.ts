/**
 * GitHub PR Tracker for Symphony
 * Implements Tracker interface using gh CLI for Pull Requests
 */

import type { Issue, Comment } from "../config/types.js";
import type { Tracker, TrackerConfig, FetchOptions } from "./interface.js";
import { execSync } from "child_process";

/**
 * Raw GitHub PR structure from gh CLI JSON output
 */
interface GitHubPR {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
  labels: { name: string }[];
  state: string; // "OPEN", "CLOSED", "MERGED"
  mergeable: string;
  createdAt: string;
  updatedAt: string;
  comments?: { author: { login: string }; body: string; createdAt: string }[];
  files?: { path: string }[];
}

/**
 * GitHub PR Tracker
 * Fetches Pull Requests from a GitHub repository using the gh CLI
 */
export class GitHubPRTracker implements Tracker {
  private repo: string;
  private excludedLabels: string[];
  private requiredLabels: string[];
  private activeStates: string[];
  private terminalStates: string[];

  /**
   * Create a new GitHub PR tracker
   * @param config - Tracker configuration (must include repo)
   * @throws Error if repo is not specified
   */
  constructor(config: TrackerConfig) {
    if (!config.repo) {
      throw new Error("GitHub PR tracker requires 'repo' in config (e.g., 'owner/repo')");
    }
    this.repo = config.repo;
    this.excludedLabels = config.excluded_labels ?? [];
    this.requiredLabels = config.required_labels ?? [];
    this.activeStates = config.active_states ?? ["open"];
    this.terminalStates = config.terminal_states ?? ["closed", "merged"];
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
   * Convert a GitHub PR to Symphony Issue format
   * @param pr - Raw GitHub PR from gh CLI
   * @returns Symphony Issue object
   */
  private prToIssue(pr: GitHubPR): Issue {
    // Normalize state: OPEN -> open, CLOSED -> closed, MERGED -> merged
    const normalizedState = pr.state.toLowerCase();

    return {
      id: `PR-${pr.number}`,
      identifier: `PR-${pr.number}`,
      title: pr.title,
      description: pr.body || "",
      priority: null,
      url: `https://github.com/${this.repo}/pull/${pr.number}`,
      branch_name: pr.headRefName,
      base_branch: pr.baseRefName,
      state: normalizedState,
      labels: pr.labels.map((l) => l.name),
      author: pr.author.login,
      files_changed: pr.files?.length ?? 0,
      number: pr.number,
      children: [],
      blocked_by: [],
      comments: (pr.comments ?? []).map((c) => ({
        id: `${pr.number}-${c.createdAt}`,
        body: c.body,
        created_at: new Date(c.createdAt),
        user: c.author.login,
      })),
      created_at: new Date(pr.createdAt),
      updated_at: new Date(pr.updatedAt),
    };
  }

  /**
   * Fetch PRs that are candidates for processing
   * @param options - Fetch options (labels, states, limit)
   * @returns Array of Symphony Issues
   */
  async fetchCandidates(options: FetchOptions): Promise<Issue[]> {
    const excludeLabels = [...this.excludedLabels, ...(options.excludedLabels ?? [])];
    const requireLabels = [...this.requiredLabels, ...(options.requiredLabels ?? [])];
    const activeStates = options.activeStates ?? this.activeStates;

    // Build state filter - gh pr list uses "open", "closed", "merged", or "all"
    const stateFilter = activeStates.includes("open") ? "open" : "all";

    // Fetch PRs with full details
    const prs = this.ghJson<GitHubPR[]>(
      `pr list --state ${stateFilter} --json number,title,body,headRefName,baseRefName,author,labels,state,mergeable,createdAt,updatedAt,files`
    );

    // Filter by labels and state
    const filtered = prs.filter((pr) => {
      const prLabels = pr.labels.map((l) => l.name);
      const prState = pr.state.toLowerCase();

      // Must be in active state
      if (!activeStates.some((s) => s.toLowerCase() === prState)) {
        return false;
      }

      // Must not have any excluded labels
      if (excludeLabels.some((el) => prLabels.includes(el))) {
        return false;
      }

      // Must have all required labels (if any)
      if (requireLabels.length > 0 && !requireLabels.every((rl) => prLabels.includes(rl))) {
        return false;
      }

      return true;
    });

    // Sort by created date (oldest first)
    filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Apply limit
    const limited = options.limit ? filtered.slice(0, options.limit) : filtered;

    return limited.map((pr) => this.prToIssue(pr));
  }

  /**
   * Get a single PR by identifier
   * @param identifier - PR identifier (e.g., "PR-123" or "123")
   * @returns Symphony Issue or null if not found
   */
  async getIssue(identifier: string): Promise<Issue | null> {
    const number = identifier.replace("PR-", "");
    try {
      const pr = this.ghJson<GitHubPR>(
        `pr view ${number} --json number,title,body,headRefName,baseRefName,author,labels,state,mergeable,createdAt,updatedAt,comments,files`
      );
      return this.prToIssue(pr);
    } catch {
      return null;
    }
  }

  /**
   * Fetch PRs in terminal states (for cleanup)
   * @param terminalStates - Array of terminal state names
   * @returns Array of Symphony Issues in terminal states
   */
  async fetchTerminalIssues(terminalStates: string[]): Promise<Issue[]> {
    // For GitHub PRs, "terminal" means closed/merged or having excluded label
    if (this.excludedLabels.length === 0 && terminalStates.length === 0) {
      return [];
    }

    // If looking for closed/merged PRs
    if (terminalStates.some((s) => ["closed", "merged"].includes(s.toLowerCase()))) {
      const prs = this.ghJson<GitHubPR[]>(
        `pr list --state closed --json number,title,body,headRefName,baseRefName,author,labels,state,createdAt,updatedAt`
      );
      return prs.map((pr) => this.prToIssue(pr));
    }

    // Otherwise look for open PRs with excluded labels
    if (this.excludedLabels.length > 0) {
      const prs = this.ghJson<GitHubPR[]>(
        `pr list --state open --label "${this.excludedLabels[0]}" --json number,title,body,headRefName,baseRefName,author,labels,state,createdAt,updatedAt`
      );
      return prs.map((pr) => this.prToIssue(pr));
    }

    return [];
  }

  /**
   * Batch fetch states for multiple PRs
   * @param ids - Array of PR identifiers
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
   * Add or update a comment on a PR
   * @param issueId - PR identifier
   * @param body - Comment body
   * @param commentId - Optional comment ID for updates (not supported by gh CLI)
   * @returns URL of the created comment
   */
  async upsertComment(issueId: string, body: string, commentId?: string): Promise<string> {
    const number = issueId.replace("PR-", "");
    // gh doesn't support editing comments easily, so we just add new ones
    const escapedBody = body.replace(/"/g, '\\"').replace(/`/g, '\\`');
    const result = this.gh(`pr comment ${number} --body "${escapedBody}"`);
    // Extract comment URL from result
    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    return match ? match[0] : "";
  }

  /**
   * Add a label to a PR
   * @param issueId - PR identifier
   * @param label - Label name to add
   */
  async addLabel(issueId: string, label: string): Promise<void> {
    const number = issueId.replace("PR-", "");
    this.gh(`pr edit ${number} --add-label "${label}"`);
  }

  /**
   * Remove a label from a PR
   * @param issueId - PR identifier
   * @param label - Label name to remove
   */
  async removeLabel(issueId: string, label: string): Promise<void> {
    const number = issueId.replace("PR-", "");
    this.gh(`pr edit ${number} --remove-label "${label}"`);
  }

  /**
   * Update PR state (close/reopen)
   * @param issueId - PR identifier
   * @param state - New state ("closed" or "open")
   */
  async updateState(issueId: string, state: string): Promise<void> {
    const number = issueId.replace("PR-", "");
    const normalizedState = state.toLowerCase();

    if (normalizedState === "closed" || normalizedState === "close") {
      this.gh(`pr close ${number}`);
    } else if (normalizedState === "open" || normalizedState === "reopen") {
      this.gh(`pr reopen ${number}`);
    }
    // "merged" state is handled via gh pr merge, but we don't support that here
    // as it requires more configuration (merge method, delete branch, etc.)
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
