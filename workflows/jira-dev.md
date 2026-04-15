---
tracker:
    kind: jira
    project_slug: PROJ
    terminal_states:
        - Done
        - Closed
        - Cancelled
    required_labels:
        - agent:dev
    excluded_labels:
        - agent:dev:done
        - agent:dev:progress
        - agent:dev:blocked
        - agent:dev:error

workspace:
    root: ~/.symphony/jira-dev

hooks:
    after_create: |
        git clone git@github.com:KarelBrijs/better-symphony.git .
    before_run: |
        git fetch origin main
        git checkout main
        git reset --hard origin/main
        git checkout -B {{ issue.branch_name }}

agent:
    binary: claude
    yolobox: true
    max_concurrent_agents: 2
---

# Jira Dev Agent

You are implementing **{{ issue.identifier }}**: {{ issue.title }}

## Issue Details

{{ issue.description | default: "No description provided" }}

**State:** {{ issue.state }}
{% if issue.labels.size > 0 %}**Labels:** {{ issue.labels | join: ", " }}{% endif %}

## Instructions

1. **Mark as in-progress**:
   ```bash
   bun $SYMPHONY_JIRA remove-label {{ issue.identifier }} "agent:dev"
   bun $SYMPHONY_JIRA add-label {{ issue.identifier }} "agent:dev:progress"
   ```

2. **Implement** the requested changes

3. **Write tests** if applicable

4. **Commit and push**:
   ```bash
   git add .
   git commit -m "{{ issue.identifier }}: <description>"
   git push -u origin {{ issue.branch_name }}
   ```

5. **Create a PR**:
   ```bash
   gh pr create --title "{{ issue.identifier }}: {{ issue.title }}" --body "Closes {{ issue.identifier }}"
   ```

6. **Mark as done** in Jira:
   ```bash
   bun $SYMPHONY_JIRA remove-label {{ issue.identifier }} "agent:dev:progress"
   bun $SYMPHONY_JIRA add-label {{ issue.identifier }} "agent:dev:done"
   bun $SYMPHONY_JIRA create-comment {{ issue.identifier }} "PR created: <link>"
   ```

## On Error

```bash
bun $SYMPHONY_JIRA remove-label {{ issue.identifier }} "agent:dev:progress"
bun $SYMPHONY_JIRA add-label {{ issue.identifier }} "agent:dev:error"
bun $SYMPHONY_JIRA create-comment {{ issue.identifier }} "Failed: <reason>"
```

{% if issue.children.size > 0 %}
## Subtasks

{% for child in issue.children %}
- **{{ child.identifier }}** ({{ child.state }}): {{ child.title }}
{% endfor %}
{% endif %}

{% if attempt %}
## Retry Attempt #{{ attempt }}
This is a retry. Review what failed and try a different approach.
{% endif %}
