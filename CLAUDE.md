# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Symphony

Symphony is a headless coding agent orchestrator. It polls issue trackers (Linear, GitHub Issues, GitHub PRs) for work items, dispatches Claude Code agents to complete them, and manages the full lifecycle from task selection through completion.

Workflows are defined as Markdown files with YAML frontmatter (config) + Liquid templates (agent prompts). Multiple workflows can run concurrently in one process.

## Commands

```bash
bun install                                    # Install dependencies
bun run src/cli.ts                             # Start with TUI (auto-detects workflows/*.md)
bun run src/cli.ts -w workflows/dev.md         # Run specific workflow(s)
bun run src/cli.ts --headless                  # Run without TUI
bun run src/cli.ts --web                       # Run with web dashboard (implies --headless)
bun run src/cli.ts --web --web-port 8080       # Web dashboard on custom port (default: 3000)
bun run src/cli.ts --dry-run                   # Preview rendered prompts, no agent launched
bun run --watch src/cli.ts                     # Dev mode with file watching
bun run src/linear-cli.ts                      # Standalone Linear CLI tool
tsc --noEmit                                   # Type check (no build step needed; Bun runs TS directly)
```

## Architecture

### Core Flow

1. **Tracker** polls for issues matching configured labels/states
2. **Orchestrator** claims an issue (atomic, prevents duplicates) and creates a per-issue **Workspace** via hooks (e.g., git clone)
3. **Config loader** renders the Liquid template with issue context to produce the agent prompt
4. **Claude runner** spawns `claude` CLI in the workspace, streaming `--output-format stream-json` events
5. On completion, labels are swapped to reflect status (`agent:dev` → `agent:dev:done` or `agent:dev:error`)

### Key Abstractions

- **Tracker interface** (`src/tracker/interface.ts`): Polymorphic abstraction over Linear (GraphQL), GitHub Issues (`gh` CLI), and GitHub PRs (`gh` CLI). Factory in `src/tracker/index.ts`.
- **Orchestrator** (`src/orchestrator/orchestrator.ts`): Single-workflow poll loop with concurrency control, retry queue, and token tracking. **MultiOrchestrator** coordinates multiple workflows sharing one Linear client.
- **Scheduler** (`src/orchestrator/scheduler.ts`): Manages poll intervals and `max_concurrent_agents` / `max_concurrent_agents_by_state` limits.
- **State** (`src/orchestrator/state.ts`): Tracks claims, running sessions, retries, and aggregate token usage.
- **Workspace manager** (`src/workspace/manager.ts`): Creates per-issue directories, runs `after_create`/`before_run` shell hooks with Liquid template support.
- **Claude runner** (`src/agent/claude-runner.ts`): Spawns Claude CLI, parses stream-json events for real-time status and token counts.

### Workflow Modes

- **default**: One agent per issue, runs to completion
- **ralph_loop**: Loops through subtasks, spawning a fresh agent per subtask with clean context

### Environment Variables

Agents receive `SYMPHONY_LINEAR` (path to Linear CLI), `SYMPHONY_WORKSPACE` (workspace path), `SYMPHONY_ISSUE_IDENTIFIER` (e.g., `SYM-123`), and `GH_REPO` (for GitHub trackers) in their environment.

## Tech Stack

- **Runtime**: Bun (executes TypeScript directly, no build step)
- **Language**: TypeScript 5.8 with strict mode
- **TUI**: React + Ink (terminal UI framework)
- **Templates**: LiquidJS for rendering workflow prompts with issue context
- **Config**: YAML frontmatter parsed from workflow Markdown files