/**
 * Multi-Workflow Orchestrator
 * Shares LinearClients (keyed by API key) and a poll loop across multiple workflows
 * to avoid hammering the Linear API with N independent pollers.
 */

import type { ServiceConfig } from "../config/types.js";
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
  apiKey: string;
  orchestrator: Orchestrator;
}

export class MultiOrchestrator {
  private entries: WorkflowEntry[] = [];
  private linearClients: Map<string, LinearClient> = new Map();
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

    // Start each orchestrator in managed mode, creating per-key LinearClients
    for (const path of this.workflowPaths) {
      const workflow = loadWorkflow(path);
      const config = buildServiceConfig(workflow);
      const validation = validateServiceConfig(config);

      if (!validation.valid) {
        throw new Error(`Workflow validation failed for ${path}: ${validation.errors.join(", ")}`);
      }

      const apiKey = config.tracker.api_key;
      const client = this.getOrCreateClient(config.tracker.endpoint, apiKey);

      const orchestrator = new Orchestrator({
        workflowPath: path,
        linearClient: client,
        managedPolling: true,
        debug: this.debug,
      });

      await orchestrator.start();
      this.entries.push({ path, apiKey, orchestrator });

      logger.info(`Loaded workflow: ${path}`);
    }

    // Log detected API key sources (env var names, not values)
    const keySourceMap = new Map<string, string>();
    for (const path of this.workflowPaths) {
      const rawKey = loadWorkflow(path).config.tracker?.api_key;
      const resolvedKey = this.entries.find((e) => e.path === path)?.apiKey;
      if (resolvedKey && rawKey?.startsWith("$")) {
        keySourceMap.set(resolvedKey, rawKey.slice(1));
      } else if (resolvedKey && !keySourceMap.has(resolvedKey)) {
        keySourceMap.set(resolvedKey, "LINEAR_API_KEY");
      }
    }
    const sources = [...keySourceMap.values()];
    logger.info(`Detected API keys: ${sources.join(", ")}`, {
      linearClients: this.linearClients.size,
    });

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
    if (this.linearClients.size === 0) return;

    try {
      // Step 1: Stall detection on all orchestrators
      for (const entry of this.entries) {
        entry.orchestrator.runStallDetection();
      }

      // Step 2: Batched reconciliation — group running IDs by API key
      const runningByKey = new Map<string, { ids: string[]; entries: WorkflowEntry[] }>();
      for (const entry of this.entries) {
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

      // Step 3: Refresh configs on all orchestrators
      for (const entry of this.entries) {
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

  isRunning(): boolean {
    return this.running;
  }
}
