---
tracker:
    kind: linear
    api_key: $LINEAR_API_KEY
    project_slug: my-slug
    active_states:
        - Todo
        - In Progress
    terminal_states:
        - Done
        - Cancelled
    required_labels:
        - agent:dev
    excluded_labels:
        - agent:dev:done
        - agent:dev:blocked
        - agent:dev:error

workspace:
    root: ~/.symphony/dev

hooks:
    after_create: |
        git clone git@github.com:SabatinoMasala/better-symphony.git .
    before_run: |
        BASE_BRANCH="main"
        {% if issue.base_branch %}
        if git ls-remote --exit-code --heads origin "{{ issue.base_branch }}" > /dev/null 2>&1; then
          BASE_BRANCH="{{ issue.base_branch }}"
        fi
        {% endif %}
        git fetch origin "$BASE_BRANCH"
        git checkout "$BASE_BRANCH"
        git reset --hard "origin/$BASE_BRANCH"
        git checkout -B {{ issue.branch_name }}

agent:
    mode: default
    harness: claude
    max_concurrent_agents: 2
    turn_timeout_ms: 3600000
    stall_timeout_ms: 300000
---

# Dev Agent

You are implementing **{{ issue.identifier }}**: {{ issue.title }}

## Issue Details

{{ issue.description | default: "No description provided" }}

**Priority:** {{ issue.priority | default: "Not set" }}
**State:** {{ issue.state }}

{% if issue.labels.size > 0 %}
**Labels:** {{ issue.labels | join: ", " }}
{% endif %}

## Instructions

1. **Implement** the requested changes

2. **Write tests** if applicable

3. **Commit and push**:
   ```bash
   git add .
   git commit -m "{{ issue.identifier }}: <description>"
   git push -u origin {{ issue.branch_name }}
   ```

4. **Create a PR**:
   ```bash
   gh pr create --title "{{ issue.identifier }}: {{ issue.title }}" --body "Closes {{ issue.identifier }}" --base "{{ issue.base_branch | default: 'main' }}"
   ```

5. **Update Linear**:
   ```bash
   bun $SYMPHONY_LINEAR swap-label {{ issue.identifier }} --remove "agent:dev" --add "agent:dev:done"
   bun $SYMPHONY_LINEAR update-issue {{ issue.identifier }} --state "Human Review"
   bun $SYMPHONY_LINEAR create-comment {{ issue.identifier }} "PR created: <link>"
   ```

## Guidelines

- Keep changes focused and minimal
- Follow existing code patterns
- Write descriptive commit messages
- If blocked:
  ```bash
  bun $SYMPHONY_LINEAR add-label {{ issue.identifier }} "agent:dev:blocked"
  bun $SYMPHONY_LINEAR create-comment {{ issue.identifier }} "Blocked: <reason>"
  ```

{% if issue.comments.size > 0 %}
## Feedback / Revision Mode

This issue has review comments. You are iterating on existing work, not starting from scratch.

**Read all comments carefully** — they contain feedback from the reviewer:

{% for comment in issue.comments %}
### {{ comment.user | default: "Unknown" }} ({{ comment.created_at }}):
{{ comment.body }}

{% endfor %}

### Revision Instructions

1. **Continue from the existing branch** — the before_run hook checked out a fresh branch from main, but your previous work is on the remote. Reset to it:
   ```bash
   git fetch origin
   git reset --hard origin/{{ issue.branch_name }}
   ```
2. **Read the feedback** above and address every point
3. **Make the changes**, commit, and force-push to update the PR:
   ```bash
   git add .
   git commit -m "{{ issue.identifier }}: Address review feedback"
   git push --force-with-lease origin {{ issue.branch_name }}
   ```
4. **Update Linear**:
   ```bash
   bun $SYMPHONY_LINEAR swap-label {{ issue.identifier }} --remove "agent:dev" --add "agent:dev:done"
   bun $SYMPHONY_LINEAR update-issue {{ issue.identifier }} --state "Human Review"
   bun $SYMPHONY_LINEAR create-comment {{ issue.identifier }} "Addressed feedback and updated PR."
   ```
{% endif %}

{% if attempt %}
## Retry Attempt #{{ attempt }}
This is a retry. Review what failed and try a different approach.
{% endif %}
