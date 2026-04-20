/**
 * Jira Cloud Tracker for Symphony
 * Implements Tracker interface using the Jira Cloud REST API v3.
 *
 * Auth: Basic auth with base64(JIRA_EMAIL:JIRA_API_TOKEN).
 * Host: JIRA_HOST (e.g., "your-org.atlassian.net").
 */

import type { Issue } from "../config/types.js";
import type { Tracker, TrackerConfig, FetchOptions } from "./interface.js";

interface JiraUser {
  displayName?: string;
  emailAddress?: string;
  accountId?: string;
}

interface JiraComment {
  id: string;
  author?: JiraUser;
  body?: unknown; // ADF document or string
  created?: string;
}

interface JiraSubtask {
  id: string;
  key: string;
  fields: {
    summary: string;
    status?: { name: string; statusCategory?: { key: string } };
    priority?: { name: string } | null;
  };
}

interface JiraIssueRaw {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: unknown; // ADF or null
    labels: string[];
    status: { name: string; statusCategory?: { key: string } };
    priority?: { name: string } | null;
    creator?: JiraUser;
    reporter?: JiraUser;
    assignee?: JiraUser | null;
    created?: string;
    updated?: string;
    comment?: { comments: JiraComment[] };
    subtasks?: JiraSubtask[];
    project?: { id: string; key: string };
    issuetype?: { name: string; subtask?: boolean };
  };
}

interface JiraSearchResponse {
  issues: JiraIssueRaw[];
  total: number;
}

const JIRA_PRIORITY_MAP: Record<string, number> = {
  highest: 1,
  high: 2,
  medium: 3,
  low: 4,
  lowest: 4,
};

/**
 * Flatten an Atlassian Document Format (ADF) node tree into plain text.
 * Accepts strings passthrough for legacy fields.
 */
function adfToText(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  let out = "";
  if (typeof n.text === "string") out += n.text;
  if (Array.isArray(n.content)) {
    for (const child of n.content) {
      out += adfToText(child);
    }
    // Add line break after block-level nodes
    if (
      n.type === "paragraph" ||
      n.type === "heading" ||
      n.type === "bulletList" ||
      n.type === "orderedList" ||
      n.type === "listItem" ||
      n.type === "codeBlock"
    ) {
      out += "\n";
    }
  }
  return out;
}

