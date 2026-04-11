---
tracker:
    kind: github-pr
    repo: SabatinoMasala/better-symphony
    # PRs without review:complete are "active"
    excluded_labels:
        - review:complete

workspace:
    root: ~/.symphony/pr-review

hooks:
    after_create: |
        git clone git@github.com:SabatinoMasala/better-symphony.git .
    before_run: |
        git fetch origin
        git checkout {{ issue.branch_name }}
        git merge origin/master --no-edit || true

agent:
    binary: claude
    yolobox: true
    yolobox_arguments: []
---

# PR Review Agent

You are reviewing **PR #{{ issue.number }}**: {{ issue.title }}

## PR Details

{{ issue.body | default: "No description provided" }}

**Branch:** `{{ issue.branch_name }}` → `{{ issue.base_branch }}`
**Author:** {{ issue.author }}
**Files changed:** {{ issue.files_changed }}

{% if issue.labels.size > 0 %}
**Labels:** {{ issue.labels | join: ", " }}
{% endif %}

## Your Task

1. **Merge master** into the PR branch (already done by hooks, check for conflicts)

2. **Run tests**:
   ```bash
   composer dump-autoload
   php artisan test --parallel
   ```

3. **Review the code** - check for:
   - Security issues (SQL injection, XSS, auth bypass)
   - Performance issues (N+1 queries, missing indexes)
   - Code quality (error handling, edge cases)
   - Test coverage

4. **Post review comment**:
   ```bash
   gh pr comment {{ issue.number }} --body "## Code Review - {{ issue.title }}

   [Your findings here - be specific with file:line references]
   
   **Verdict:** [Ready to merge / Needs changes / Has blockers]"
   ```

5. **Add the review:complete label**:
   ```bash
   gh pr edit {{ issue.number }} --add-label "review:complete"
   ```

{% if issue.comments.size > 0 %}
## Previous Comments

{% for comment in issue.comments %}
### {{ comment.author }} ({{ comment.created_at }}):
{{ comment.body }}

{% endfor %}

**Note:** If there are comments from the author or reviewers, address their feedback.
{% endif %}

## Guidelines

- Be constructive and specific
- Reference exact files and line numbers
- Distinguish blockers from suggestions
- If tests fail, note it in the review
