/**
 * Linear Tracker Wrapper
 * Wraps existing LinearClient to implement Tracker interface
 */

import type { Issue } from "../config/types.js";
import type { Tracker, TrackerConfig, FetchOptions } from "./interface.js";
import { LinearClient } from "./client.js";

export class LinearTracker implements Tracker {
  private client: LinearClient;
  private config: TrackerConfig;

  constructor(config: TrackerConfig) {
    if (!config.api_key) {
      throw new Error("Linear tracker requires api_key");
    }
    this.config = config;
    this.client = new LinearClient(
      config.endpoint || "https://api.linear.app/graphql",
      config.api_key
    );
  }

  /** Expose underlying client for backwards compatibility */
  getLinearClient(): LinearClient {
    return this.client;
  }

  async fetchCandidates(options: FetchOptions): Promise<Issue[]> {
    const projectSlug = this.config.project_slug || "";
    const activeStates = options.activeStates || this.config.active_states || [];
    const requiredLabels = [...(this.config.required_labels || []), ...(options.requiredLabels || [])];
    const excludedLabels = [...(this.config.excluded_labels || []), ...(options.excludedLabels || [])];

    // Convert string arrays to proper format
    const activeStatesList = Array.isArray(activeStates) ? activeStates : [activeStates];
    const requiredLabelsList = Array.isArray(requiredLabels) ? requiredLabels : [requiredLabels];
    const excludedLabelsList = Array.isArray(excludedLabels) ? excludedLabels : [excludedLabels];

    // Fetch all issues in active states
    const issues = await this.client.fetchCandidateIssues(projectSlug, activeStatesList);

    // Filter by labels (client-side)
    return issues.filter((issue) => {
      // Must have all required labels
      if (requiredLabelsList.length > 0) {
        if (!requiredLabelsList.every((rl) => issue.labels.includes(rl))) {
          return false;
        }
      }
      // Must not have any excluded labels
      if (excludedLabelsList.some((el) => issue.labels.includes(el))) {
        return false;
      }
      return true;
    });
  }

  async getIssue(identifier: string): Promise<Issue | null> {
    const raw = await this.client.getIssue(identifier);
    if (!raw) return null;
    // Transform Linear's raw response to Issue interface
    // Note: Linear client returns different shape, we normalize here
    return {
      id: raw.id,
      identifier: raw.identifier,
      title: raw.title,
      description: raw.description,
      priority: null,
      state: raw.state.name,
      branch_name: null,
      url: null,
      labels: raw.labels.nodes.map((l) => l.name),
      blocked_by: [],
      children: raw.children.nodes.map((c, idx) => ({
        id: c.id,
        identifier: c.identifier,
        title: c.title,
        description: c.description,
        priority: c.priority,
        state: c.state.name,
        state_type: c.state.type || "unstarted",
        sort_order: idx,
        assignee: null,
        created_at: null,
        updated_at: null,
      })),
      comments: raw.comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        created_at: new Date(c.createdAt),
        user: c.user?.name || null,
      })),
      created_at: null,
      updated_at: null,
    } as Issue;
  }

  async fetchTerminalIssues(terminalStates: string[]): Promise<Issue[]> {
    const projectSlug = this.config.project_slug || "";
    return this.client.fetchIssuesByStates(projectSlug, terminalStates);
  }

  async fetchStatesByIds(ids: string[]): Promise<Map<string, string>> {
    return this.client.fetchIssueStatesByIds(ids);
  }

  async upsertComment(issueId: string, body: string, commentId?: string): Promise<string> {
    return this.client.upsertComment(issueId, body, commentId ?? null);
  }

  async addLabel(issueId: string, label: string): Promise<void> {
    // Linear requires teamId for addLabel - fetch issue first to get team
    const issue = await this.client.getIssue(issueId);
    if (!issue) return;
    const teamId = (issue as any).team?.id;
    if (!teamId) return;
    await this.client.addLabel(issueId, label, teamId);
  }

  async removeLabel(issueId: string, label: string): Promise<void> {
    await this.client.removeLabel(issueId, label);
  }

  async updateState(issueId: string, state: string): Promise<void> {
    // Find the state ID first, then update
    const issue = await this.client.getIssue(issueId);
    if (!issue) return;
    const teamId = (issue as any).team?.id;
    if (!teamId) return;
    
    const stateId = await this.client.findStateId(teamId, state);
    if (!stateId) return;
    
    await this.client.updateIssue(issueId, { stateId });
  }

  getRateLimitState() {
    const state = this.client.getRateLimitState();
    return {
      remaining: state.requestsRemaining,
      limit: state.requestsLimit,
      reset: state.requestsReset,
    };
  }
}
