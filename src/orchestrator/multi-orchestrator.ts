/**
 * Multi-Workflow Orchestrator
 * Shares a single LinearClient and poll loop across multiple workflows
 * to avoid hammering the Linear API with N independent pollers.
 */

import type { Issue, ServiceConfig } from "../config/types.js";
import { loadWorkflow, buildServiceConfig, validateServiceConfig } from "../config/loader.js";
import { LinearClient } from "../tracker/client.js";
import { logger } from "../logging/logger.js";
import { Orchestrator } from "./orchestrator.js";
import type { RuntimeSnapshot } from "./state.js";

export interface MultiOrchestratorOptions {
  workflowPaths: string[];
  debug?: boolean;
}

interface WorkflowEntry {
  path: string;
  orchestrator: Orchestrator;
}

export class MultiOrchestrator {
  private entries: WorkflowEntry[] = [];
  private linearClient: LinearClient | null = null;
  private pollTimer: Timer | null = null;
  private running = false;
  private workflowPaths: string[];
  private debug: boolean;

  constructor(options: MultiOrchestratorOptions) {
    this.workflowPaths = options.workflowPaths;
    this.debug = options.debug ?? false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info("Starting multi-workflow orchestrator", {
      workflows: this.workflowPaths.length,
    });

    // Load first workflow to bootstrap the shared LinearClient
    const firstWorkflow = loadWorkflow(this.workflowPaths[0]);
    const firstConfig = buildServiceConfig(firstWorkflow);
    const firstValidation = validateServiceConfig(firstConfig);

    if (!firstValidation.valid) {
      throw new Error(`First workflow validation failed: ${firstValidation.errors.join(", ")}`);
    }

    // Create shared LinearClient
    this.linearClient = new LinearClient(
      firstConfig.tracker.endpoint,
      firstConfig.tracker.api_key
    );
    this.linearClient.onRateLimit = (attempt, waitSecs) => {
      logger.warn(`Linear rate limit hit, retrying in ${waitSecs}s`, { attempt });
    };
    this.linearClient.onThrottle = (remaining, limit) => {
      logger.debug(`Throttling Linear requests`, { remaining, limit });
    };

    // Start each orchestrator in managed mode
    for (const path of this.workflowPaths) {
      const orchestrator = new Orchestrator({
        workflowPath: path,
        linearClient: this.linearClient,
        managedPolling: true,
        debug: this.debug,
      });

      await orchestrator.start();
      this.entries.push({ path, orchestrator });

      logger.info(`Loaded workflow: ${path}`);
    }

    // Start shared poll loop
    this.running = true;
    this.schedulePoll(0);

    logger.info("Multi-workflow orchestrator started", {
      workflows: this.entries.length,
    });
  }

  async stop(): Promise<void> {
    logger.info("Stopping multi-workflow orchestrator");
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Stop all child orchestrators
    await Promise.all(this.entries.map((e) => e.orchestrator.stop()));

    logger.info("Multi-workflow orchestrator stopped");
  }

  /** Force an immediate poll tick, resetting the poll timer */
  async forcePoll(): Promise<void> {
    if (!this.running) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("Force refresh triggered");
    await this.pollTick();
    this.schedulePoll(this.getPollInterval());
  }

  // ── Shared Poll Loop ──────────────────────────────────────────

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;

