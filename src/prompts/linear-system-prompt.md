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

### Downloading Attachments

If an issue description or comments contain images (screenshots, diagrams, mockups, etc.), download them so you can view them:

```
bun $SYMPHONY_LINEAR download-attachments <IDENTIFIER> --output ./attachments
```

This extracts all image URLs from the issue description, comments, and Linear attachments, then downloads them to the specified directory. Output is a JSON manifest mapping original URLs to local file paths.

**When to use:** Always download attachments before starting work on an issue that references visual content (UI mockups, screenshots of bugs, design specs, diagrams). The downloaded files can then be read directly to understand the visual context.

### Notes
- `<IDENTIFIER>` is the issue identifier (e.g. SYM-123) or UUID
- Priority values: 1=urgent, 2=high, 3=medium, 4=low
- For `create-issue`, `--parent` takes an identifier and resolves team/project automatically
- All commands output JSON on success
- Use `swap-label` when transitioning between workflow stages (e.g. `agent:prd` -> `agent:prd:progress`)