/** Wrap plain text into a minimal ADF document for write operations. */
function textToAdf(text: string): object {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

export class JiraTracker implements Tracker {
  private host: string;
  private email: string;
  private token: string;
  private authHeader: string;
  private projectKey: string;
  private requiredLabels: string[];
  private excludedLabels: string[];
  private activeStates: string[];
  private terminalStates: string[];

  constructor(config: TrackerConfig) {
    const host = process.env.JIRA_HOST;
    const email = process.env.JIRA_EMAIL;
    const token = process.env.JIRA_API_TOKEN;
    if (!host || !email || !token) {
      throw new Error(
        "Jira tracker requires JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN environment variables"
      );
    }
    if (!config.project_slug) {
      throw new Error("Jira tracker requires 'project_slug' in config (the Jira project key, e.g. 'PROJ')");
    }

    this.host = host.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.email = email;
    this.token = token;
    this.authHeader = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
    this.projectKey = config.project_slug;
    this.requiredLabels = (config.required_labels as string[]) || [];
    this.excludedLabels = (config.excluded_labels as string[]) || [];
    this.activeStates = (config.active_states as string[]) || [];
    this.terminalStates = (config.terminal_states as string[]) || ["Done", "Closed", "Cancelled"];
  }

  // ── HTTP ────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `https://${this.host}/rest/api/3${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ── Normalization ──────────────────────────────────────────────

  private normalize(raw: JiraIssueRaw): Issue {
    const priorityName = raw.fields.priority?.name?.toLowerCase();
    const priority = priorityName ? JIRA_PRIORITY_MAP[priorityName] ?? null : null;

    const comments = (raw.fields.comment?.comments ?? []).map((c) => ({
      id: c.id,
      body: adfToText(c.body).trim(),
      user: c.author?.displayName ?? c.author?.emailAddress ?? null,
      created_at: c.created ? new Date(c.created) : null,
    }));

    const children = (raw.fields.subtasks ?? []).map((st, idx) => {
      const stateName = st.fields.status?.name ?? "Unknown";
      const stateType = (st.fields.status?.statusCategory?.key ?? "unstarted").toLowerCase();
      return {
        id: st.id,
        identifier: st.key,
        title: st.fields.summary,
        description: null,
        priority: st.fields.priority?.name
          ? JIRA_PRIORITY_MAP[st.fields.priority.name.toLowerCase()] ?? null
          : null,
        state: stateName,
        state_type: stateType,
        sort_order: idx,
        assignee: null,
        created_at: null,
        updated_at: null,
      };
    });

    return {
      id: raw.id,
      identifier: raw.key,
      title: raw.fields.summary,
      description: adfToText(raw.fields.description).trim() || null,
      priority,
      state: raw.fields.status.name,
      branch_name: raw.key.toLowerCase(),
      url: `https://${this.host}/browse/${raw.key}`,
      labels: raw.fields.labels ?? [],
      blocked_by: [],
      children,
      comments,
      created_at: raw.fields.created ? new Date(raw.fields.created) : null,
      updated_at: raw.fields.updated ? new Date(raw.fields.updated) : null,
      author: raw.fields.creator?.displayName ?? raw.fields.reporter?.displayName,
    };
  }

  // ── JQL Builder ────────────────────────────────────────────────

  private buildJql(requireLabels: string[], excludeLabels: string[]): string {
    const parts: string[] = [`project = "${this.projectKey}"`];

    for (const label of requireLabels) {
      parts.push(`labels = "${label}"`);
    }
    for (const label of excludeLabels) {
      parts.push(`labels != "${label}"`);
    }

    if (this.terminalStates.length > 0) {
      const quoted = this.terminalStates.map((s) => `"${s}"`).join(", ");
      parts.push(`status not in (${quoted})`);
    }

    return parts.join(" AND ") + " ORDER BY created ASC";
  }

  // ── Tracker Interface ──────────────────────────────────────────

  async fetchCandidates(options: FetchOptions): Promise<Issue[]> {
    const requireLabels = [...new Set([...this.requiredLabels, ...(options.requiredLabels ?? [])])];
    const excludeLabels = [...new Set([...this.excludedLabels, ...(options.excludedLabels ?? [])])];

    const jql = this.buildJql(requireLabels, excludeLabels);
    const limit = options.limit ?? 50;

    const params = new URLSearchParams({
      jql,
      maxResults: String(limit),
      fields: "summary,description,labels,status,priority,creator,reporter,assignee,created,updated,comment,subtasks,project,issuetype",
    });

    const response = await this.request<JiraSearchResponse>("GET", `/search/jql?${params.toString()}`);
    return response.issues.map((i) => this.normalize(i));
  }

  async getIssue(identifier: string): Promise<Issue | null> {
    try {
      const raw = await this.request<JiraIssueRaw>(
        "GET",
        `/issue/${encodeURIComponent(identifier)}?fields=summary,description,labels,status,priority,creator,reporter,assignee,created,updated,comment,subtasks,project,issuetype`
      );
      return this.normalize(raw);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("404")) return null;
      throw err;
    }
  }

  async fetchTerminalIssues(terminalStates: string[]): Promise<Issue[]> {
    const states = terminalStates.length > 0 ? terminalStates : this.terminalStates;
    if (states.length === 0) return [];
    const quoted = states.map((s) => `"${s}"`).join(", ");
    const jql = `project = "${this.projectKey}" AND status in (${quoted}) ORDER BY updated DESC`;
    const params = new URLSearchParams({
      jql,
      maxResults: "50",
      fields: "summary,labels,status,created,updated",
    });
    const response = await this.request<JiraSearchResponse>("GET", `/search/jql?${params.toString()}`);
    return response.issues.map((i) => this.normalize(i));
  }

  async fetchStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const id of ids) {
      const issue = await this.getIssue(id);
      if (issue) result.set(id, issue.state);
    }
    return result;
  }

  async upsertComment(issueId: string, body: string): Promise<string> {
    const res = await this.request<{ id: string }>(
      "POST",
      `/issue/${encodeURIComponent(issueId)}/comment`,
      { body: textToAdf(body) }
    );
    return res.id;
  }

  async addLabel(issueId: string, label: string): Promise<void> {
    await this.request<void>("PUT", `/issue/${encodeURIComponent(issueId)}`, {
      update: { labels: [{ add: label }] },
    });
  }

  async removeLabel(issueId: string, label: string): Promise<void> {
    await this.request<void>("PUT", `/issue/${encodeURIComponent(issueId)}`, {
      update: { labels: [{ remove: label }] },
    });
  }

  /**
   * Jira has a formal workflow with transitions rather than free-form state
   * updates. Symphony's label-based status flow (agent:dev → agent:dev:done)
   * is the primary mechanism — this method is a no-op for Jira.
   */
  async updateState(_issueId: string, _state: string): Promise<void> {
    // Intentionally no-op. Use labels for status tracking.
  }

  getRateLimitState() {
    return {
      remaining: 1000,
      limit: 1000,
      reset: Date.now() + 3600000,
    };
  }

  // ── Extras used by jira-cli ────────────────────────────────────

  /** Create a subtask under a parent issue. */
  async createSubtask(parentKey: string, title: string): Promise<{ id: string; key: string }> {
    const parent = await this.request<JiraIssueRaw>(
      "GET",
      `/issue/${encodeURIComponent(parentKey)}?fields=project`
    );
    const projectKey = parent.fields.project?.key ?? this.projectKey;

    const res = await this.request<{ id: string; key: string }>("POST", `/issue`, {
      fields: {
        project: { key: projectKey },
        parent: { key: parentKey },
        summary: title,
        issuetype: { name: "Sub-task" },
      },
    });
    return res;
  }
}
