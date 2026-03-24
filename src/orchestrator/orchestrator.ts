/**
 * Symphony Orchestrator
 * Main scheduling loop and coordination
 */

import type {
  ServiceConfig,
  Issue,
  ChildIssue,
  WorkflowDefinition,
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  RunAttempt,
  AgentEvent,
} from "../config/types.js";
import { AgentError } from "../config/types.js";
import {
  loadWorkflow,
  buildServiceConfig,
  validateServiceConfig,
  renderPrompt,
  renderSubtaskPrompt,
} from "../config/loader.js";
import { basename, join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { LinearClient } from "../tracker/client.js";
import { GitHubPRTracker } from "../tracker/github-pr-tracker.js";
import { GitHubIssuesTracker } from "../tracker/github-issues-tracker.js";
import type { Tracker } from "../tracker/interface.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { ClaudeRunner } from "../agent/claude-runner.js";
import { parseRateLimits } from "../agent/session.js";
import { logger } from "../logging/logger.js";
import * as state from "./state.js";
import * as scheduler from "./scheduler.js";
import { watch } from "chokidar";

export interface OrchestratorOptions {
  workflowPath: string;
  dryRun?: boolean;
  /** Injected shared LinearClient (for multi-workflow mode) */
  linearClient?: LinearClient;
  /** If true, skip internal poll loop — caller drives ticks externally */
  managedPolling?: boolean;
  /** If true, write rendered prompts and agent transcripts to logs dir */
  debug?: boolean;
}

export class Orchestrator {
  private workflowPath: string;
  private workflow: WorkflowDefinition | null = null;
  private config: ServiceConfig | null = null;
  private orchState: OrchestratorState | null = null;
  private linearClient: LinearClient | null = null;
  private tracker: Tracker | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  private pollTimer: Timer | null = null;
  private fileWatcher: ReturnType<typeof watch> | null = null;
  private running = false;
  private managedPolling: boolean;
  private debug: boolean;
  private workflowName: string;

  constructor(options: OrchestratorOptions) {
    this.workflowPath = options.workflowPath;
    this.workflowName = basename(options.workflowPath, ".md");
    this.managedPolling = options.managedPolling ?? false;
    this.debug = options.debug ?? false;
    if (options.linearClient) {
      this.linearClient = options.linearClient;
    }
  }

  // ── Tracker Helpers ───────────────────────────────────────────

  private isGitHubTracker(): boolean {
    return this.config?.tracker.kind === "github-pr" || this.config?.tracker.kind === "github-issues";
  }

  private async fetchCandidateIssues(): Promise<Issue[]> {
    if (!this.config) throw new Error("Config not initialized");

    if (this.isGitHubTracker() && this.tracker) {
      return this.tracker.fetchCandidates({
        excludedLabels: this.config.tracker.excluded_labels,
        requiredLabels: this.config.tracker.required_labels,
      });
    }

    if (!this.linearClient) throw new Error("Linear client not initialized");
    return this.linearClient.fetchCandidateIssues(
      this.config.tracker.project_slug,
      this.config.tracker.active_states
    );
  }

  private async getIssue(identifier: string): Promise<Issue | null> {
    if (this.isGitHubTracker() && this.tracker) {
      return this.tracker.getIssue(identifier);
    }
    if (!this.linearClient) throw new Error("Linear client not initialized");
    // LinearClient returns raw response, cast for backwards compat
    // TODO: Use LinearTracker for proper normalization
    const raw = await this.linearClient.getIssue(identifier);
    if (!raw) return null;
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
    };
  }

  private async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    if (!this.config) throw new Error("Config not initialized");

    if (this.isGitHubTracker() && this.tracker) {
      return this.tracker.fetchTerminalIssues(states);
    }

    if (!this.linearClient) throw new Error("Linear client not initialized");
    return this.linearClient.fetchIssuesByStates(
      this.config.tracker.project_slug,
      states
    );
  }

  private async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    if (this.isGitHubTracker() && this.tracker) {
      return this.tracker.fetchStatesByIds(ids);
    }
    if (!this.linearClient) throw new Error("Linear client not initialized");
    return this.linearClient.fetchIssueStatesByIds(ids);
  }

  private async upsertComment(issueId: string, body: string, commentId?: string | null): Promise<string> {
    if (this.isGitHubTracker() && this.tracker) {
      return this.tracker.upsertComment(issueId, body, commentId ?? undefined);
    }
    if (!this.linearClient) throw new Error("Linear client not initialized");
    return this.linearClient.upsertComment(issueId, body, commentId ?? null);
  }

  private async addLabel(issueId: string, label: string, color?: string): Promise<void> {
    if (this.isGitHubTracker() && this.tracker) {
      return this.tracker.addLabel(issueId, label);
    }
    if (!this.linearClient) throw new Error("Linear client not initialized");
    const issue = await this.linearClient.getIssue(issueId);
    if (!issue) return;
    const teamId = (issue as any).team?.id;
    if (!teamId) return;
    await this.linearClient.addLabel(issueId, label, teamId, color);
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info("Starting Symphony orchestrator", { workflowPath: this.workflowPath });

    // Load and validate workflow
    this.workflow = loadWorkflow(this.workflowPath);
    this.config = buildServiceConfig(this.workflow);

    const validation = validateServiceConfig(this.config);
    if (!validation.valid) {
      for (const error of validation.errors) {
        logger.error(`Validation error: ${error}`);
      }
      throw new Error(`Configuration validation failed: ${validation.errors.join(", ")}`);
    }

    // Initialize tracker based on kind
    if (this.config.tracker.kind === "github-pr") {
      // GitHub PR tracker
      this.tracker = new GitHubPRTracker({
        kind: "github-pr",
        repo: this.config.tracker.repo,
        excluded_labels: this.config.tracker.excluded_labels,
        required_labels: this.config.tracker.required_labels,
      });
      logger.info("Using GitHub PR tracker", { repo: this.config.tracker.repo });
    } else if (this.config.tracker.kind === "github-issues") {
      // GitHub Issues tracker
      this.tracker = new GitHubIssuesTracker({
        kind: "github-issues",
        repo: this.config.tracker.repo,
        excluded_labels: this.config.tracker.excluded_labels,
        required_labels: this.config.tracker.required_labels,
        active_states: this.config.tracker.active_states,
        terminal_states: this.config.tracker.terminal_states,
      });
      logger.info("Using GitHub Issues tracker", { repo: this.config.tracker.repo });
    } else {
      // Linear tracker (default)
      if (!this.linearClient) {
        this.linearClient = new LinearClient(
          this.config.tracker.endpoint,
          this.config.tracker.api_key
        );
        this.linearClient.onRateLimit = (attempt, waitSecs) => {
          logger.warn(`Linear rate limit hit, retrying in ${waitSecs}s`, { attempt });
        };
        this.linearClient.onThrottle = (remaining, limit) => {
          logger.debug(`Throttling Linear requests`, { remaining, limit });
        };
      }
    }

    this.workspaceManager = new WorkspaceManager(this.config);
    this.orchState = state.createOrchestratorState(
      this.config.polling.interval_ms,
      this.config.agent.max_concurrent_agents
    );

    // Setup file watcher for dynamic reload
    this.setupFileWatcher();

    // Startup cleanup
    await this.startupCleanup();

    // Start polling (skip if externally managed)
    this.running = true;
    if (!this.managedPolling) {
      this.schedulePoll(0); // Immediate first tick
    }

    logger.info("Symphony orchestrator started", {
      binary: this.config.agent.binary,
      poll_interval_ms: this.config.polling.interval_ms,
      max_concurrent_agents: this.config.agent.max_concurrent_agents,
    });
  }

  async dryRun(): Promise<void> {
    logger.info("Dry run: loading workflow and fetching issues...");

    this.workflow = loadWorkflow(this.workflowPath);
    this.config = buildServiceConfig(this.workflow);

    const validation = validateServiceConfig(this.config);
    if (!validation.valid) {
      for (const error of validation.errors) {
        logger.error(`Validation error: ${error}`);
      }
      throw new Error(`Configuration validation failed: ${validation.errors.join(", ")}`);
    }

    this.linearClient = new LinearClient(
      this.config.tracker.endpoint,
      this.config.tracker.api_key
    );

    const issues = await this.fetchCandidateIssues();

    // Filter by labels (same logic as scheduler) - for Linear only, GitHub tracker handles this internally
    const eligible = this.isGitHubTracker() ? issues : issues.filter((issue) => {
      const requiredLabels = this.config!.tracker.required_labels;
      const excludedLabels = this.config!.tracker.excluded_labels;

      if (requiredLabels.length > 0) {
        const hasAll = requiredLabels.every((rl) =>
          issue.labels.some((l) => l.toLowerCase() === rl.toLowerCase())
        );
        if (!hasAll) return false;
      }

      if (excludedLabels.length > 0) {
        const hasExcluded = excludedLabels.some((el) =>
          issue.labels.some((l) => l.toLowerCase() === el.toLowerCase())
        );
        if (hasExcluded) return false;
      }

      return true;
    });

    if (eligible.length === 0) {
      console.log("No matching issues found.");
      return;
    }

    console.log(`Found ${eligible.length} matching issue(s):\n`);

    for (const issue of eligible) {
      const isRalphLoop = this.config.agent.mode === "ralph_loop" && issue.children.length > 0;

      if (isRalphLoop) {
        const todoChildren = issue.children
          .filter((c) => c.state_type !== "completed" && c.state_type !== "canceled")
          .sort((a, b) => a.sort_order - b.sort_order);

        if (todoChildren.length === 0) {
          console.log(`── ${issue.identifier}: ${issue.title} (no pending subtasks)\n`);
          continue;
        }

        for (let i = 0; i < todoChildren.length; i++) {
          const child = todoChildren[i];
          const prompt = await renderSubtaskPrompt(
            this.workflow.prompt_template,
            issue,
            child,
            i + 1,
            todoChildren.length,
            null
          );

          console.log(`${"─".repeat(60)}`);
          console.log(`Issue: ${issue.identifier} → Subtask ${i + 1}/${todoChildren.length}: ${child.identifier}`);
          console.log(`${"─".repeat(60)}`);
          console.log(prompt);
          console.log();
        }
      } else {
        const prompt = await renderPrompt(this.workflow.prompt_template, issue, null);

        console.log(`${"─".repeat(60)}`);
        console.log(`Issue: ${issue.identifier}: ${issue.title}`);
        console.log(`${"─".repeat(60)}`);
        console.log(prompt);
        console.log();
      }
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping Symphony orchestrator");
    this.running = false;

    // Cancel poll timer
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Stop file watcher
    if (this.fileWatcher) {
      await this.fileWatcher.close();
      this.fileWatcher = null;
    }

    // Cancel all running workers
    if (this.orchState) {
      for (const entry of this.orchState.running.values()) {
        entry.abortController.abort();
      }

      // Cancel all retry timers
      for (const entry of this.orchState.retry_attempts.values()) {
        clearTimeout(entry.timer_handle);
      }
    }

    logger.info("Symphony orchestrator stopped");
  }

  // ── File Watcher ──────────────────────────────────────────────

  private setupFileWatcher(): void {
    this.fileWatcher = watch(this.workflowPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });

    this.fileWatcher.on("change", () => {
      this.reloadWorkflow();
    });
  }

  private reloadWorkflow(): void {
    try {
      const newWorkflow = loadWorkflow(this.workflowPath);
      const newConfig = buildServiceConfig(newWorkflow);
      const validation = validateServiceConfig(newConfig);

      if (!validation.valid) {
        logger.error("Workflow reload failed validation, keeping current config", {
          errors: validation.errors,
        });
        return;
      }

      // Apply new config
      this.workflow = newWorkflow;
      this.config = newConfig;

      // Update components
      if (this.orchState) {
        this.orchState.poll_interval_ms = newConfig.polling.interval_ms;
        this.orchState.max_concurrent_agents = newConfig.agent.max_concurrent_agents;
      }

      if (this.workspaceManager) {
        this.workspaceManager.updateConfig(newConfig);
      }

      if (this.linearClient && !this.managedPolling) {
        // Recreate client if endpoint or key changed (only if we own it)
        this.linearClient = new LinearClient(
          newConfig.tracker.endpoint,
          newConfig.tracker.api_key
        );
      }

      logger.info("Workflow reloaded successfully", {
        binary: newConfig.agent.binary,
      });
    } catch (err) {
      logger.error(`Failed to reload workflow: ${(err as Error).message}`);
    }
  }

  // ── Startup Cleanup ───────────────────────────────────────────

  private async startupCleanup(): Promise<void> {
    if (!this.config || !this.linearClient || !this.workspaceManager) return;

    try {
      // Fetch terminal state issues
      const terminalIssues = await this.fetchIssuesByStates(
        this.config.tracker.terminal_states
      );

      // Remove workspaces for terminal issues
      for (const issue of terminalIssues) {
        await this.workspaceManager.removeWorkspace(issue.identifier);
      }

      if (terminalIssues.length > 0) {
        logger.info(`Cleaned up ${terminalIssues.length} terminal issue workspaces`);
      }
    } catch (err) {
      logger.warn(`Startup cleanup failed: ${(err as Error).message}`);
    }
  }

  // ── Poll Loop ─────────────────────────────────────────────────

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;

    this.pollTimer = setTimeout(async () => {
      await this.pollTick();
      this.schedulePoll(this.orchState?.poll_interval_ms ?? 30000);
    }, delayMs);
  }

  /** Force an immediate poll tick, resetting the poll timer */
  async forcePoll(): Promise<void> {
    if (!this.running) return;
    // Cancel scheduled poll and run immediately
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("Force refresh triggered");
    await this.pollTick();
    this.schedulePoll(this.orchState?.poll_interval_ms ?? 30000);
  }

  private async pollTick(): Promise<void> {
    if (!this.config || (!this.linearClient && !this.tracker) || !this.workspaceManager || !this.orchState) {
      return;
    }

    try {
      // Part 1: Reconcile running issues
      await this.reconcile();

      // Part 2: Validate config (re-read for safety)
      if (!this.refreshConfig()) return;

      // Part 3: Fetch candidate issues
      const issues = await this.fetchCandidateIssues();

      // Part 4-5: Select and dispatch
      const dispatched = this.dispatchFromIssues(issues);

      if (dispatched > 0) {
        logger.info(`Dispatched ${dispatched} issues`);
      }
    } catch (err) {
      logger.error(`Poll tick failed: ${(err as Error).message}`);
    }
  }

  // ── Reconciliation ────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    if (!this.config || (!this.linearClient && !this.tracker) || !this.orchState || !this.workspaceManager) {
      return;
    }

    // Part A: Stall detection
    this.runStallDetection();

    // Part B: Tracker state refresh
    const runningIds = this.getRunningIssueIds();
    if (runningIds.length === 0) return;

    try {
      const stateMap = await this.fetchIssueStatesByIds(runningIds);
      await this.applyReconcileStates(stateMap);
    } catch (err) {
      logger.warn(`State refresh failed: ${(err as Error).message}`);
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────

  private dispatch(issue: Issue, attempt: number | null): boolean {
    if (!this.config || !this.orchState || !this.workspaceManager || !this.workflow) {
      return false;
    }

    // Claim the issue
    if (!state.claimIssue(this.orchState, issue.id)) {
      return false;
    }

    const abortController = new AbortController();
    const runAttempt: RunAttempt = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      workspace_path: "",
      started_at: new Date(),
      status: "PreparingWorkspace",
    };

    // Create worker promise
    const worker = this.runWorker(issue, runAttempt, abortController);

    const entry: RunningEntry = {
      issue,
      attempt: runAttempt,
      session: null,
      worker,
      abortController,
    };

    state.addRunning(this.orchState, entry);

    logger.info(`Dispatched ${issue.identifier}`, {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
    });

    return true;
  }

  private async runWorker(
    issue: Issue,
    runAttempt: RunAttempt,
    abortController: AbortController
  ): Promise<void> {
    if (!this.config || !this.orchState || !this.workspaceManager || !this.workflow) {
      return;
    }

    const config = this.config;
    const orchState = this.orchState;
    const workspaceManager = this.workspaceManager;
    const workflow = this.workflow;

    try {
      // Step 1: Create workspace
      runAttempt.status = "PreparingWorkspace";
      const workspace = await workspaceManager.createWorkspace(issue);
      runAttempt.workspace_path = workspace.path;

      // Step 2: Run before_run hook
      await workspaceManager.runBeforeRunHook(workspace.path, issue);

      // Check if ralph_loop mode with children
      const isRalphLoop = config.agent.mode === "ralph_loop" && issue.children.length > 0;

      if (isRalphLoop) {
        // Ralph Loop Mode: Run through subtasks externally
        const allDone = await this.runRalphLoop(issue, workspace.path, runAttempt, abortController, workflow, config);

        runAttempt.status = "Succeeded";
        logger.info(`Worker completed for ${issue.identifier}`, {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          ralph_loop_done: allDone,
        });

        if (allDone) {
          // All subtasks done — transition parent to "Done" and stop
          await this.transitionIssueToDone(issue);
        } else {
          // More subtasks remain (capped by max_iterations) — continue later
          this.queueContinuationRetry(issue);
        }
      } else {
        // Default Mode: Single prompt for entire issue
        runAttempt.status = "BuildingPrompt";
        const prompt = await renderPrompt(workflow.prompt_template, issue, runAttempt.attempt);

        this.writePromptDebug(workspace.path, issue.identifier, prompt);

        runAttempt.status = "LaunchingAgentProcess";
        let agentError: string | null = null;
        try {
          await this.runAgentOnce(issue, workspace.path, prompt, runAttempt.attempt, abortController, config);
        } catch (err) {
          agentError = (err as Error).message;
        }

        // Agent exited — check the issue's current state to determine outcome
        const freshIssue = await this.getIssue(issue.identifier);
        const freshState = freshIssue?.state?.trim().toLowerCase();
        const isTerminal = freshState && config.tracker.terminal_states.some(
          (s) => s.trim().toLowerCase() === freshState
        );
        const isError = freshState && config.tracker.error_states.some(
          (s) => s.trim().toLowerCase() === freshState
        );

        if (isTerminal) {
          runAttempt.status = "Succeeded";
          logger.info(`Worker done for ${issue.identifier} (issue is ${freshIssue!.state})`, {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            state: freshIssue!.state,
          });
        } else {
          runAttempt.status = "Failed";
          runAttempt.error = isError
            ? `Agent set issue to error state (${freshIssue!.state})`
            : agentError ?? "Agent exited but issue not in terminal state";
          logger.error(`Worker failed for ${issue.identifier}: issue is ${freshIssue?.state ?? "unknown"}`, {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            state: freshIssue?.state,
            is_error_state: !!isError,
            agent_error: agentError,
          });

          // Queue retry with backoff
          await this.queueRetry(issue, (runAttempt.attempt ?? 0) + 1, runAttempt.error);
        }
      }
    } catch (err) {
      // Errors from workspace creation, hooks, or state checking — not agent execution
      const errorMsg = (err as Error).message;

      runAttempt.status = "Failed";
      runAttempt.error = errorMsg;

      logger.error(`Worker failed for ${issue.identifier}: ${errorMsg}`, {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });

      // Queue retry with backoff
      await this.queueRetry(issue, (runAttempt.attempt ?? 0) + 1, errorMsg);
    } finally {
      // Run after_run hook
      if (runAttempt.workspace_path) {
        await workspaceManager.runAfterRunHook(runAttempt.workspace_path, issue);
      }

      // Remove from running
      state.removeRunning(orchState, issue.id);

      // Release claim if no retry is pending, so the issue can be
      // re-dispatched if it transitions back to an active state.
      if (!state.getRetry(orchState, issue.id)) {
        state.releaseClaim(orchState, issue.id);
      }

      // Update running entry session to orchestrator totals
      const entry = orchState.running.get(issue.id);
      if (entry?.session) {
        state.updateTotals(orchState, {
          delta_input: entry.session.input_tokens,
          delta_output: entry.session.output_tokens,
          delta_total: entry.session.total_tokens,
        });
      }
    }
  }

  // ── Ralph Loop Mode ───────────────────────────────────────────

  /**
   * Run through subtasks externally (ralph_loop mode)
   * Fresh Claude session per subtask, maintains order
   * Returns true if all subtasks are done (no more work to do)
   */
  private async runRalphLoop(
    parentIssue: Issue,
    workspacePath: string,
    runAttempt: RunAttempt,
    abortController: AbortController,
    workflow: WorkflowDefinition,
    config: ServiceConfig
  ): Promise<boolean> {
    // Filter to non-done subtasks, sorted by order
    let todoChildren = parentIssue.children
      .filter((c) => c.state_type !== "completed" && c.state_type !== "canceled")
      .sort((a, b) => a.sort_order - b.sort_order);

    // Apply max_iterations cap
    const maxIter = config.agent.max_iterations;
    let wasCapped = false;
    if (maxIter > 0 && todoChildren.length > maxIter) {
      wasCapped = true;
      logger.info(`Capping Ralph loop to ${maxIter} iterations (${todoChildren.length} pending)`, {
        issue_identifier: parentIssue.identifier,
      });
      todoChildren = todoChildren.slice(0, maxIter);
    }

    if (todoChildren.length === 0) {
      logger.info(`No pending subtasks for ${parentIssue.identifier}`, {
        issue_identifier: parentIssue.identifier,
        total_children: parentIssue.children.length,
      });
      return true;
    }

    logger.info(`Starting Ralph loop for ${parentIssue.identifier}`, {
      issue_identifier: parentIssue.identifier,
      total_subtasks: todoChildren.length,
    });

    // Create status comment on parent issue
    let statusCommentId: string | null = null;
    const startedAt = formatTime();
    try {
      statusCommentId = await this.linearClient!.createComment(
        parentIssue.id,
        this.buildRalphStatusComment(parentIssue, todoChildren, -1, startedAt, "starting"),
      );
    } catch (err) {
      logger.warn(`Failed to create status comment: ${(err as Error).message}`);
    }

    for (let i = 0; i < todoChildren.length; i++) {
      const child = todoChildren[i];
      const subtaskIndex = i + 1;

      // Check for abort
      if (abortController.signal.aborted) {
        logger.info(`Ralph loop aborted for ${parentIssue.identifier}`, {
          issue_identifier: parentIssue.identifier,
          completed_subtasks: i,
        });
        await this.updateRalphStatus(parentIssue.id, statusCommentId, parentIssue, todoChildren, i - 1, startedAt, "aborted");
        throw new Error("Ralph loop aborted");
      }

      logger.info(`Processing subtask ${subtaskIndex}/${todoChildren.length}: ${child.identifier}`, {
        parent_identifier: parentIssue.identifier,
        subtask_identifier: child.identifier,
        subtask_title: child.title,
      });

      // Update status comment: mark current subtask as in-progress
      await this.updateRalphStatus(parentIssue.id, statusCommentId, parentIssue, todoChildren, i, startedAt, "running");

      // Build prompt for this subtask
      runAttempt.status = "BuildingPrompt";
      const prompt = await renderSubtaskPrompt(
        workflow.prompt_template,
        parentIssue,
        child,
        subtaskIndex,
        todoChildren.length,
        runAttempt.attempt
      );

      this.writePromptDebug(workspacePath, `${parentIssue.identifier}_subtask-${subtaskIndex}`, prompt);

      // Run agent for this subtask (fresh session)
      runAttempt.status = "LaunchingAgentProcess";
      let agentError: Error | null = null;
      try {
        await this.runAgentOnce(
          parentIssue,
          workspacePath,
          prompt,
          runAttempt.attempt,
          abortController,
          config
        );
      } catch (err) {
        agentError = err as Error;
      }

      // Verify the child's actual state in Linear (source of truth)
      const freshChild = await this.linearClient!.getIssue(child.identifier);
      const childDone = freshChild && (freshChild.state.type === "completed" || freshChild.state.type === "canceled");

      if (agentError) {
        if (childDone) {
          // Agent threw (e.g. abort race with reconciliation) but subtask is actually done
          logger.info(`Subtask ${child.identifier} completed despite agent error: ${agentError.message}`, {
            parent_identifier: parentIssue.identifier,
            subtask_identifier: child.identifier,
          });
          child.state_type = "completed";
        } else {
          // Update status comment with error
          await this.updateRalphStatus(parentIssue.id, statusCommentId, parentIssue, todoChildren, i, startedAt, "error", agentError.message);
          // Subtask genuinely failed — rethrow
          throw agentError;
        }
      } else if (!childDone) {
        logger.warn(`Subtask ${child.identifier} not completed by agent (state: ${freshChild?.state.name})`, {
          parent_identifier: parentIssue.identifier,
          subtask_identifier: child.identifier,
          state_type: freshChild?.state.type,
        });
        const err = new AgentError(
          "turn_failed",
          `Subtask ${child.identifier} not completed after agent run (state: ${freshChild?.state.name})`
        );
        await this.updateRalphStatus(parentIssue.id, statusCommentId, parentIssue, todoChildren, i, startedAt, "error", err.message);
        throw err;
      } else {
        child.state_type = "completed";
      }

      // Refresh parent's children states so next iteration's prompt shows accurate progress
      try {
        const freshParent = await this.linearClient!.getIssue(parentIssue.identifier);
        if (freshParent) {
          for (const fc of freshParent.children.nodes) {
            const existing = parentIssue.children.find((c) => c.id === fc.id);
            if (existing) {
              existing.state = fc.state.name;
              existing.state_type = fc.state.type;
            }
          }
        }
      } catch (refreshErr) {
        logger.warn(`Failed to refresh children states: ${(refreshErr as Error).message}`);
      }

      logger.info(`Completed subtask ${subtaskIndex}/${todoChildren.length}: ${child.identifier}`, {
        parent_identifier: parentIssue.identifier,
        subtask_identifier: child.identifier,
      });
    }

    // Update status comment to final state
    const allDone = !wasCapped;
    await this.updateRalphStatus(
      parentIssue.id,
      statusCommentId,
      parentIssue,
      todoChildren,
      todoChildren.length,
      startedAt,
      allDone ? "completed" : "paused",
    );

    logger.info(`Ralph loop completed for ${parentIssue.identifier}`, {
      issue_identifier: parentIssue.identifier,
      completed_subtasks: todoChildren.length,
    });

    // All done if we weren't capped by max_iterations
    return allDone;
  }

  // ── Ralph Status Comment ─────────────────────────────────────────

  private buildRalphStatusComment(
    parentIssue: Issue,
    todoChildren: ChildIssue[],
    currentIndex: number,
    startedAt: string,
    phase: "starting" | "running" | "completed" | "paused" | "error" | "aborted",
    errorMsg?: string,
  ): string {
    const headerMap = {
      starting: "starting work",
      running: `processing subtasks (${currentIndex + 1}/${todoChildren.length})`,
      completed: "all subtasks completed",
      paused: `paused (completed ${todoChildren.length} subtask${todoChildren.length !== 1 ? "s" : ""} this session)`,
      error: "error encountered",
      aborted: "aborted",
    };

    const lines: string[] = [
      `**Ralph Loop** — ${headerMap[phase]}.`,
      "",
      "---",
      `- [x] Started _(${startedAt})_`,
    ];

    for (let i = 0; i < todoChildren.length; i++) {
      const child = todoChildren[i];
      const isDone = child.state_type === "completed" || child.state_type === "canceled";

      if (isDone || i < currentIndex) {
        lines.push(`- [x] ${child.identifier}: ${child.title} _(${formatTime()})_`);
      } else if (i === currentIndex && phase === "running") {
        lines.push(`- [ ] ${child.identifier}: ${child.title} _(in progress...)_`);
      } else if (i === currentIndex && phase === "error") {
        lines.push(`- [ ] ${child.identifier}: ${child.title} — **failed**`);
      } else {
        lines.push(`- [ ] ${child.identifier}: ${child.title}`);
      }
    }

    if (errorMsg) {
      lines.push("", `**Error:** ${errorMsg}`);
    }

    return lines.join("\n");
  }

  private async updateRalphStatus(
    issueId: string,
    commentId: string | null,
    parentIssue: Issue,
    todoChildren: ChildIssue[],
    currentIndex: number,
    startedAt: string,
    phase: "starting" | "running" | "completed" | "paused" | "error" | "aborted",
    errorMsg?: string,
  ): Promise<void> {
    if (!this.linearClient && !this.tracker) return;
    try {
      const body = this.buildRalphStatusComment(parentIssue, todoChildren, currentIndex, startedAt, phase, errorMsg);
      await this.upsertComment(issueId, body, commentId);
    } catch (err) {
      logger.warn(`Failed to update status comment: ${(err as Error).message}`);
    }
  }

  /**
   * Run a single agent session using the configured harness
   */
  private async runAgentOnce(
    issue: Issue,
    workspacePath: string,
    prompt: string,
    attempt: number | null,
    abortController: AbortController,
    config: ServiceConfig
  ): Promise<void> {
    const binary = config.agent.binary;

    if (binary === "claude") {
      let transcriptPath: string | undefined;
      if (this.debug) {
        const logsDir = join(homedir(), ".symphony", "logs");
        mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        transcriptPath = join(logsDir, `transcript-${issue.identifier}-${ts}.md`);
      }

      const runner = new ClaudeRunner({
        config,
        issue,
        workspacePath,
        prompt,
        attempt,
        onEvent: (event) => {
          // Link runner session to running entry for stall detection.
          // Without this, entry.session stays null and stall detection falls back to
          // entry.attempt.started_at, causing ralph loops to be killed after stall_timeout_ms
          // even when the agent is actively working on subtasks.
          // NOTE: In ralph_loop mode, each subtask gets a new runner/session, so we must
          // always update (not just when null) to track the current subtask's activity.
          const entry = this.orchState?.running.get(issue.id);
          if (entry) {
            entry.session = runner.getSession();
          }
          this.handleAgentEvent(issue.id, event);
        },
        abortSignal: abortController.signal,
        transcriptPath,
      });
      await runner.run();
    } else {
      throw new Error(`Unsupported binary: ${binary}. Only "claude" is currently implemented.`);
    }
  }

  // ── Prompt Debug ────────────────────────────────────────────

  private writePromptDebug(_workspacePath: string, label: string, prompt: string): void {
    if (!this.debug) return;

    try {
      const logsDir = join(homedir(), ".symphony", "logs");
      mkdirSync(logsDir, { recursive: true });
      const filename = `prompt-${label}.md`;
      const filepath = join(logsDir, filename);
      writeFileSync(filepath, prompt, "utf-8");
      logger.info(`Wrote prompt to ${filepath} (${prompt.length} chars)`, {
        issue_identifier: label,
      });
    } catch (err) {
      logger.warn(`Failed to write prompt debug file: ${(err as Error).message}`);
    }
  }

  // ── Parent Issue Transition ──────────────────────────────────

  /**
   * Transition a parent issue to "Done" after all subtasks complete
   */
  private async transitionIssueToDone(issue: Issue): Promise<void> {
    // GitHub PRs use labels, not state transitions
    if (this.isGitHubTracker()) {
      logger.info(`Skipping state transition for GitHub PR ${issue.identifier} (use labels instead)`);
      return;
    }

    if (!this.linearClient) return;

    try {
      // Fetch full issue to get team ID
      const fullIssue = await this.linearClient.getIssue(issue.identifier);
      if (!fullIssue) {
        logger.warn(`Could not fetch issue ${issue.identifier} for state transition`);
        return;
      }

      const teamId = (fullIssue as any).team?.id;
      if (!teamId) {
        logger.warn(`Could not get team ID for issue ${issue.identifier}`);
        return;
      }

      const doneStateId = await this.linearClient.findStateId(teamId, "Done");
      if (!doneStateId) {
        logger.warn(`Could not find "Done" state for team ${teamId}`);
        return;
      }

      await this.linearClient.updateIssue(issue.id, { stateId: doneStateId });
      logger.info(`Transitioned ${issue.identifier} to Done (all subtasks complete)`);
    } catch (err) {
      logger.error(`Failed to transition ${issue.identifier} to Done: ${(err as Error).message}`);
    }
  }

  // ── Agent Event Handling ──────────────────────────────────────

  private handleAgentEvent(issueId: string, event: AgentEvent): void {
    if (!this.orchState) return;

    const entry = this.orchState.running.get(issueId);
    if (!entry) return;

    if (event.event === "token_usage_updated" && event.usage) {
      state.updateTotals(this.orchState, {
        delta_input: event.usage.input_tokens ?? 0,
        delta_output: event.usage.output_tokens ?? 0,
        delta_total: event.usage.total_tokens ?? 0,
      });
    }

    // Track rate limits
    if (event.payload) {
      const limits = parseRateLimits(event.payload);
      if (limits) {
        state.updateRateLimits(this.orchState, limits);
      }
    }

    logger.debug(`Agent event: ${event.event}`, {
      issue_identifier: entry.issue.identifier,
      event: event.event,
    });
  }

  // ── Retry Queue ───────────────────────────────────────────────

  private async queueRetry(issue: Issue, attempt: number, error: string | null): Promise<void> {
    if (!this.config || !this.orchState) return;

    const maxRetries = this.config.agent.max_retries;
    if (maxRetries > 0 && attempt > maxRetries) {
      logger.warn(`Max retries (${maxRetries}) exceeded for ${issue.identifier}, giving up`, {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        attempt,
      });
      // Add symphony:error label to prevent infinite re-dispatch
      try {
        await this.addLabel(issue.id, "symphony:error", "#e5484d");
      } catch (err) {
        logger.warn(`Failed to add symphony:error label to ${issue.identifier}: ${(err as Error).message}`);
      }
      state.releaseClaim(this.orchState, issue.id);
      return;
    }

    const delayMs = scheduler.calculateBackoffDelay(
      attempt,
      this.config.agent.max_retry_backoff_ms
    );
    const dueAtMs = Date.now() + delayMs;

    const timerHandle = setTimeout(() => {
      this.handleRetryFired(issue.id);
    }, delayMs);

    const retryEntry: RetryEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt,
      due_at_ms: dueAtMs,
      timer_handle: timerHandle,
      error,
    };

    state.addRetry(this.orchState, retryEntry);

    logger.info(`Queued retry for ${issue.identifier}`, {
      issue_id: issue.id,
      attempt,
      delay_ms: delayMs,
    });
  }

  private queueContinuationRetry(issue: Issue): void {
    if (!this.orchState) return;

    const delayMs = scheduler.CONTINUATION_RETRY_DELAY_MS;
    const dueAtMs = Date.now() + delayMs;

    const timerHandle = setTimeout(() => {
      this.handleRetryFired(issue.id);
    }, delayMs);

    const retryEntry: RetryEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt: 1,
      due_at_ms: dueAtMs,
      timer_handle: timerHandle,
      error: null,
    };

    state.addRetry(this.orchState, retryEntry);

    logger.debug(`Queued continuation retry for ${issue.identifier}`);
  }

  private async handleRetryFired(issueId: string): Promise<void> {
    if (!this.config || !this.linearClient || !this.orchState) return;

    const retryEntry = state.removeRetry(this.orchState, issueId);
    if (!retryEntry) return;

    try {
      // Fetch active candidates
      const candidates = await this.fetchCandidateIssues();

      // Find our issue
      const issue = candidates.find((c) => c.id === issueId);

      if (!issue) {
        // Issue no longer active
        state.releaseClaim(this.orchState, issueId);
        logger.info(`Retry released claim for ${retryEntry.identifier} (no longer active)`);
        return;
      }

      // Check if we have slots
      if (scheduler.getAvailableSlots(this.orchState, this.config) <= 0) {
        // Requeue
        await this.queueRetry(issue, retryEntry.attempt, "no available orchestrator slots");
        return;
      }

      // Release old claim and dispatch fresh
      state.releaseClaim(this.orchState, issueId);
      this.dispatch(issue, retryEntry.attempt);
    } catch (err) {
      logger.error(`Retry handling failed: ${(err as Error).message}`, {
        issue_id: issueId,
      });
      // Requeue with backoff
      await this.queueRetry(
        { id: issueId, identifier: retryEntry.identifier } as Issue,
        retryEntry.attempt + 1,
        (err as Error).message
      );
    }
  }

  // ── Observability ─────────────────────────────────────────────

  getSnapshot(): state.RuntimeSnapshot | null {
    if (!this.orchState) return null;
    return state.createSnapshot(this.orchState, this.workflowName);
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Managed Mode Methods (used by MultiOrchestrator) ──────────

  /** Get IDs of all currently running issues */
  getRunningIssueIds(): string[] {
    if (!this.orchState) return [];
    return Array.from(this.orchState.running.keys());
  }

  /** Run stall detection on running entries */
  runStallDetection(): void {
    if (!this.config || !this.orchState) return;

    const stallTimeoutMs = this.config.agent.stall_timeout_ms;
    if (stallTimeoutMs <= 0) return;

    const now = Date.now();
    for (const [issueId, entry] of this.orchState.running) {
      const lastActivity = entry.session?.last_activity_at?.getTime() ??
        entry.attempt.started_at.getTime();
      const elapsed = now - lastActivity;

      if (elapsed > stallTimeoutMs) {
        logger.warn(`Stall detected for ${entry.issue.identifier}`, {
          issue_id: issueId,
          elapsed_ms: elapsed,
        });

        entry.abortController.abort();
        this.queueRetry(
          entry.issue,
          (entry.attempt.attempt ?? 0) + 1,
          "stall timeout"
        ).catch(() => {});
      }
    }
  }

  /** Apply reconciliation results from externally-fetched state map */
  async applyReconcileStates(stateMap: Map<string, string>): Promise<void> {
    if (!this.config || !this.orchState || !this.workspaceManager) return;

    for (const [issueId, entry] of this.orchState.running) {
      const currentState = stateMap.get(issueId);
      if (!currentState) continue;

      const normalizedState = currentState.trim().toLowerCase();
      const isTerminal = this.config.tracker.terminal_states.some(
        (s) => s.trim().toLowerCase() === normalizedState
      );
      const isActive = this.config.tracker.active_states.some(
        (s) => s.trim().toLowerCase() === normalizedState
      );

      if (isTerminal) {
        logger.info(`Issue ${entry.issue.identifier} is now terminal, stopping worker`, {
          issue_id: issueId,
          state: currentState,
        });
        entry.abortController.abort();
        state.removeRunning(this.orchState, issueId);
        state.releaseClaim(this.orchState, issueId);
        await this.workspaceManager.removeWorkspace(entry.issue.identifier);
      } else if (!isActive) {
        logger.info(`Issue ${entry.issue.identifier} is no longer active, stopping worker`, {
          issue_id: issueId,
          state: currentState,
        });
        entry.abortController.abort();
        state.removeRunning(this.orchState, issueId);
        state.releaseClaim(this.orchState, issueId);
      } else {
        entry.issue.state = currentState;
      }
    }
  }

  /** Refresh workflow config from file. Returns true if successful. */
  refreshConfig(): boolean {
    try {
      const freshWorkflow = loadWorkflow(this.workflowPath);
      const freshConfig = buildServiceConfig(freshWorkflow);
      const validation = validateServiceConfig(freshConfig);

      if (!validation.valid) {
        logger.error("Config refresh failed validation", { errors: validation.errors });
        return false;
      }

      this.workflow = freshWorkflow;
      this.config = freshConfig;
      return true;
    } catch (err) {
      logger.error(`Config refresh failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Dispatch from pre-fetched issues. Returns count dispatched. */
  dispatchFromIssues(issues: Issue[]): number {
    if (!this.config || !this.orchState) return 0;

    const { eligible } = scheduler.selectCandidates(
      issues,
      this.orchState,
      this.config
    );

    logger.debug(`[${this.workflowName}] ${issues.length} issues, ${eligible.length} eligible`, {
      running: this.orchState.running.size,
      retrying: this.orchState.retry_attempts.size,
    });

    let dispatched = 0;
    for (const issue of eligible) {
      if (scheduler.getAvailableSlots(this.orchState, this.config) <= 0) break;
      if (this.dispatch(issue, null)) dispatched++;
    }

    return dispatched;
  }

  /** Get current service config (for MultiOrchestrator coordination) */
  getServiceConfig(): ServiceConfig | null {
    return this.config;
  }

  /** Get workflow path */
  getWorkflowPath(): string {
    return this.workflowPath;
  }
}

function formatTime(): string {
  return new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
