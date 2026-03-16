# Better Symphony

A headless coding agent orchestrator that polls issue trackers (Linear, GitHub Issues, GitHub PRs) for work items, dispatches AI agents (Claude Code), and manages the full development lifecycle.

## Quick Start

```bash
# Install dependencies
bun install

# Set your Linear API key
export LINEAR_API_KEY=lin_api_xxxxx

# Run a single workflow
bun run src/cli.ts --workflow workflows/dev.md

# Run multiple workflows in one process (shared polling, fewer API calls)
bun run src/cli.ts -w workflows/prd.md workflows/dev.md workflows/ralph.md
```

## How It Works

Better Symphony uses **workflow files** (`workflows/*.md`) to define what the orchestrator does. Each workflow is a Markdown file with YAML frontmatter for configuration and a Liquid template for the agent prompt.

### Workflow Files

- **`workflows/prd.md`** - PRD agent: analyzes issues and breaks complex ones into subtasks
- **`workflows/dev.md`** - Dev agent: implements tasks directly
- **`workflows/ralph.md`** - Ralph agent: loops through subtasks with fresh context per subtask
- **`workflows/pr-review.md`** - PR review agent: reviews GitHub PRs, runs tests, and posts review comments
- **`workflows/github-issues.md`** - GitHub Issues agent: implements tasks from GitHub Issues

Each workflow specifies which labels to watch for (e.g., `agent:dev`), so multiple workflows can run in parallel without conflicts.

### Source Code

- **`src/cli.ts`** - Entry point and argument parsing
- **`src/orchestrator/`** - Poll loop, scheduling, concurrency control, and multi-workflow coordination
- **`src/tracker/`** - Tracker implementations (Linear GraphQL, GitHub Issues, GitHub PRs via `gh` CLI)
- **`src/workspace/`** - Per-issue workspace creation/cleanup and shell hooks
- **`src/agent/`** - Agent harness (spawns Claude CLI, parses stream-json output)
- **`src/config/`** - YAML frontmatter + Liquid template parsing
- **`src/logging/`** - Structured logging

### Linear CLI

Better Symphony injects a `SYMPHONY_LINEAR` env var into every agent process, pointing to a bundled Linear CLI (`src/linear-cli.ts`). Agents use it to update issues, swap labels, create subtasks, and post comments without needing separate API keys.

```bash
bun $SYMPHONY_LINEAR get-issue SYM-123
bun $SYMPHONY_LINEAR update-issue SYM-123 --state "In Progress"
bun $SYMPHONY_LINEAR swap-label SYM-123 --remove "agent:dev" --add "agent:dev:done"
bun $SYMPHONY_LINEAR create-issue --parent SYM-123 --title "Implement feature X"
bun $SYMPHONY_LINEAR create-comment SYM-123 "Done implementing"
```

### GitHub CLI

For GitHub Issues integration, agents use the standard `gh` CLI directly. Better Symphony sets the `GH_REPO` environment variable automatically.

```bash
gh issue view 123 --json number,title,body,state,labels,comments
gh issue create --title "Fix bug" --label "bug"
gh issue edit 123 --add-label "agent:dev:progress"
gh issue edit 123 --remove-label "agent:dev"
gh issue comment 123 --body "Done implementing"
gh issue close 123
```

## Workflow File Format

```yaml
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]
  required_labels: [agent:dev]
  excluded_labels: [agent:prd]

polling:
  interval_ms: 30000

workspace:
  root: ~/.symphony/workspaces

hooks:
  after_create: |
    git clone git@github.com:yourorg/repo.git .
    bun install
  before_run: |
    git fetch origin main
    git reset --hard origin/main

agent:
  harness: claude
  max_concurrent_agents: 2
  max_turns: 20
---

You are working on **{{ issue.identifier }}**: {{ issue.title }}

## Description
{{ issue.description | default: "No description provided" }}

{% if issue.children.size > 0 %}
## Subtasks
{% for child in issue.children %}
- {{ child.identifier }}: {{ child.title }} ({{ child.state }})
{% endfor %}
{% endif %}
```

