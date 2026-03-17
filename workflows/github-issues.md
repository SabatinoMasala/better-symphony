---
# GitHub Issues Workflow
# Processes issues from a GitHub repository using the gh CLI

tracker:
  kind: github-issues
  repo: SabatinoMasala/better-symphony                    # Required: GitHub repository (owner/repo format)
  active_states: [open]               # Issues in these states are candidates
  terminal_states: [closed]           # Issues in these states are considered done
  required_labels: [agent:dev]        # Only pick up issues with these labels
  excluded_labels: [agent:dev:done, agent:dev:error]  # Skip issues with these labels

polling:
  interval_ms: 30000                  # Poll every 30 seconds

workspace:
  root: ~/.symphony/workspaces        # Where to create issue workspaces

hooks:
  after_create: |
    # Clone the repository into the workspace
    git clone git@github.com:SabatinoMasala/better-symphony.git .
    bun install
  before_run: |
    # Ensure we have the latest code before each run
    git fetch origin main
    git reset --hard origin/main
    git clean -fd

agent:
  binary: claude
  max_concurrent_agents: 2
  yolobox: true
  yolobox_arguments: ["--claude-config"]

---

# GitHub Issue: {{ issue.identifier }}

You are an AI coding agent working on a GitHub issue.

## Issue Details

**Number:** #{{ issue.number }}
**Title:** {{ issue.title }}
**URL:** {{ issue.url }}
**State:** {{ issue.state }}
**Author:** {{ issue.author }}

## Description

{{ issue.description | default: "No description provided." }}

{% if issue.labels.size > 0 %}
## Labels

{% for label in issue.labels %}- {{ label }}
{% endfor %}
{% endif %}

{% if issue.comments.size > 0 %}
## Comments

{% for comment in issue.comments %}
### {{ comment.user }} ({{ comment.created_at | date: "%Y-%m-%d %H:%M" }})

{{ comment.body }}

{% endfor %}
{% endif %}

## Instructions

1. Analyze the issue and understand what needs to be done
2. Implement the required changes
3. Test your changes locally
4. Commit your changes with a descriptive message
5. When complete, mark the issue as done:

```bash
# Add completion label
gh issue edit {{ issue.number }} --add-label "agent:dev:done"

# Remove the processing label
gh issue edit {{ issue.number }} --remove-label "agent:dev"

# Post a summary comment
gh issue comment {{ issue.number }} --body "Completed the implementation. Changes have been committed."
```

If you encounter errors or cannot complete the task:

```bash
# Add error label
gh issue edit {{ issue.number }} --add-label "agent:dev:error"

# Post an error comment explaining what went wrong
gh issue comment {{ issue.number }} --body "Unable to complete: [explanation]"
```

## Guidelines

- Follow the existing code style and conventions
- Write clean, maintainable code
- Add tests when appropriate
- Keep commits focused and atomic
- Don't make changes outside the scope of this issue
