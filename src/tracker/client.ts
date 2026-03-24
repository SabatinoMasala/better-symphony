/**
 * Linear GraphQL Client for Symphony
 * Implements Issue Tracker Client per Symphony Spec
 */

import type { Issue, BlockerRef, ChildIssue, Comment } from "../config/types.js";
import { TrackerError } from "../config/types.js";
import type {
  RateLimitState,
  LinearIssueNode,
  LinearIssuesData,
  LinearIssueStatesData,
  GraphQLResponse,
} from "./types.js";
import * as Q from "./queries.js";

const MAX_RETRIES = 3;
const NETWORK_TIMEOUT_MS = 30000;
const PAGE_SIZE = 50;

export class LinearClient {
  private endpoint: string;
  private apiKey: string;
  private rateLimitState: RateLimitState = {
    requestsLimit: 5000,
    requestsRemaining: 5000,
    requestsReset: 0,
    complexityLimit: 250000,
    complexityRemaining: 250000,
    complexityReset: 0,
  };

  onRateLimit?: (attempt: number, waitSecs: number) => void;
  onThrottle?: (remaining: number, limit: number) => void;

  constructor(endpoint: string, apiKey: string) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
  }

  getRateLimitState(): RateLimitState {
    return { ...this.rateLimitState };
  }

  private parseRateLimitHeaders(response: Response): void {
    const requestsLimit = response.headers.get("X-RateLimit-Requests-Limit");
    if (requestsLimit !== null) {
      this.rateLimitState.requestsLimit = parseInt(requestsLimit, 10);
    }

    const requestsRemaining = response.headers.get("X-RateLimit-Requests-Remaining");
    if (requestsRemaining !== null) {
      this.rateLimitState.requestsRemaining = parseInt(requestsRemaining, 10);
    }

    const requestsReset = response.headers.get("X-RateLimit-Requests-Reset");
    if (requestsReset !== null) {
      this.rateLimitState.requestsReset = parseInt(requestsReset, 10) * 1000;
    }

    const complexityLimit = response.headers.get("X-RateLimit-Complexity-Limit");
    if (complexityLimit !== null) {
      this.rateLimitState.complexityLimit = parseInt(complexityLimit, 10);
    }

    const complexityRemaining = response.headers.get("X-RateLimit-Complexity-Remaining");
    if (complexityRemaining !== null) {
      this.rateLimitState.complexityRemaining = parseInt(complexityRemaining, 10);
    }

    const complexityReset = response.headers.get("X-RateLimit-Complexity-Reset");
    if (complexityReset !== null) {
      this.rateLimitState.complexityReset = parseInt(complexityReset, 10) * 1000;
    }
  }

  // ── Core GraphQL ─────────────────────────────────────────────

  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<GraphQLResponse<T>> {
    const payload: Record<string, unknown> = { query };
    if (Object.keys(variables).length > 0) {
      payload.variables = variables;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Proactive throttling when remaining requests drop below 10%
      const { requestsRemaining, requestsLimit, requestsReset } = this.rateLimitState;
      const ratio = requestsLimit > 0 ? requestsRemaining / requestsLimit : 1;

      if (ratio < 0.1 && requestsRemaining > 0) {
        const resetMs = Math.max(0, requestsReset - Date.now());
        const delay = Math.min(5000, Math.ceil(resetMs / requestsRemaining));
        if (delay > 100) {
          this.onThrottle?.(requestsRemaining, requestsLimit);
          await Bun.sleep(delay);
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        if ((err as Error).name === "AbortError") {
          throw new TrackerError("linear_api_request", "Request timed out");
        }
        throw new TrackerError("linear_api_request", `Network error: ${(err as Error).message}`);
      } finally {
        clearTimeout(timeout);
      }

      this.parseRateLimitHeaders(response);

      const data = await response.json() as GraphQLResponse<T>;

      // Detect rate limit
      const isRateLimited = data.errors?.[0]?.extensions?.code === "RATELIMITED";

      if (isRateLimited) {
        if (attempt === MAX_RETRIES) {
          const waitSecs = Math.max(1, Math.ceil((this.rateLimitState.requestsReset - Date.now()) / 1000));
          throw new TrackerError("linear_api_request", `Rate limited by Linear. Retry after ${waitSecs}s`);
        }

        const resetMs = this.rateLimitState.requestsReset - Date.now();
        const waitMs = Math.max(500, resetMs) + Math.random() * 1500 + 500;
        this.onRateLimit?.(attempt, Math.ceil(waitMs / 1000));
        await Bun.sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        throw new TrackerError(
          "linear_api_status",
          `API request failed with status ${response.status}: ${JSON.stringify(data)}`
        );
      }

      if (data.errors && data.errors.length > 0) {
        const msg = data.errors[0]?.message ?? "Unknown GraphQL error";
        throw new TrackerError("linear_graphql_errors", `GraphQL error: ${msg}`);
      }

      return data;
    }

    throw new TrackerError("linear_api_request", "Max retries exceeded");
  }

  // ── Issue Normalization ──────────────────────────────────────

  private normalizeIssue(node: LinearIssueNode): Issue {
    // Extract blockers from inverse relations where type is "blocks"
    const blockers: BlockerRef[] = [];
    if (node.inverseRelations?.nodes) {
      for (const rel of node.inverseRelations.nodes) {
        if (rel.type === "blocks") {
          blockers.push({
            id: rel.issue.id,
            identifier: rel.issue.identifier,
            state: rel.issue.state.name,
          });
        }
      }
    }

    // Normalize children/subtasks
    const children: ChildIssue[] = [];
    if (node.children?.nodes) {
      for (const child of node.children.nodes) {
        children.push({
          id: child.id,
          identifier: child.identifier,
          title: child.title,
          description: child.description,
          priority: typeof child.priority === "number" ? child.priority : null,
          state: child.state.name,
          state_type: child.state.type,
          sort_order: child.subIssueSortOrder ?? 0,
          assignee: child.assignee?.name ?? null,
          created_at: child.createdAt ? new Date(child.createdAt) : null,
          updated_at: child.updatedAt ? new Date(child.updatedAt) : null,
        });
      }
      // Sort by sort_order
      children.sort((a, b) => a.sort_order - b.sort_order);
    }

    // Normalize comments
    const comments: Comment[] = [];
    if (node.comments?.nodes) {
      for (const c of node.comments.nodes) {
        comments.push({
          id: c.id,
          body: c.body,
          user: c.user?.name ?? null,
          created_at: c.createdAt ? new Date(c.createdAt) : null,
        });
      }
    }

    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description,
      priority: typeof node.priority === "number" ? node.priority : null,
      state: node.state.name,
      branch_name: node.branchName,
      url: node.url,
      labels: node.labels.nodes.map((l) => l.name.toLowerCase()),
      blocked_by: blockers,
      children,
      comments,
      created_at: node.createdAt ? new Date(node.createdAt) : null,
      updated_at: node.updatedAt ? new Date(node.updatedAt) : null,
    };
  }

  // ── Tracker Operations ───────────────────────────────────────

  /**
   * Fetch candidate issues in active states for a project
   */
  async fetchCandidateIssues(projectSlug: string, activeStates: string[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    let cursor: string | null = null;

    do {
      const response: GraphQLResponse<LinearIssuesData> = await this.graphql(Q.FETCH_CANDIDATE_ISSUES, {
        projectSlug,
        states: activeStates,
        after: cursor,
      });

      if (!response.data?.issues) {
        throw new TrackerError("linear_unknown_payload", "Unexpected response structure from Linear");
      }

      for (const node of response.data.issues.nodes) {
        issues.push(this.normalizeIssue(node));
      }

      if (response.data.issues.pageInfo.hasNextPage) {
        if (!response.data.issues.pageInfo.endCursor) {
          throw new TrackerError("linear_missing_end_cursor", "Pagination cursor missing");
        }
        cursor = response.data.issues.pageInfo.endCursor;
      } else {
        cursor = null;
      }
    } while (cursor);

    return issues;
  }

  /**
   * Fetch issues in specified states (for startup terminal cleanup)
   */
  async fetchIssuesByStates(projectSlug: string, states: string[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    let cursor: string | null = null;

    do {
      const response: GraphQLResponse<LinearIssuesData> = await this.graphql(Q.FETCH_ISSUES_BY_STATES, {
        projectSlug,
        states,
        after: cursor,
      });

      if (!response.data?.issues) {
        throw new TrackerError("linear_unknown_payload", "Unexpected response structure from Linear");
      }

      for (const node of response.data.issues.nodes) {
        issues.push(this.normalizeIssue(node));
      }

      if (response.data.issues.pageInfo.hasNextPage) {
        if (!response.data.issues.pageInfo.endCursor) {
          throw new TrackerError("linear_missing_end_cursor", "Pagination cursor missing");
        }
        cursor = response.data.issues.pageInfo.endCursor;
      } else {
        cursor = null;
      }
    } while (cursor);

    return issues;
  }

  /**
   * Fetch current states for specific issue IDs (for reconciliation)
   */
  async fetchIssueStatesByIds(issueIds: string[]): Promise<Map<string, string>> {
    if (issueIds.length === 0) {
      return new Map();
    }

    const response: GraphQLResponse<LinearIssueStatesData> = await this.graphql(Q.FETCH_ISSUES_BY_IDS, {
      ids: issueIds,
    });

    if (!response.data?.issues) {
      throw new TrackerError("linear_unknown_payload", "Unexpected response structure from Linear");
    }

    const stateMap = new Map<string, string>();
    for (const node of response.data.issues.nodes) {
      stateMap.set(node.id, node.state.name);
    }

    return stateMap;
  }

  // ── CRUD Operations (used by linear CLI) ───────────────────────

  /**
   * Get a single issue by identifier (e.g. "SYM-123")
   */
  async getIssue(identifier: string): Promise<{
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    state: { id: string; name: string; type: string };
    team: { id: string };
    labels: { nodes: Array<{ id: string; name: string }> };
    children: { nodes: Array<{ id: string; identifier: string; title: string; description: string | null; priority: number | null; state: { id: string; name: string; type: string } }> };
    comments: { nodes: Array<{ id: string; body: string; createdAt: string; user?: { name: string } | null }> };
  } | null> {
    const response = await this.graphql<{ issue: any }>(Q.GET_ISSUE, { identifier });
    return response.data?.issue ?? null;
  }

  /**
   * Get comments for an issue (up to 50)
   */
  async getComments(identifier: string): Promise<Array<{ id: string; body: string; createdAt: string; user: string | null }>> {
    const issue = await this.getIssue(identifier);
    if (!issue) return [];

    const response = await this.graphql<{ issue: { comments: { nodes: Array<{ id: string; body: string; createdAt: string; user?: { name: string } | null }> } } }>(Q.GET_COMMENTS, { issueId: issue.id });
    const nodes = response.data?.issue?.comments?.nodes ?? [];
    return nodes.map(c => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      user: c.user?.name ?? null,
    }));
  }

  /**
   * Create a new issue
   */
  async createIssue(input: Record<string, unknown>): Promise<{ id: string; identifier: string; title: string; url: string }> {
    const response = await this.graphql<{ issueCreate: { success: boolean; issue: any } }>(Q.CREATE_ISSUE, { input });
    if (!response.data?.issueCreate?.success) {
      throw new TrackerError("linear_api_request", "Failed to create issue");
    }
    return response.data.issueCreate.issue;
  }

  /**
   * Update an existing issue
   */
  async updateIssue(issueId: string, input: Record<string, unknown>): Promise<void> {
    const response = await this.graphql<{ issueUpdate: { success: boolean } }>(Q.UPDATE_ISSUE, { issueId, input });
    if (!response.data?.issueUpdate?.success) {
      throw new TrackerError("linear_api_request", "Failed to update issue");
    }
  }

  /**
   * Create a comment on an issue
   */
  async createComment(issueId: string, body: string): Promise<string> {
    const response = await this.graphql<{ commentCreate: { success: boolean; comment: { id: string } } }>(Q.CREATE_COMMENT, { issueId, body });
    if (!response.data?.commentCreate?.success) {
      throw new TrackerError("linear_api_request", "Failed to create comment");
    }
    return response.data.commentCreate.comment.id;
  }

  /**
   * Update an existing comment
   */
  async updateComment(commentId: string, body: string): Promise<void> {
    const response = await this.graphql<{ commentUpdate: { success: boolean } }>(Q.UPDATE_COMMENT, { commentId, body });
    if (!response.data?.commentUpdate?.success) {
      throw new TrackerError("linear_api_request", "Failed to update comment");
    }
  }

  /**
   * Create or update a comment. If commentId is provided and valid, updates it; otherwise creates new.
   */
  async upsertComment(issueId: string, body: string, commentId: string | null): Promise<string> {
    if (commentId) {
      try {
        await this.updateComment(commentId, body);
        return commentId;
      } catch {
        // Comment may have been deleted — fall through to create
      }
    }
    return this.createComment(issueId, body);
  }

  /**
   * Get labels on an issue
   */
  async getIssueLabels(issueId: string): Promise<Array<{ id: string; name: string }>> {
    const response = await this.graphql<{ issue: { labels: { nodes: Array<{ id: string; name: string }> } } }>(Q.GET_ISSUE_LABELS, { issueId });
    return response.data?.issue?.labels?.nodes ?? [];
  }

  /**
   * Set all labels on an issue (replaces existing)
   */
  async setIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
    await this.updateIssue(issueId, { labelIds });
  }

  /**
   * Atomically swap one label for another on an issue
   */
  async swapLabel(issueId: string, removeLabelName: string, addLabelName: string, teamId: string): Promise<void> {
    const currentLabels = await this.getIssueLabels(issueId);
    const currentIds = currentLabels.map(l => l.id);

    // Resolve label names to IDs
    const removeLabel = currentLabels.find(l => l.name.toLowerCase() === removeLabelName.toLowerCase());
    if (!removeLabel) {
      throw new TrackerError("linear_api_request", `Label "${removeLabelName}" not found on issue`);
    }

    // Find or create the add label
    const addLabelId = await this.ensureLabel(teamId, addLabelName);

    const newIds = currentIds.filter(id => id !== removeLabel.id);
    if (!newIds.includes(addLabelId)) {
      newIds.push(addLabelId);
    }

    await this.setIssueLabels(issueId, newIds);
  }

  /**
   * Add a label to an issue (by name, creates if needed)
   */
  async addLabel(issueId: string, labelName: string, teamId: string, color?: string): Promise<void> {
    const currentLabels = await this.getIssueLabels(issueId);
    const alreadyHas = currentLabels.some(l => l.name.toLowerCase() === labelName.toLowerCase());
    if (alreadyHas) return;

    const labelId = await this.ensureLabel(teamId, labelName, color);
    const newIds = [...currentLabels.map(l => l.id), labelId];
    await this.setIssueLabels(issueId, newIds);
  }

  /**
   * Remove a label from an issue (by name)
   */
  async removeLabel(issueId: string, labelName: string): Promise<void> {
    const currentLabels = await this.getIssueLabels(issueId);
    const removeLabel = currentLabels.find(l => l.name.toLowerCase() === labelName.toLowerCase());
    if (!removeLabel) return;

    const newIds = currentLabels.map(l => l.id).filter(id => id !== removeLabel.id);
    await this.setIssueLabels(issueId, newIds);
  }

  /**
   * Ensure a label exists on a team, returning its ID
   */
  async ensureLabel(teamId: string, labelName: string, color?: string): Promise<string> {
    const response = await this.graphql<{ team: { labels: { nodes: Array<{ id: string; name: string }> } } }>(Q.GET_TEAM_LABELS, { teamId });
    const labels = response.data?.team?.labels?.nodes ?? [];

    for (const label of labels) {
      if (label.name.toLowerCase() === labelName.toLowerCase()) {
        return label.id;
      }
    }

    // Create it
    const createResponse = await this.graphql<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } } }>(Q.CREATE_LABEL, {
      input: { teamId, name: labelName, color: color ?? "#888888" },
    });

    if (!createResponse.data?.issueLabelCreate?.success) {
      throw new TrackerError("linear_api_request", `Failed to create label "${labelName}"`);
    }

    return createResponse.data.issueLabelCreate.issueLabel.id;
  }

  /**
   * Get attachments for an issue
   */
  async getAttachments(issueId: string): Promise<Array<{ id: string; title: string | null; url: string }>> {
    const response = await this.graphql<{ issue: { attachments: { nodes: Array<{ id: string; title: string | null; url: string }> } } }>(Q.GET_ISSUE_ATTACHMENTS, { issueId });
    return response.data?.issue?.attachments?.nodes ?? [];
  }

  /**
   * Find a state ID by name within a team
   */
  async findStateId(teamId: string, stateName: string): Promise<string | null> {
    const response = await this.graphql<{ team: { states: { nodes: Array<{ id: string; name: string }> } } }>(Q.FIND_STATE_ID, { teamId });
    const states = response.data?.team?.states?.nodes ?? [];

    for (const state of states) {
      if (state.name.toLowerCase() === stateName.toLowerCase()) {
        return state.id;
      }
    }

    return null;
  }

  /**
   * Execute arbitrary GraphQL query (for linear_graphql tool)
   */
  async executeGraphQL(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    // Validate query is non-empty
    if (!query || !query.trim()) {
      return { success: false, error: "Query must be a non-empty string" };
    }

    // Simple check for multiple operations (naive but catches common cases)
    const operationMatches = query.match(/\b(query|mutation|subscription)\b/gi);
    if (operationMatches && operationMatches.length > 1) {
      return {
        success: false,
        error: "Query must contain exactly one GraphQL operation",
      };
    }

    try {
      const response = await this.graphql<unknown>(query, variables || {});

      if (response.errors && response.errors.length > 0) {
        return {
          success: false,
          data: response.data,
          error: response.errors.map((e) => e.message).join("; "),
        };
      }

      return { success: true, data: response.data };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
      };
    }
  }
}
