/**
 * Multi-Workflow Orchestrator
 * Shares LinearClients (keyed by API key) and a poll loop across multiple workflows
 * to avoid hammering the Linear API with N independent pollers.
 */

import type { ServiceConfig, ExpandedWorkflow } from "../config/types.js";
import { loadWorkflow, buildServiceConfig, validateServiceConfig } from "../config/loader.js";
import { loadProfileWorkflow } from "../config/profiles.js";
import { LinearClient } from "../tracker/client.js";
import { logger } from "../logging/logger.js";
import { Orchestrator } from "./orchestrator.js";
import type { RuntimeSnapshot } from "./state.js";

export interface MultiOrchestratorOptions {
  workflows: ExpandedWorkflow[];
  debug?: boolean;
}

interface WorkflowEntry {
  path: string;
  profileName?: string;
  apiKey: string;
  orchestrator: Orchestrator;
  /** Cron workflows run their own poll loop independently */
  isCron: boolean;
}

export class MultiOrchestrator {
  private entries: WorkflowEntry[] = [];
  private linearClients: Map<string, LinearClient> = new Map();
  private pollTimer: Timer | null = null;
  private running = false;
  private workflows: ExpandedWorkflow[];
  private debug: boolean;

  constructor(options: MultiOrchestratorOptions) {
    this.workflows = options.workflows;
    this.debug = options.debug ?? false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info("Starting multi-workflow orchestrator", {
      workflows: this.workflows.length,
    });

    // Start each orchestrator, creating per-key LinearClients for tracker workflows
    for (const wf of this.workflows) {
      const workflow = wf.profileName
        ? loadProfileWorkflow(wf.path, wf.profileName)
        : loadWorkflow(wf.path);
      const config = buildServiceConfig(workflow);
      const validation = validateServiceConfig(config);

      if (!validation.valid) {
        throw new Error(`Workflow validation failed for ${wf.virtualName}: ${validation.errors.join(", ")}`);
      }

      const isCron = config.tracker.kind === "cron";

      if (isCron) {
        // Cron workflows run their own poll loop independently
        const orchestrator = new Orchestrator({
          workflowPath: wf.path,
          profileName: wf.profileName,
          managedPolling: false,
          debug: this.debug,
        });

        await orchestrator.start();
        this.entries.push({ path: wf.path, profileName: wf.profileName, apiKey: "", orchestrator, isCron: true });
      } else {
        // Tracker workflows share LinearClients and use managed polling
        const apiKey = config.tracker.api_key;
        const client = this.getOrCreateClient(config.tracker.endpoint, apiKey);

        const orchestrator = new Orchestrator({
          workflowPath: wf.path,
          profileName: wf.profileName,
          linearClient: client,
          managedPolling: true,
          debug: this.debug,
        });

        await orchestrator.start();
        this.entries.push({ path: wf.path, profileName: wf.profileName, apiKey, orchestrator, isCron: false });
      }

      logger.info(`Loaded workflow: ${wf.virtualName}${isCron ? " (cron)" : ""}`);
    }

    // Log detected API key sources (env var names, not values)
    const trackerEntries = this.entries.filter(e => !e.isCron);
    const keySourceMap = new Map<string, string>();
    for (const entry of trackerEntries) {
      const rawWorkflow = loadWorkflow(entry.path);
      const rawKey = rawWorkflow.config.tracker?.api_key;
      if (entry.apiKey && rawKey?.startsWith("$")) {
        keySourceMap.set(entry.apiKey, rawKey.slice(1));
      } else if (entry.apiKey && !keySourceMap.has(entry.apiKey)) {
        keySourceMap.set(entry.apiKey, "LINEAR_API_KEY");
      }
    }
    if (keySourceMap.size > 0) {
      const sources = [...keySourceMap.values()];
      logger.info(`Detected API keys: ${sources.join(", ")}`, {
        linearClients: this.linearClients.size,
      });
    }

    // Start shared poll loop
    this.running = true;
    this.schedulePoll(0);

    logger.info("Multi-workflow orchestrator started", {
      workflows: this.entries.length,
      linearClients: this.linearClients.size,
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
    // Only tracker workflows use the shared poll loop; cron workflows run independently
    const trackerEntries = this.entries.filter(e => !e.isCron);
    if (this.linearClients.size === 0 && trackerEntries.length === 0) return;

    try {
      // Step 1: Stall detection on tracker orchestrators
      for (const entry of trackerEntries) {
        entry.orchestrator.runStallDetection();
      }

      // Step 2: Batched reconciliation — group running IDs by API key
      const runningByKey = new Map<string, { ids: string[]; entries: WorkflowEntry[] }>();
      for (const entry of trackerEntries) {
        const ids = entry.orchestrator.getRunningIssueIds();
        if (ids.length === 0) continue;
        let group = runningByKey.get(entry.apiKey);
        if (!group) {
          group = { ids: [], entries: [] };
          runningByKey.set(entry.apiKey, group);
        }
        group.ids.push(...ids);
        group.entries.push(entry);
      }

      for (const [apiKey, group] of runningByKey) {
        const client = this.linearClients.get(apiKey);
        if (!client) continue;
        try {
          const stateMap = await client.fetchIssueStatesByIds(group.ids);
          for (const entry of group.entries) {
            await entry.orchestrator.applyReconcileStates(stateMap);
          }
        } catch (err) {
          logger.warn(`State refresh failed for client: ${(err as Error).message}`);
        }
      }

      // Step 3: Refresh configs on tracker orchestrators
      for (const entry of trackerEntries) {
        entry.orchestrator.refreshConfig();
      }

      // Step 4: Fetch candidates — group by (apiKey, project_slug) to minimize API calls
      const groups = this.groupByApiKeyAndSlug();

      for (const [compositeKey, group] of groups) {
        const client = this.linearClients.get(group.apiKey);
        if (!client) continue;

        // Union all active_states across workflows targeting this (key, slug)
        const unionStates = new Set<string>();
        for (const { config } of group.items) {
          for (const s of config.tracker.active_states) {
            unionStates.add(s);
          }
        }

        // One fetch per unique (apiKey, project_slug)
        const issues = await client.fetchCandidateIssues(
          group.slug,
          Array.from(unionStates)
        );

        logger.debug(`Fetched ${issues.length} issues for project ${group.slug}`, {
          workflows: group.items.length,
        });

        // Step 5: Distribute to each workflow's scheduler
        let totalDispatched = 0;
        for (const { entry } of group.items) {
          const dispatched = entry.orchestrator.dispatchFromIssues(issues);
          totalDispatched += dispatched;
        }

        if (totalDispatched > 0) {
          logger.info(`Dispatched ${totalDispatched} issues across workflows for ${group.slug}`);
        }
      }
    } catch (err) {
      logger.error(`Multi-orchestrator poll tick failed: ${(err as Error).message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private getOrCreateClient(endpoint: string, apiKey: string): LinearClient {
    let client = this.linearClients.get(apiKey);
    if (client) return client;

    client = new LinearClient(endpoint, apiKey);
    client.onRateLimit = (attempt, waitSecs) => {
      logger.warn(`Linear rate limit hit, retrying in ${waitSecs}s`, { attempt });
    };
    client.onThrottle = (remaining, limit) => {
      logger.debug(`Throttling Linear requests`, { remaining, limit });
    };
    this.linearClients.set(apiKey, client);
    return client;
  }

  private groupByApiKeyAndSlug(): Map<string, { apiKey: string; slug: string; items: Array<{ entry: WorkflowEntry; config: ServiceConfig }> }> {
    const groups = new Map<string, { apiKey: string; slug: string; items: Array<{ entry: WorkflowEntry; config: ServiceConfig }> }>();

    for (const entry of this.entries) {
      if (entry.isCron) continue; // Cron workflows are not grouped
      const config = entry.orchestrator.getServiceConfig();
      if (!config) continue;

      const slug = config.tracker.project_slug;
      const compositeKey = `${entry.apiKey}||${slug}`;
      let group = groups.get(compositeKey);
      if (!group) {
        group = { apiKey: entry.apiKey, slug, items: [] };
        groups.set(compositeKey, group);
      }
      group.items.push({ entry, config });
    }

    return groups;
  }

  /** Use the minimum poll interval across tracker workflows (cron workflows manage their own) */
  private getPollInterval(): number {
    let min = 30000;
    for (const entry of this.entries) {
      if (entry.isCron) continue;
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
      workflows: snapshots.flatMap((s) => s.workflows),
      token_totals: {
        input_tokens: snapshots.reduce((sum, s) => sum + s.token_totals.input_tokens, 0),
        output_tokens: snapshots.reduce((sum, s) => sum + s.token_totals.output_tokens, 0),
        total_tokens: snapshots.reduce((sum, s) => sum + s.token_totals.total_tokens, 0),
        seconds_running: snapshots.reduce((sum, s) => sum + s.token_totals.seconds_running, 0),
      },
      rate_limits: (() => {
        if (this.linearClients.size === 0) return snapshots[0].rate_limits;

        // Report the most constrained client (lowest requestsRemaining)
        let mostConstrained: { requests_limit: number; requests_remaining: number; requests_reset: number } | null = null;
        for (const client of this.linearClients.values()) {
          const rl = client.getRateLimitState();
          if (!mostConstrained || rl.requestsRemaining < mostConstrained.requests_remaining) {
            mostConstrained = {
              requests_limit: rl.requestsLimit,
              requests_remaining: rl.requestsRemaining,
              requests_reset: rl.requestsReset,
            };
          }
        }
        return mostConstrained!;
      })(),
    };
  }

  /** Trigger a cron workflow by name. Returns true if found and triggered. */
  async triggerCron(workflowName: string): Promise<boolean> {
    const entry = this.entries.find(e => e.isCron && e.orchestrator.getWorkflowName() === workflowName);
    if (!entry) return false;
    return entry.orchestrator.triggerCron();
  }

  isRunning(): boolean {
    return this.running;
  }
}
