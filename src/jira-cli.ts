#!/usr/bin/env bun
/**
 * Symphony Jira CLI
 * Standalone CLI for interacting with Jira Cloud from agent workspaces.
 *
 * Usage:
 *   symphony-jira get-issue PROJ-123
 *   symphony-jira add-label PROJ-123 "agent:dev:done"
 *   symphony-jira remove-label PROJ-123 "agent:dev"
 *   symphony-jira create-comment PROJ-123 "body"
 *   symphony-jira create-subtask --parent PROJ-123 --title "..."
 */

import { JiraTracker } from "./tracker/jira.js";
import type { TrackerConfig } from "./tracker/interface.js";

function getTracker(): JiraTracker {
  const projectKey = process.env.SYMPHONY_JIRA_PROJECT || deriveProjectFromArgs();
  const config: TrackerConfig = {
    kind: "jira",
    project_slug: projectKey,
  };
  return new JiraTracker(config);
}

/**
 * Best-effort derive the Jira project key from the first positional issue key
 * in argv (e.g. "PROJ-123" → "PROJ"). Falls back to "UNKNOWN".
 */
function deriveProjectFromArgs(): string {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^([A-Z][A-Z0-9]+)-\d+$/);
    if (m) return m[1];
  }
  return "UNKNOWN";
}

function usage(): void {
  console.log(`Symphony Jira CLI

Commands:
  get-issue <KEY>                              Get issue details (JSON)
  add-label <KEY> <label>                      Add a label
  remove-label <KEY> <label>                   Remove a label
  create-comment <KEY> "body"                  Post a comment
  create-subtask --parent <KEY> --title "..."  Create a subtask

Environment:
  JIRA_HOST        Required. e.g. your-org.atlassian.net
  JIRA_EMAIL       Required. Atlassian account email
  JIRA_API_TOKEN   Required. Atlassian API token
  SYMPHONY_JIRA_PROJECT  Optional. Default Jira project key (derived from issue key if omitted)`);
}

function parseArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    usage();
    process.exit(0);
  }

  const command = args[0];
  const { flags, positional } = parseArgs(args.slice(1));
  const tracker = getTracker();

  switch (command) {
    case "get-issue": {
      const key = positional[0];
      if (!key) {
        console.error("Error: Issue key required");
        process.exit(1);
      }
      const issue = await tracker.getIssue(key);
      if (!issue) {
        console.error(`Error: Issue ${key} not found`);
        process.exit(1);
      }
      console.log(JSON.stringify(issue, null, 2));
      break;
    }

    case "add-label": {
      const key = positional[0];
      const label = positional[1] || flags.label;
      if (!key || !label) {
        console.error("Error: Issue key and label required");
        process.exit(1);
      }
      await tracker.addLabel(key, label);
      console.log(JSON.stringify({ success: true, label }));
      break;
    }

    case "remove-label": {
      const key = positional[0];
      const label = positional[1] || flags.label;
      if (!key || !label) {
        console.error("Error: Issue key and label required");
        process.exit(1);
      }
      await tracker.removeLabel(key, label);
      console.log(JSON.stringify({ success: true, label }));
      break;
    }

    case "create-comment": {
      const key = positional[0];
      const body = positional[1] || flags.body;
      if (!key || !body) {
        console.error("Error: Issue key and comment body required");
        process.exit(1);
      }
      const commentId = await tracker.upsertComment(key, body);
      console.log(JSON.stringify({ success: true, comment_id: commentId }));
      break;
    }

    case "create-subtask": {
      const parent = flags.parent;
      const title = flags.title;
      if (!parent || !title) {
        console.error("Error: --parent and --title required");
        process.exit(1);
      }
      const created = await tracker.createSubtask(parent, title);
      console.log(JSON.stringify({ success: true, ...created }));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
