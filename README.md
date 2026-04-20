# Better Symphony

A headless coding agent orchestrator that polls issue trackers (Linear, GitHub Issues, GitHub PRs) or runs on cron schedules, dispatches AI agents (Claude Code), and manages the full development lifecycle.

## Installation

```bash
# Run directly with bunx (no install needed)
bunx better-symphony

# Or install globally
bun install -g better-symphony
```

## Quick Start

> **Important:** Symphony is run from **your project's directory**. Your project should have a `workflows/` folder containing your workflow `.md` files. Symphony auto-detects `workflows/*.md` in the current working directory.

```bash
cd ~/your-project          # Your project with a workflows/ directory

# Set your Linear API key
export LINEAR_API_KEY=lin_api_xxxxx

# Run all workflows in workflows/
bunx better-symphony

# Or run specific workflow(s)
bunx better-symphony -w workflows/dev.md
bunx better-symphony -w workflows/prd.md workflows/dev.md workflows/ralph.md
```

### CLI Flags

| Flag | Description |
|------|-------------|
| `-w <files>` | Run specific workflow file(s) |
| `-f <strings>` | Filter workflows by name substring (matches virtual names for matrix workflows) |
| `--headless` | Run without the TUI |
| `--routes` | Print workflow routing rules and exit |
| `--web` | Start web dashboard (implies `--headless`) |
| `--web-port <port>` | Web dashboard port (default: `3000`) |
| `--web-host <host>` | Web dashboard bind address (default: `0.0.0.0`) |
| `--dry-run` | Preview rendered prompts without launching agents |

### Project structure

```
your-project/
├── workflows/
│   ├── dev.md          # Your workflow files
│   ├── prd.md
│   └── pr-review.md
├── src/                # Your project source code
└── ...
```

## How It Works

Better Symphony uses **workflow files** (`workflows/*.md`) to define what the orchestrator does. Each workflow is a Markdown file with YAML frontmatter for configuration and a Liquid template for the agent prompt.

### Workflow Files

This repo includes example workflows you can copy into your project's `workflows/` directory:

- **`workflows/prd.md`** - PRD agent: analyzes issues and breaks complex ones into subtasks
- **`workflows/dev.md`** - Dev agent: implements tasks directly
- **`workflows/ralph.md`** - Ralph agent: loops through subtasks with fresh context per subtask
- **`workflows/pr-review.md`** - PR review agent: reviews GitHub PRs, runs tests, and posts review comments
- **`workflows/github-issues.md`** - GitHub Issues agent: implements tasks from GitHub Issues
- **`workflows/cron.md`** - Cron agent: runs on a schedule instead of polling a tracker

Each workflow specifies which labels to watch for (e.g., `agent:dev`), so multiple workflows can run in parallel without conflicts.

### Source Code

- **`src/cli.ts`** - Entry point and argument parsing
- **`src/orchestrator/`** - Poll loop, scheduling, concurrency control, and multi-workflow coordination
- **`src/tracker/`** - Tracker implementations (Linear GraphQL, GitHub Issues, GitHub PRs via `gh` CLI, Cron)
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

### Jira Tracker

For Jira Cloud, use `kind: jira`. Auth uses the `JIRA_HOST`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` environment variables (Basic auth, `email:token` base64-encoded).

```yaml
---
tracker:
  kind: jira
  project_slug: PROJ            # Jira project key
  terminal_states: [Done, Closed, Cancelled]
  required_labels: [agent:dev]
  excluded_labels: [agent:dev:done, agent:dev:progress, agent:dev:error]

workspace:
  root: ~/.symphony/jira-dev

agent:
  binary: claude
  yolobox: true
---

You are implementing **{{ issue.identifier }}**: {{ issue.title }}
```

**Config options:**

| Option | Description |
|--------|-------------|
| `project_slug` | Jira project key (e.g. `PROJ`). Required. |
| `required_labels` | Labels that must be present for an issue to be claimed |
| `excluded_labels` | Labels that exclude an issue from claiming |
| `terminal_states` | Jira statuses considered terminal (default: `Done`, `Closed`, `Cancelled`) |
| `active_states` | Jira statuses to consider active (informational; filtering is by `status not in terminal_states`) |

The Jira tracker polls with JQL: `project = {project} AND labels = {required_label} AND status not in ({terminal_states})`. Status transitions in Symphony are label-driven (e.g. `agent:dev` → `agent:dev:progress` → `agent:dev:done`) — agents call `$SYMPHONY_JIRA` to swap labels rather than transitioning Jira workflows directly. Subtasks (`issue.children`) are populated from Jira's `subtasks` field.

Agents running under a Jira workflow get `SYMPHONY_JIRA` (path to the Jira CLI) plus the `JIRA_HOST` / `JIRA_EMAIL` / `JIRA_API_TOKEN` env vars forwarded into their environment:

```bash
bun $SYMPHONY_JIRA get-issue PROJ-123
bun $SYMPHONY_JIRA add-label PROJ-123 "agent:dev:done"
bun $SYMPHONY_JIRA remove-label PROJ-123 "agent:dev"
bun $SYMPHONY_JIRA create-comment PROJ-123 "PR created: <link>"
bun $SYMPHONY_JIRA create-subtask --parent PROJ-123 --title "Implement X"
```

### Cron Tracker

For scheduled tasks that run on a cron schedule instead of polling an issue tracker, use `kind: cron`:

```yaml
---
tracker:
  kind: cron
  schedule: "0 9 * * 1-5"

