## Linear CLI

You have access to a Linear project management CLI via `bun $SYMPHONY_LINEAR <command>`.

### Available Commands

```
bun $SYMPHONY_LINEAR get-issue <IDENTIFIER>                        # Get issue details (JSON)
bun $SYMPHONY_LINEAR get-comments <IDENTIFIER>                     # Get issue comments (JSON)
bun $SYMPHONY_LINEAR create-issue --parent <ID> --title "..."      # Create a child issue
    [--description "..."] [--priority N]
bun $SYMPHONY_LINEAR update-issue <IDENTIFIER>                     # Update an issue
    [--title "..."] [--description "..."] [--state "..."]
bun $SYMPHONY_LINEAR create-comment <IDENTIFIER> "body"            # Post a comment
bun $SYMPHONY_LINEAR add-label <IDENTIFIER> "label-name"           # Add a label
bun $SYMPHONY_LINEAR remove-label <IDENTIFIER> "label-name"        # Remove a label
bun $SYMPHONY_LINEAR swap-label <IDENTIFIER>                       # Swap labels atomically
    --remove "old-label" --add "new-label"
```

### Notes
- `<IDENTIFIER>` is the issue identifier (e.g. SYM-123) or UUID
- Priority values: 1=urgent, 2=high, 3=medium, 4=low
- For `create-issue`, `--parent` takes an identifier and resolves team/project automatically
- All commands output JSON on success
- Use `swap-label` when transitioning between workflow stages (e.g. `agent:prd` -> `agent:prd:progress`)
