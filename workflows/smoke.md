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
        - agent:smoke
    excluded_labels:
        - agent:smoke:done
        - agent:smoke:error

workspace:
    root: ~/.symphony/smoke

hooks:
    after_create: |
        git clone git@github.com:SabatinoMasala/better-symphony.git .
    before_run: |
        git fetch origin main
        git checkout main
        git reset --hard origin/main

agent:
    binary: claude
    yolobox: true
    yolobox_arguments: ["--claude-config"]
---

# Smoke Test Agent

You are a smoke test agent verifying that Symphony picks up issues correctly.

## Issue Details

**Identifier:** {{ issue.identifier }}
**Title:** {{ issue.title }}
**State:** {{ issue.state }}

{{ issue.description | default: "No description provided" }}

## Instructions

1. **Read** the issue and understand what is being asked
2. **Analyze** the codebase to determine what changes would be needed
3. **Do NOT push any code or create any PRs** — this is a smoke test only
4. **Report back** to Linear:
   ```bash
   bun $SYMPHONY_LINEAR swap-label {{ issue.identifier }} --remove "agent:smoke" --add "agent:smoke:done"
   bun $SYMPHONY_LINEAR create-comment {{ issue.identifier }} "Smoke test agent picked up this issue successfully. Analysis complete — no code was pushed."
   bun $SYMPHONY_LINEAR update-issue {{ issue.identifier }} --state "Done"
   ```

If something goes wrong:
```bash
bun $SYMPHONY_LINEAR swap-label {{ issue.identifier }} --remove "agent:smoke" --add "agent:smoke:error"
bun $SYMPHONY_LINEAR create-comment {{ issue.identifier }} "Smoke test agent encountered an error: <reason>"
bun $SYMPHONY_LINEAR update-issue {{ issue.identifier }} --state "Error"
```