    this.pollTimer = setTimeout(async () => {
      await this.pollTick();
      this.schedulePoll(this.getPollInterval());
    }, delayMs);
  }

  private async pollTick(): Promise<void> {
    if (!this.linearClient) return;

    try {
      // Step 1: Stall detection on all orchestrators
      for (const entry of this.entries) {
        entry.orchestrator.runStallDetection();
      }

      // Step 2: Batched reconciliation — collect all running IDs
      const allRunningIds: string[] = [];
      for (const entry of this.entries) {
        allRunningIds.push(...entry.orchestrator.getRunningIssueIds());
      }

      if (allRunningIds.length > 0) {
        try {
          const stateMap = await this.linearClient.fetchIssueStatesByIds(allRunningIds);
          for (const entry of this.entries) {
            await entry.orchestrator.applyReconcileStates(stateMap);
          }
        } catch (err) {
          logger.warn(`Shared state refresh failed: ${(err as Error).message}`);
        }
      }

      // Step 3: Refresh configs on all orchestrators
      for (const entry of this.entries) {
        entry.orchestrator.refreshConfig();
      }

      // Step 4: Fetch candidates — group by project_slug to minimize API calls
      const slugGroups = this.groupByProjectSlug();

      for (const [slug, group] of slugGroups) {
        // Union all active_states across workflows targeting this slug
        const unionStates = new Set<string>();
        for (const { config } of group) {
          for (const s of config.tracker.active_states) {
            unionStates.add(s);
          }
        }

        // One fetch per unique project_slug
        const issues = await this.linearClient.fetchCandidateIssues(
          slug,
          Array.from(unionStates)
        );

        logger.debug(`Fetched ${issues.length} issues for project ${slug}`, {
          workflows: group.length,
        });

        // Step 5: Distribute to each workflow's scheduler
        let totalDispatched = 0;
        for (const { entry } of group) {
          const dispatched = entry.orchestrator.dispatchFromIssues(issues);
          totalDispatched += dispatched;
        }

        if (totalDispatched > 0) {
          logger.info(`Dispatched ${totalDispatched} issues across workflows for ${slug}`);
        }
      }
    } catch (err) {
      logger.error(`Multi-orchestrator poll tick failed: ${(err as Error).message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private groupByProjectSlug(): Map<string, Array<{ entry: WorkflowEntry; config: ServiceConfig }>> {
    const groups = new Map<string, Array<{ entry: WorkflowEntry; config: ServiceConfig }>>();

    for (const entry of this.entries) {
      const config = entry.orchestrator.getServiceConfig();
      if (!config) continue;

      const slug = config.tracker.project_slug;
      if (!groups.has(slug)) {
        groups.set(slug, []);
      }
      groups.get(slug)!.push({ entry, config });
    }

    return groups;
  }

  /** Use the minimum poll interval across all workflows */
  private getPollInterval(): number {
    let min = 30000;
    for (const entry of this.entries) {
      const config = entry.orchestrator.getServiceConfig();
      if (config && config.polling.interval_ms < min) {
        min = config.polling.interval_ms;
      }
    }
    return min;
  }

  // ── Observability ─────────────────────────────────────────────

  /** Aggregate snapshot across all workflows */
  getSnapshot(): RuntimeSnapshot | null {
    const snapshots: RuntimeSnapshot[] = [];

    for (const entry of this.entries) {
      const snap = entry.orchestrator.getSnapshot();
      if (snap) snapshots.push(snap);
    }

    if (snapshots.length === 0) return null;

    return {
      running: snapshots.flatMap((s) => s.running),
      retrying: snapshots.flatMap((s) => s.retrying),
      token_totals: {
        input_tokens: snapshots.reduce((sum, s) => sum + s.token_totals.input_tokens, 0),
        output_tokens: snapshots.reduce((sum, s) => sum + s.token_totals.output_tokens, 0),
        total_tokens: snapshots.reduce((sum, s) => sum + s.token_totals.total_tokens, 0),
        seconds_running: snapshots.reduce((sum, s) => sum + s.token_totals.seconds_running, 0),
      },
      rate_limits: this.linearClient?.getRateLimitState()
        ? {
            requests_limit: this.linearClient.getRateLimitState().requestsLimit,
            requests_remaining: this.linearClient.getRateLimitState().requestsRemaining,
            requests_reset: this.linearClient.getRateLimitState().requestsReset,
          }
        : snapshots[0].rate_limits,
    };
  }

  isRunning(): boolean {
    return this.running;
  }
}
