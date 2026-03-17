---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: better-symphony-04de8977cc95
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  required_labels:
    - agent:ralph
  excluded_labels:
    - agent:ralph:done
    - agent:ralph:blocked
    - agent:ralph:error

workspace:
  root: ~/.symphony/ralph

hooks:
  after_create: |
    git clone git@github.com:SabatinoMasala/better-symphony.git .
  before_run: |
    git fetch origin main
    git checkout main
    git reset --hard origin/main
    git checkout -B {{ issue.branch_name }}

agent:
  mode: ralph_loop
  binary: claude
  max_concurrent_agents: 1
  yolobox: true
  yolobox_arguments: ["--claude-config"]
---

# Ralph Loop - Subtask {{ subtask_index }}/{{ total_subtasks }}

Working on **{{ current_subtask.identifier }}**: {{ current_subtask.title }}

## Parent Issue
**{{ parent.identifier }}**: {{ parent.title }}

---

## Current Subtask

**{{ current_subtask.identifier }}**: {{ current_subtask.title }}

{{ current_subtask.description | default: "No description provided" }}

**Priority:** {{ current_subtask.priority | default: "Not set" }}

## Progress

{% for child in parent.children %}
{% if child.state_type == "done" %}✅{% elsif child.identifier == current_subtask.identifier %}🔄{% else %}⬜{% endif %} {{ child.identifier }}: {{ child.title }}
{% endfor %}

---

## Instructions

1. Implement this subtask
2. Commit: `git commit -m "{{ parent.identifier }}: {{ current_subtask.title }}"`
3. Update Linear:
   ```bash
   bun $SYMPHONY_LINEAR update-issue {{ current_subtask.identifier }} --state "Done"
   ```

{% if is_last_subtask %}
## Final Steps (Last Subtask)

After completing this subtask:

1. Push: `git push -u origin {{ parent.branch_name }}`

2. Create PR:
   ```bash
   gh pr create --title "{{ parent.identifier }}: {{ parent.title }}" --body "Implements all subtasks"
   ```

3. Update parent issue:
   ```bash
   bun $SYMPHONY_LINEAR swap-label {{ parent.identifier }} --remove "agent:ralph" --add "agent:ralph:done"
   bun $SYMPHONY_LINEAR create-comment {{ parent.identifier }} "PR created: <link>"
   ```
{% endif %}

{% if attempt %}
## Retry #{{ attempt }}
Check what failed, continue from where you left off.
{% endif %}
