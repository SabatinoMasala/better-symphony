#!/usr/bin/env bun
/**
 * Symphony CLI
 * Entry point for the Symphony orchestrator service with TUI
 */

import { resolve, join, basename } from "path";
import { existsSync, readdirSync } from "fs";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import { App } from "./tui/App.js";
import { logger, createFileSink } from "./logging/logger.js";

// ── CLI Parsing ─────────────────────────────────────────────────

interface CLIOptions {
  workflowPaths: string[];
  filters: string[];
  logFile?: string;
  debug: boolean;
  dryRun: boolean;
  headless: boolean;
  web: boolean;
  webPort: number;
  webHost: string;
}

// Resolve paths relative to the caller's cwd, not the script's cwd
const callerCwd = process.env.SYMPHONY_CWD || process.cwd();

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    workflowPaths: [],
    filters: [],
    debug: false,
    dryRun: false,
    headless: false,
    web: false,
    webPort: 3000,
    webHost: "0.0.0.0",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--workflow" || arg === "-w") {
      // Consume all following non-flag arguments as workflow paths
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.workflowPaths.push(resolve(callerCwd, args[++i]));
      }
    } else if (arg === "--filter" || arg === "-f") {
      // Consume all following non-flag arguments as filter strings
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.filters.push(args[++i]);
      }
    } else if (arg === "--log" || arg === "-l") {
      options.logFile = args[++i];
    } else if (arg === "--debug" || arg === "-d") {
      options.debug = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--headless") {
      options.headless = true;
    } else if (arg === "--web") {
      options.web = true;
    } else if (arg === "--web-port") {
      options.webPort = parseInt(args[++i], 10);
    } else if (arg === "--web-host") {
      options.webHost = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      console.log("Symphony v1.0.0");
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      options.workflowPaths.push(resolve(callerCwd, arg));
    }
  }

  // Auto-detect workflows/*.md if no paths specified
  if (options.workflowPaths.length === 0) {
    const workflowsDir = resolve(callerCwd, "workflows");
    if (existsSync(workflowsDir)) {
      let mdFiles = readdirSync(workflowsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => join(workflowsDir, f));

      // Apply filters if specified
      if (options.filters.length > 0) {
        const allFiles = mdFiles;
        mdFiles = mdFiles.filter((f) => {
          const name = basename(f).toLowerCase();
          return options.filters.some((filter) => name.includes(filter.toLowerCase()));
        });
        if (mdFiles.length === 0) {
          const available = allFiles.map((f) => basename(f)).join(", ");
          console.error(`No workflows matched filter(s): ${options.filters.join(", ")}`);
          console.error(`Available workflows: ${available}`);
          process.exit(1);
        }
      }

      if (mdFiles.length > 0) {
        options.workflowPaths.push(...mdFiles);
      }
    }
    if (options.workflowPaths.length === 0) {
      console.error("No workflow files found. Create a workflows/ directory with .md files, or specify paths explicitly.");
      console.error("Run 'symphony --help' for usage information.");
      process.exit(1);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Symphony - Coding Agent Orchestrator

Usage: symphony [options] [workflow-paths...]

Options:
  -w, --workflow <paths...>  Workflow file(s) (default: workflows/*.md)
  -f, --filter <strings...>  Filter auto-discovered workflows by filename substring
  -l, --log <path>           Log file path (appends JSON lines)
  --dry-run                  Render prompts for matching issues and print them (no agent launched)
  --headless                 Run without TUI (plain log output)
  --web                      Start web dashboard (implies --headless)
  --web-port <port>          Web dashboard port (default: 3000)
  --web-host <host>          Web dashboard bind address (default: 0.0.0.0)
  -d, --debug                Debug mode: verbose logging + save prompts and agent transcripts to ~/.symphony/logs/
  -h, --help                 Show this help message
  -v, --version              Show version

Examples:
  symphony                                          # Auto-detect workflows/*.md
  symphony -f github                                # Only github-related workflows
  symphony -f review -f dev                         # Review and dev workflows
  symphony ./my-workflow.md                         # Run with custom workflow
  symphony -w dev.md qa.md                          # Override with specific workflows
  symphony --headless                               # Run without TUI
  symphony --web                                    # Run with web dashboard
  symphony --web --web-port 8080                    # Web dashboard on port 8080
  symphony --dry-run                                # Preview rendered prompts

Environment Variables:
  LINEAR_API_KEY                Linear API key (required)
`);
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs();

  // Validate all workflow files exist
  for (const path of options.workflowPaths) {
    if (!existsSync(path)) {
      console.error(`Workflow file not found: ${path}`);
      process.exit(1);
    }
  }

  // Dry run mode always runs headless (only supports single workflow)
  if (options.dryRun) {
    await runDryRun(options);
    return;
  }

  if (options.web) {
    await runWeb(options);
  } else if (options.headless) {
    await runHeadless(options);
  } else {
    await runTui(options);
  }
}

// ── TUI Mode ────────────────────────────────────────────────────

async function runTui(options: CLIOptions): Promise<void> {
  // Remove default console sink — TUI will handle all rendering
  logger.clearSinks();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  });

  createRoot(renderer).render(
    React.createElement(App, {
      workflowPaths: options.workflowPaths,
      logFile: options.logFile,
      debug: options.debug,
      renderer,
    })
  );
}

// ── Dry Run Mode ────────────────────────────────────────────────

async function runDryRun(options: CLIOptions): Promise<void> {
  const { Orchestrator } = await import("./orchestrator/orchestrator.js");

  if (options.debug) {
    logger.setMinLevel("debug");
  }

  // Dry run uses first workflow only
  const orchestrator = new Orchestrator({
    workflowPath: options.workflowPaths[0],
  });

  try {
    await orchestrator.dryRun();
  } catch (err) {
    logger.error(`Dry run failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ── Shared Orchestrator Creation ─────────────────────────────────

interface OrchestratorHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  forcePoll(): Promise<void>;
  getSnapshot(): any;
}

async function createOrchestrator(options: CLIOptions): Promise<OrchestratorHandle> {
  if (options.workflowPaths.length > 1) {
    const { MultiOrchestrator } = await import("./orchestrator/multi-orchestrator.js");
    return new MultiOrchestrator({ workflowPaths: options.workflowPaths, debug: options.debug });
  }
  const { Orchestrator } = await import("./orchestrator/orchestrator.js");
  return new Orchestrator({ workflowPath: options.workflowPaths[0], debug: options.debug });
}

// ── Web Mode ────────────────────────────────────────────────────

async function runWeb(options: CLIOptions): Promise<void> {
  if (options.debug) {
    logger.setMinLevel("debug");
  }

  if (options.logFile) {
    logger.addSink(createFileSink(options.logFile));
  }

  const orchestrator = await createOrchestrator(options);

  const { startWebServer } = await import("./web/server.js");
  const webServer = startWebServer({
    port: options.webPort,
    host: options.webHost,
    orchestrator,
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    webServer.stop();
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${reason}`);
    process.exit(1);
  });

  try {
    await orchestrator.start();
    const label = options.workflowPaths.length > 1
      ? `${options.workflowPaths.length} workflows`
      : "1 workflow";
    logger.info(`Symphony is running (${label}) with web dashboard.`);
  } catch (err) {
    logger.error(`Failed to start: ${(err as Error).message}`);
    webServer.stop();
    process.exit(1);
  }
}

// ── Headless Mode ───────────────────────────────────────────────

async function runHeadless(options: CLIOptions): Promise<void> {
  if (options.debug) {
    logger.setMinLevel("debug");
  }

  if (options.logFile) {
    logger.addSink(createFileSink(options.logFile));
  }

  const orchestrator = await createOrchestrator(options);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${reason}`);
    process.exit(1);
  });

  try {
    await orchestrator.start();
    const label = options.workflowPaths.length > 1
      ? `${options.workflowPaths.length} workflows`
      : "1 workflow";
    logger.info(`Symphony is running (${label}). Press Ctrl+C to stop.`);

    setInterval(() => {
      const snapshot = orchestrator.getSnapshot();
      if (snapshot) {
        logger.info("Status", {
          running: snapshot.running.length,
          retrying: snapshot.retrying.length,
          total_tokens: snapshot.token_totals.total_tokens,
          seconds_running: Math.round(snapshot.token_totals.seconds_running),
        });
      }
    }, 60000);
  } catch (err) {
    logger.error(`Failed to start: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