workspace:
  root: ~/.symphony/cron-jobs

agent:
  binary: claude
  max_concurrent_agents: 1
  max_turns: 50
---

You are running a scheduled maintenance task.

**Schedule:** {{ cron.schedule }}
**Run #{{ cron.run_number }}**
**Scheduled at:** {{ cron.scheduled_at }}

Do the thing...
```

The `schedule` field accepts standard cron expressions powered by [croner](https://github.com/Hexagon/croner). Croner supports an optional 6th field for **seconds**, enabling sub-minute scheduling:

```
┌──────────── second (0-59, optional)
│ ┌────────── minute (0-59)
│ │ ┌──────── hour (0-23)
│ │ │ ┌────── day of month (1-31)
│ │ │ │ ┌──── month (1-12)
│ │ │ │ │ ┌── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │ │
* * * * * *
```

Examples:
- `"*/30 * * * * *"` — every 30 seconds
- `"* * * * *"` — every minute
- `"0 9 * * 1-5"` — weekdays at 9am
- `"0 */6 * * *"` — every 6 hours

Template variables available in cron workflows:

| Variable | Description |
|----------|-------------|
| `{{ cron.schedule }}` | The cron expression |
| `{{ cron.run_number }}` | Incrementing run counter |
| `{{ cron.scheduled_at }}` | When the run was scheduled (ISO 8601) |
| `{{ cron.triggered_at }}` | When the run actually started (ISO 8601) |

Key behaviors:
- **Workspace is persistent** — reused across runs, not cleaned up after each run
- **Standard cron semantics** — if a run is still in progress when the next fire time arrives, it is skipped (controlled by `max_concurrent_agents`)
- **Retries** — if the agent errors, exponential backoff retries apply

### Matrix Workflows

A single workflow file can expand into multiple virtual workflows using `profiles` and `matrix`. This is useful when you want the same agent logic to run against different projects, API keys, or repos.

```yaml
---
profiles:
    default:
        api_key: $LINEAR_API_KEY
        project_slug: better-symphony-04de8977cc95
        repo: SabatinoMasala/better-symphony
    alt:
        api_key: $LINEAR_API_KEY_ALT
        project_slug: better-symphony-alt-69ac729a1b50
        repo: SabatinoMasala/other-repo

matrix:
    - default
    - alt

tracker:
    kind: linear
    api_key: ${profile.api_key}
    project_slug: ${profile.project_slug}
    active_states: [Todo, In Progress]
    terminal_states: [Done, Cancelled]
    required_labels: [agent:dev]
    excluded_labels: [agent:dev:done, agent:dev:error]

hooks:
    after_create: |
        git clone git@github.com:${profile.repo}.git .
    before_run: |
        git fetch origin main
        git reset --hard origin/main

agent:
    max_concurrent_agents: 2
---

You are working on **{{ issue.identifier }}**: {{ issue.title }}
```

This expands into two virtual workflows: `dev:default` and `dev:alt`, each with its own API key, project, and repo. Use `${profile.*}` to reference profile values anywhere in the frontmatter or prompt template.

Use `--routes` to verify the expansion:

```bash
bunx better-symphony --routes
```

Use `-f` to run a specific profile:

```bash
bunx better-symphony -f dev:alt
```

## Yolobox Support

Better Symphony has first-class support for [Yolobox](https://github.com/finbarr/yolobox), a Docker-based sandbox for running agents. When enabled, the agent binary is launched inside a Yolobox container.

```yaml
agent:
  harness: claude                           # which agent to run: claude, codex, opencode
  yolobox: true
  yolobox_arguments: []                     # extra args passed to yolobox before the agent flags
```

This produces: `yolobox claude -- -p "..." --output-format stream-json --verbose ...`

When yolobox is enabled, Symphony automatically:
- **Mounts** the Symphony source directory into the container (so `$SYMPHONY_LINEAR` resolves correctly)
- **Forwards** environment variables via `--env`: `SYMPHONY_LINEAR`, `SYMPHONY_WORKSPACE`, `SYMPHONY_ISSUE_ID`, `SYMPHONY_ISSUE_IDENTIFIER`, and `SYMPHONY_LINEAR_API_KEY`

Without `yolobox: true`, the harness binary is invoked directly.

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
| `JIRA_HOST` | Required for Jira tracker. e.g. `your-org.atlassian.net` |
| `JIRA_EMAIL` | Required for Jira tracker. Atlassian account email |
| `JIRA_API_TOKEN` | Required for Jira tracker. Atlassian API token |
| `SYMPHONY_LINEAR` | Injected into agents. Path to the Linear CLI |
| `SYMPHONY_JIRA` | Injected into agents. Path to the Jira CLI |
| `SYMPHONY_WORKSPACE` | Injected into agents. Path to the issue workspace |
| `SYMPHONY_ISSUE_IDENTIFIER` | Injected into agents. e.g., `SYM-123` or `ISSUE-123` |

## License

MIT — see [LICENSE](LICENSE) for details.

---

Inspired by [openai/symphony](https://github.com/openai/symphony).