### GitHub Issues Tracker

For GitHub Issues, use `kind: github-issues`:

```yaml
---
tracker:
  kind: github-issues
  repo: owner/repo
  active_states: [open]
  terminal_states: [closed]
  required_labels: [agent:dev]
  excluded_labels: [agent:dev:done]

polling:
  interval_ms: 30000

workspace:
  root: ~/.symphony/workspaces

hooks:
  after_create: |
    git clone git@github.com:owner/repo.git .
    bun install
  before_run: |
    git fetch origin main
    git reset --hard origin/main

agent:
  harness: claude
  max_concurrent_agents: 2
  max_turns: 20
---

You are working on **{{ issue.identifier }}** (#{{ issue.number }}): {{ issue.title }}

## Description
{{ issue.description | default: "No description provided" }}

When done, use `gh issue edit {{ issue.number }} --add-label "agent:dev:done"` to mark completion.
```

### GitHub PR Tracker

For GitHub Pull Requests, use `kind: github-pr`:

```yaml
---
tracker:
  kind: github-pr
  repo: owner/repo
  active_states: [open]
  terminal_states: [closed, merged]
  excluded_labels: [review:complete]

workspace:
  root: ~/.symphony/workspaces

hooks:
  after_create: |
    git clone git@github.com:owner/repo.git .
  before_run: |
    git fetch origin
    git checkout {{ issue.branch_name }}
    git merge origin/main --no-edit || true

agent:
  harness: claude
  max_concurrent_agents: 1
---

You are reviewing **PR #{{ issue.number }}**: {{ issue.title }}

**Branch:** `{{ issue.branch_name }}` → `{{ issue.base_branch }}`
**Author:** {{ issue.author }}
**Files changed:** {{ issue.files_changed }}

## Description
{{ issue.body | default: "No description provided" }}

When done, use `gh pr edit {{ issue.number }} --add-label "review:complete"` to mark completion.
```

The GitHub PR tracker exposes additional template variables: `issue.branch_name`, `issue.base_branch`, `issue.author`, `issue.files_changed`, and `issue.comments`.

## Yolobox Support

Better Symphony has first-class support for [Yolobox](https://github.com/anthropics/yolobox), a Docker-based sandbox for running agents. When enabled, the agent binary is launched inside a Yolobox container.

```yaml
agent:
  binary: "claude"                          # the agent binary yolobox runs (default: "claude")
  yolobox: true
  yolobox_arguments: ["--claude-config"]    # extra args passed to yolobox before the agent flags
```

This produces: `yolobox claude --claude-config -- -p "..." --output-format stream-json ...`

Without `yolobox: true`, the agent binary is invoked directly.

## Labels

Each workflow watches for a specific label and adds status suffixes as it progresses:

| Label | Purpose |
|-------|---------|
| `agent:prd` | Break down issues into subtasks |
| `agent:dev` | Implement tasks directly |
| `agent:ralph` | Loop through subtasks with fresh context |

Status flow: `agent:dev` → `agent:dev:progress` → `agent:dev:done` (or `agent:dev:error`)

To retry a failed issue: remove the `:error` label and re-add the base label.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LINEAR_API_KEY` | Required for Linear tracker. Your Linear API key |
| `GH_REPO` | Required for GitHub trackers. Repository in `owner/repo` format |
| `SYMPHONY_LINEAR` | Injected into agents. Path to the Linear CLI |
| `SYMPHONY_WORKSPACE` | Injected into agents. Path to the issue workspace |
| `SYMPHONY_ISSUE_IDENTIFIER` | Injected into agents. e.g., `SYM-123` or `ISSUE-123` |

## License

MIT — see [LICENSE](LICENSE) for details.

---

Inspired by [openai/symphony](https://github.com/openai/symphony).
