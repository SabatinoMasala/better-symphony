## GitHub CLI

You have access to the GitHub CLI (`gh`) for working with issues.

### Common Commands

```
gh issue view <NUMBER> --json number,title,body,author,labels,state,assignees,milestone,createdAt,updatedAt,comments
gh issue create --title "..." [--body "..."] [--label "..."] [--assignee "..."]
gh issue edit <NUMBER> [--title "..."] [--body "..."]
gh issue comment <NUMBER> --body "comment body"
gh issue edit <NUMBER> --add-label "label-name"
gh issue edit <NUMBER> --remove-label "label-name"
gh issue close <NUMBER>
gh issue reopen <NUMBER>
```

### Notes
- `<NUMBER>` is the issue number (e.g., 123)
- Labels and assignees can be specified multiple times (e.g., `--label "bug" --label "priority:high"`)
- The `GH_REPO` environment variable is set automatically by Symphony
- Use labels to track workflow stages (e.g., `agent:dev` -> `agent:dev:progress` -> `agent:dev:done`)

### Examples

```bash
# Get issue details
gh issue view 42 --json number,title,body,author,labels,state,assignees,milestone,createdAt,updatedAt,comments

# Create a new issue
gh issue create --title "Fix login bug" --body "Users can't login" --label "bug"

# Add a progress label
gh issue edit 42 --add-label "agent:dev:progress"

# Post a status comment
gh issue comment 42 --body "Started working on the fix"

# Remove old label and add completion label
gh issue edit 42 --remove-label "agent:dev"
gh issue edit 42 --add-label "agent:dev:done"

# Close the issue when done
gh issue close 42
```
