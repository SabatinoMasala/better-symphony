/**
 * Cron Tracker
 * Generates synthetic issues on a cron schedule instead of polling an issue tracker.
 */

import { Cron } from "croner";
import type { Issue } from "../config/types.js";
import type { Tracker, TrackerConfig, FetchOptions } from "./interface.js";
import { logger } from "../logging/logger.js";

export class CronTracker implements Tracker {
  private cron: Cron;
  private schedule: string;
  private identifierPrefix: string;
  private nextFireAt: Date;
  private runCounter = 0;

  constructor(config: TrackerConfig) {
    if (!config.schedule) {
      throw new Error("Cron tracker requires a schedule expression");
    }
    this.schedule = config.schedule;
    // Derive prefix from project_slug or default to "cron"
    this.identifierPrefix = config.project_slug || "cron";
    this.cron = new Cron(config.schedule);
    const next = this.cron.nextRun();
    if (!next) {
      throw new Error(`Cron expression "${config.schedule}" has no upcoming occurrences`);
    }
    this.nextFireAt = next;

    logger.info("Cron tracker initialized", {
      schedule: this.schedule,
      prefix: this.identifierPrefix,
      next_fire: this.nextFireAt.toISOString(),
    });
  }

  async fetchCandidates(_options: FetchOptions): Promise<Issue[]> {
    const now = new Date();
    if (now < this.nextFireAt) {
      return [];
    }

    // Cron has fired
    this.runCounter++;
    const scheduledAt = this.nextFireAt;
    const runId = `${this.identifierPrefix}-run-${this.runCounter}`;

    // Advance to next fire time
    const next = this.cron.nextRun();
    if (next) {
      this.nextFireAt = next;
    } else {
      // No more occurrences — push far into the future
      this.nextFireAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    }

    logger.info(`Cron fired: ${runId}`, {
      schedule: this.schedule,
      scheduled_at: scheduledAt.toISOString(),
      next_fire: this.nextFireAt.toISOString(),
      run_number: this.runCounter,
    });

    return [
      {
        id: runId,
        identifier: this.identifierPrefix,
        title: `Scheduled run #${this.runCounter}`,
        description: null,
        priority: null,
        state: "scheduled",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        children: [],
        comments: [],
        created_at: scheduledAt,
        updated_at: scheduledAt,
      },
    ];
  }

  /** Returns the cron schedule expression */
  getSchedule(): string {
    return this.schedule;
  }

  /** Returns the current run counter */
  getRunCounter(): number {
    return this.runCounter;
  }

  /** Returns the next scheduled fire time */
  getNextFireAt(): Date {
    return this.nextFireAt;
  }

  /** Force the cron to fire on the next poll by setting nextFireAt to the past */
  forceTrigger(): void {
    this.nextFireAt = new Date(0);
    logger.info("Cron trigger forced", { schedule: this.schedule, prefix: this.identifierPrefix });
  }

  // ── No-op tracker methods (cron has no external issue state) ──

  async getIssue(_identifier: string): Promise<Issue | null> {
    return null;
  }

  async fetchTerminalIssues(_terminalStates: string[]): Promise<Issue[]> {
    return [];
  }

  async fetchStatesByIds(_ids: string[]): Promise<Map<string, string>> {
    return new Map();
  }

  async upsertComment(_issueId: string, _body: string, _commentId?: string): Promise<string> {
    return "";
  }

  async addLabel(_issueId: string, _label: string): Promise<void> {}

  async removeLabel(_issueId: string, _label: string): Promise<void> {}

  async updateState(_issueId: string, _state: string): Promise<void> {}

  getRateLimitState() {
    return { remaining: Infinity, limit: Infinity, reset: 0 };
  }
}
