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
import type { ExpandedWorkflow } from "./config/types.js";
import { expandWorkflowPaths } from "./config/profiles.js";
import pkg from "../package.json";

// ── CLI Parsing ─────────────────────────────────────────────────

interface CLIOptions {
  workflowPaths: string[];
  filters: string[];
  logFile?: string;
  debug: boolean;
  dryRun: boolean;
  routes: boolean;
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
    routes: false,
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
    } else if (arg === "--routes") {
      options.routes = true;
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
      console.log(`Symphony v${pkg.version}`);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      options.workflowPaths.push(resolve(callerCwd, arg));
    }
  }

  // Auto-detect workflows/*.md if no paths specified
  if (options.workflowPaths.length === 0) {
    const workflowsDir = resolve(callerCwd, "workflows");
    if (existsSync(workflowsDir)) {
      const mdFiles = readdirSync(workflowsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => join(workflowsDir, f));

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
       symphony yolobox <binary> [args...]

Commands:
  yolobox <binary> [args...]   Spawn an interactive yolobox session (forwards CLAUDE_CODE_OAUTH_TOKEN)

Options:
  -w, --workflow <paths...>  Workflow file(s) (default: workflows/*.md)
  -f, --filter <strings...>  Filter workflows by name substring (matches virtual names for matrix workflows)
  -l, --log <path>           Log file path (appends JSON lines)
  --dry-run                  Render prompts for matching issues and print them (no agent launched)
  --routes                   Print workflow routing rules and exit
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
  symphony -f dev:cloud                             # Only the cloud profile of dev workflow
  symphony ./my-workflow.md                         # Run with custom workflow
  symphony -w dev.md qa.md                          # Override with specific workflows
  symphony --headless                               # Run without TUI
  symphony --web                                    # Run with web dashboard
  symphony --web --web-port 8080                    # Web dashboard on port 8080
  symphony --dry-run                                # Preview rendered prompts
  symphony --routes                                 # Print routing rules for all workflows
  symphony --routes -f dev                          # Print routing rules for dev workflow only
  symphony yolobox claude                           # Interactive claude session inside yolobox
  symphony yolobox claude -p "hello"                # Pass extra args to claude

Environment Variables:
  LINEAR_API_KEY                Linear API key (required)
`);
}

// ── Expand & Filter ─────────────────────────────────────────────

function expandAndFilter(options: CLIOptions): ExpandedWorkflow[] {
  let expanded = expandWorkflowPaths(options.workflowPaths);

  if (options.filters.length > 0) {
    const allNames = expanded.map((e) => e.virtualName);
    expanded = expanded.filter((e) =>
      options.filters.some((f) => e.virtualName.toLowerCase().includes(f.toLowerCase()))
    );
    if (expanded.length === 0) {
      console.error(`No workflows matched filter(s): ${options.filters.join(", ")}`);
      console.error(`Available workflows: ${allNames.join(", ")}`);
      process.exit(1);
    }
  }

  if (expanded.length === 0) {
    console.error("No workflows to run (all had empty matrix?).");
    process.exit(1);
  }

  return expanded;
}

// ── Routes Mode ─────────────────────────────────────────────────

function printRoutes(workflows: ExpandedWorkflow[]): void {
  const { loadWorkflow, buildServiceConfig } = require("./config/loader.js");
  const { loadProfileWorkflow } = require("./config/profiles.js");

  console.log("\nWorkflow Routes");
  console.log("===============\n");

  // Collect route info for collision detection
  const routeInfos: Array<{
    name: string;
    trackerKind: string;
    scope: string;
    requiredLabels: string[];
    excludedLabels: string[];
  }> = [];

  for (const wf of workflows) {
    const name = wf.virtualName;
    try {
      const workflow = wf.profileName
        ? loadProfileWorkflow(wf.path, wf.profileName)
        : loadWorkflow(wf.path);
      const config = buildServiceConfig(workflow);
      const t = config.tracker;
      const scope = t.kind === "linear" ? t.project_slug : t.repo;

      routeInfos.push({
        name,
        trackerKind: t.kind,
        scope,
        requiredLabels: t.required_labels,
        excludedLabels: t.excluded_labels,
      });

      console.log(`${name} (${t.kind})`);
      if (t.kind === "linear") {
        console.log(`  Project:          ${t.project_slug || "(none)"}`);
      } else {
        console.log(`  Repo:             ${t.repo || "(none)"}`);
      }
      console.log(`  Mode:             ${config.agent.mode}`);
      console.log(`  Active states:    ${t.active_states.join(", ")}`);
      console.log(`  Required labels:  ${t.required_labels.length > 0 ? t.required_labels.join(", ") : "(none)"}`);
      console.log(`  Excluded labels:  ${t.excluded_labels.length > 0 ? t.excluded_labels.join(", ") : "(none)"}`);
      console.log(`  Max concurrency:  ${config.agent.max_concurrent_agents}`);
      console.log();
    } catch (err) {
      console.log(`${name}`);
      console.log(`  ⚠ Error loading: ${(err as Error).message}\n`);
    }
  }

  // Collision detection
  const warnings: string[] = [];

  // Check for label overlaps (scoped by tracker kind + project/repo)
  const labelMap = new Map<string, string[]>();
  for (const route of routeInfos) {
    for (const label of route.requiredLabels) {
      const key = `${route.trackerKind}|${route.scope}|${label}`;
      if (!labelMap.has(key)) labelMap.set(key, []);
      labelMap.get(key)!.push(route.name);
    }
  }
  for (const [key, names] of labelMap) {
    if (names.length > 1) {
      const label = key.split("|")[2];
      warnings.push(
        `⚠ Label "${label}" is required by multiple workflows: ${names.join(", ")}\n  Both workflows will pick up the same issues — this is likely unintentional.`
      );
    }
  }

  // Check for workflows with no label filters
  for (const route of routeInfos) {
    if (route.requiredLabels.length === 0 && route.excludedLabels.length === 0) {
      warnings.push(
        `⚠ Workflow "${route.name}" has no label filters — it will match all issues in active states.`
      );
    }
  }

  if (warnings.length > 0) {
    console.log("Warnings");
    console.log("========\n");
    for (const w of warnings) {
      console.log(w);
      console.log();
    }
  }
}

// ── Yolobox Mode ───────────────────────────────────────────────

async function runYolobox(args: string[]): Promise<void> {
  const binary = args[0];
  if (!binary) {
    console.error("Usage: better-symphony yolobox <binary> [args...]");
    console.error("Example: better-symphony yolobox claude");
    process.exit(1);
  }

  const extraArgs = args.slice(1);
  const symphonyRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

  const yoloboxArgs: string[] = [binary];

  // Mount symphony source so $SYMPHONY_LINEAR path works inside the container
  yoloboxArgs.push("--mount", `${symphonyRoot}:${symphonyRoot}`);

  const envVarNames: string[] = [];
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    yoloboxArgs.push("--env", `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
    envVarNames.push("CLAUDE_CODE_OAUTH_TOKEN");
  }
  if (process.env.LINEAR_API_KEY) {
    yoloboxArgs.push("--env", `SYMPHONY_LINEAR_API_KEY=${process.env.LINEAR_API_KEY}`);
    envVarNames.push("SYMPHONY_LINEAR_API_KEY");
  }

  if (extraArgs.length > 0) {
    yoloboxArgs.push("--", ...extraArgs);
  }

  console.log(`Spawning: yolobox ${binary}` +
    (envVarNames.length > 0 ? ` (forwarding: ${envVarNames.join(", ")})` : "") +
    (extraArgs.length > 0 ? ` -- ${extraArgs.join(" ")}` : ""));

  const proc = Bun.spawn(["yolobox", ...yoloboxArgs], {
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Check for subcommands before parsing flags
  const firstArg = process.argv[2];
  if (firstArg === "yolobox") {
    await runYolobox(process.argv.slice(3));
    return;
  }

  const options = parseArgs();

  // Validate all workflow files exist
  for (const path of options.workflowPaths) {
    if (!existsSync(path)) {
      console.error(`Workflow file not found: ${path}`);
      process.exit(1);
    }
  }

  // Expand matrix workflows and apply filters
  const workflows = expandAndFilter(options);

  // Routes mode: print routing summary and exit
  if (options.routes) {
    printRoutes(workflows);
    return;
  }

  // Dry run mode always runs headless (only supports single workflow)
  if (options.dryRun) {
    await runDryRun(workflows[0], options);
    return;
  }

  if (options.web) {
    await runWeb(workflows, options);
  } else if (options.headless) {
    await runHeadless(workflows, options);
  } else {
    await runTui(workflows, options);
  }
}

// ── TUI Mode ────────────────────────────────────────────────────

async function runTui(workflows: ExpandedWorkflow[], options: CLIOptions): Promise<void> {
  // Remove default console sink — TUI will handle all rendering
  logger.clearSinks();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  });

  createRoot(renderer).render(
    React.createElement(App, {
      workflows,
      logFile: options.logFile,
      debug: options.debug,
      renderer,
    })
  );
}

// ── Dry Run Mode ────────────────────────────────────────────────

async function runDryRun(workflow: ExpandedWorkflow, options: CLIOptions): Promise<void> {
  const { Orchestrator } = await import("./orchestrator/orchestrator.js");

  if (options.debug) {
    logger.setMinLevel("debug");
  }

  const orchestrator = new Orchestrator({
    workflowPath: workflow.path,
    profileName: workflow.profileName,
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
  triggerCron?(workflowName: string): Promise<boolean>;
}

async function createOrchestrator(workflows: ExpandedWorkflow[], options: CLIOptions): Promise<OrchestratorHandle> {
  if (workflows.length > 1) {
    const { MultiOrchestrator } = await import("./orchestrator/multi-orchestrator.js");
    return new MultiOrchestrator({ workflows, debug: options.debug });
  }
  const { Orchestrator } = await import("./orchestrator/orchestrator.js");
  return new Orchestrator({ workflowPath: workflows[0].path, profileName: workflows[0].profileName, debug: options.debug });
}

// ── Web Mode ────────────────────────────────────────────────────

async function runWeb(workflows: ExpandedWorkflow[], options: CLIOptions): Promise<void> {
  if (options.debug) {
    logger.setMinLevel("debug");
  }

  if (options.logFile) {
    logger.addSink(createFileSink(options.logFile));
  }

  const orchestrator = await createOrchestrator(workflows, options);

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
    const label = workflows.length > 1
      ? `${workflows.length} workflows`
      : "1 workflow";
    logger.info(`Symphony is running (${label}) with web dashboard.`);
  } catch (err) {
    logger.error(`Failed to start: ${(err as Error).message}`);
    webServer.stop();
    process.exit(1);
  }
}

// ── Headless Mode ───────────────────────────────────────────────

async function runHeadless(workflows: ExpandedWorkflow[], options: CLIOptions): Promise<void> {
  if (options.debug) {
    logger.setMinLevel("debug");
  }

  if (options.logFile) {
    logger.addSink(createFileSink(options.logFile));
  }

  const orchestrator = await createOrchestrator(workflows, options);

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
    const label = workflows.length > 1
      ? `${workflows.length} workflows`
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
