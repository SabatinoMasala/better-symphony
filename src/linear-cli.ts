#!/usr/bin/env bun
/**
 * Symphony Linear CLI
 * Standalone CLI for interacting with Linear from agent workspaces.
 * Used by Claude agents instead of requiring external skills.
 *
 * Usage:
 *   symphony-linear get-issue SYM-123
 *   symphony-linear create-issue --parent SYM-123 --title "Task title" [--description "..."] [--priority 2]
 *   symphony-linear update-issue SYM-123 [--title "..."] [--description "..."] [--state "In Progress"]
 *   symphony-linear create-comment SYM-123 "Comment body"
 *   symphony-linear add-label SYM-123 "agent:prd:done"
 *   symphony-linear remove-label SYM-123 "agent:prd"
 *   symphony-linear swap-label SYM-123 --remove "agent:prd" --add "agent:prd:done"
 */

import { mkdirSync, writeFileSync } from "fs";
import { join, extname } from "path";
import { LinearClient } from "./tracker/client.js";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

function getApiKey(): string {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    console.error("Error: LINEAR_API_KEY environment variable is required");
    process.exit(1);
  }
  return key;
}

function createClient(): LinearClient {
  return new LinearClient(LINEAR_ENDPOINT, getApiKey());
}

/** Extract uploaded file URLs from Markdown text (images, file links, HTML img tags) */
function extractUploadUrls(text: string): string[] {
  const urls: Set<string> = new Set();

  // ![alt](url) — images
  const mdImageRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(mdImageRe)) {
    urls.add(match[1]);
  }

  // [text](url) — file links (only Linear uploads, not arbitrary links)
  const mdLinkRe = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(mdLinkRe)) {
    const url = match[1];
    if (url.includes("uploads.linear.app")) {
      urls.add(url);
    }
  }

  // <img src="url"> or <img src='url'>
  const htmlImgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  for (const match of text.matchAll(htmlImgRe)) {
    urls.add(match[1]);
  }

  return [...urls];
}

/** Guess file extension from content-type header or URL */
function guessExtension(url: string, contentType: string | null): string {
  const ctMap: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt",
  };
  if (contentType) {
    const base = contentType.split(";")[0].trim().toLowerCase();
    if (ctMap[base]) return ctMap[base];
  }
  // Fall back to URL extension
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname).toLowerCase();
    if (ext) return ext;
  } catch {}
  // Default to .bin for unknown types
  return ".bin";
}

/** Extract a filename stem from a URL — use last UUID-like segment or last path segment */
function extractStem(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    // Walk backwards to find a UUID-like segment
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segments[i])) {
        return segments[i];
      }
    }
    // Fall back to last segment without extension
    const last = segments[segments.length - 1] || "image";
    const dot = last.lastIndexOf(".");
    return dot > 0 ? last.slice(0, dot) : last;
  } catch {}
  return `image-${Date.now()}`;
}

/** Download a single image, using auth for Linear-hosted URLs */
async function downloadImage(
  url: string,
  outputDir: string,
  apiKey: string
): Promise<{ original_url: string; local_path: string } | { original_url: string; error: string }> {
  try {
    const headers: Record<string, string> = {};
    if (url.includes("uploads.linear.app") || url.includes("linear.app")) {
      headers["Authorization"] = apiKey;
    }

    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) {
      return { original_url: url, error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type");
    const ext = guessExtension(url, contentType);
    const stem = extractStem(url);
    const filename = `${stem}${ext}`;
    const localPath = join(outputDir, filename);

    const buffer = await response.arrayBuffer();
    writeFileSync(localPath, Buffer.from(buffer));

    return { original_url: url, local_path: localPath };
  } catch (err) {
    return { original_url: url, error: (err as Error).message };
  }
}

function usage(): void {
  console.log(`Symphony Linear CLI

Commands:
  get-issue <IDENTIFIER>                      Get issue details (JSON)
  get-comments <IDENTIFIER>                   Get issue comments (JSON)
  create-issue --parent <ID> --title "..."    Create a child issue
    [--description "..."] [--priority N]
  update-issue <IDENTIFIER>                   Update an issue
    [--title "..."] [--description "..."] [--state "..."]
  create-comment <IDENTIFIER> "body"          Post a comment
  add-label <IDENTIFIER> "label-name"         Add a label
  remove-label <IDENTIFIER> "label-name"      Remove a label
  swap-label <IDENTIFIER> --remove "x" --add "y"  Swap labels atomically
  download-attachments <IDENTIFIER> [--output dir] Download all attachments from issue

Environment:
  LINEAR_API_KEY    Required. Linear API key.

Notes:
  - <IDENTIFIER> can be issue identifier (SYM-123) or UUID
  - For create-issue, --parent takes an identifier (SYM-123) and resolves it
  - Priority: 1=urgent, 2=high, 3=medium, 4=low`);
}

function parseArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
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

async function resolveIssue(client: LinearClient, identifier: string) {
  const issue = await client.getIssue(identifier);
  if (!issue) {
    console.error(`Error: Issue ${identifier} not found`);
    process.exit(1);
  }
  return issue;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    usage();
    process.exit(0);
  }

  const command = args[0];
  const { flags, positional } = parseArgs(args.slice(1));
  const client = createClient();

  switch (command) {
    case "get-issue": {
      const identifier = positional[0];
      if (!identifier) {
        console.error("Error: Issue identifier required");
        process.exit(1);
      }
      const issue = await resolveIssue(client, identifier);
      console.log(JSON.stringify(issue, null, 2));
      break;
    }

    case "get-comments": {
      const identifier = positional[0];
      if (!identifier) {
        console.error("Error: Issue identifier required");
        process.exit(1);
      }
      const comments = await client.getComments(identifier);
      console.log(JSON.stringify(comments, null, 2));
      break;
    }

    case "create-issue": {
      const parentIdentifier = flags.parent;
      const title = flags.title;
      if (!parentIdentifier || !title) {
        console.error("Error: --parent and --title are required");
        process.exit(1);
      }

      const parent = await resolveIssue(client, parentIdentifier);

      const input: Record<string, unknown> = {
        teamId: parent.team.id,
        parentId: parent.id,
        title,
      };

      if (flags.description) input.description = flags.description;
      if (flags.priority) input.priority = parseInt(flags.priority, 10);

      // Set state to Todo if possible
      try {
        const stateId = await client.findStateId(parent.team.id, "Todo");
        if (stateId) input.stateId = stateId;
      } catch {}

      const created = await client.createIssue(input);
      console.log(JSON.stringify(created, null, 2));
      break;
    }

    case "update-issue": {
      const identifier = positional[0];
      if (!identifier) {
        console.error("Error: Issue identifier required");
        process.exit(1);
      }

      const issue = await resolveIssue(client, identifier);
      const input: Record<string, unknown> = {};

      if (flags.title) input.title = flags.title;
      if (flags.description) input.description = flags.description;

      if (flags.state) {
        const stateId = await client.findStateId(issue.team.id, flags.state);
        if (stateId) {
          input.stateId = stateId;
        } else {
          console.error(`Warning: State "${flags.state}" not found, skipping state update`);
        }
      }

      if (Object.keys(input).length === 0) {
        console.error("Error: At least one of --title, --description, or --state required");
        process.exit(1);
      }

      await client.updateIssue(issue.id, input);
      console.log(JSON.stringify({ success: true, identifier: issue.identifier }));
      break;
    }

    case "create-comment": {
      const identifier = positional[0];
      const body = positional[1] || flags.body;
      if (!identifier || !body) {
        console.error("Error: Issue identifier and comment body required");
        process.exit(1);
      }

      const issue = await resolveIssue(client, identifier);
      const commentId = await client.createComment(issue.id, body);
      console.log(JSON.stringify({ success: true, comment_id: commentId }));
      break;
    }

    case "add-label": {
      const identifier = positional[0];
      const labelName = positional[1] || flags.label;
      if (!identifier || !labelName) {
        console.error("Error: Issue identifier and label name required");
        process.exit(1);
      }

      const issue = await resolveIssue(client, identifier);
      await client.addLabel(issue.id, labelName, issue.team.id);
      console.log(JSON.stringify({ success: true, label: labelName }));
      break;
    }

    case "remove-label": {
      const identifier = positional[0];
      const labelName = positional[1] || flags.label;
      if (!identifier || !labelName) {
        console.error("Error: Issue identifier and label name required");
        process.exit(1);
      }

      const issue = await resolveIssue(client, identifier);
      await client.removeLabel(issue.id, labelName);
      console.log(JSON.stringify({ success: true, label: labelName }));
      break;
    }

    case "swap-label": {
      const identifier = positional[0];
      const removeName = flags.remove;
      const addName = flags.add;
      if (!identifier || !removeName || !addName) {
        console.error("Error: Issue identifier, --remove, and --add required");
        process.exit(1);
      }

      const issue = await resolveIssue(client, identifier);
      await client.swapLabel(issue.id, removeName, addName, issue.team.id);
      console.log(JSON.stringify({ success: true, removed: removeName, added: addName }));
      break;
    }

    case "download-attachments": {
      const identifier = positional[0];
      if (!identifier) {
        console.error("Error: Issue identifier required");
        process.exit(1);
      }

      const outputDir = flags.output || ".";
      mkdirSync(outputDir, { recursive: true });

      const issue = await resolveIssue(client, identifier);

      // Collect image URLs from description and comments
      const allUrls: Set<string> = new Set();

      if (issue.description) {
        for (const url of extractUploadUrls(issue.description)) {
          allUrls.add(url);
        }
      }

      if (issue.comments?.nodes) {
        for (const comment of issue.comments.nodes) {
          if (comment.body) {
            for (const url of extractUploadUrls(comment.body)) {
              allUrls.add(url);
            }
          }
        }
      }

      // Also fetch attachments
      const attachments = await client.getAttachments(issue.id);
      for (const att of attachments) {
        if (att.url) allUrls.add(att.url);
      }

      if (allUrls.size === 0) {
        console.log(JSON.stringify({ images: [], message: "No images found" }));
        break;
      }

      const apiKey = getApiKey();
      const results = [];
      for (const url of allUrls) {
        const result = await downloadImage(url, outputDir, apiKey);
        results.push(result);
      }

      console.log(JSON.stringify({ images: results }, null, 2));
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
