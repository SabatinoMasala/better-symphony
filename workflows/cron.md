---
# Cron workflow example
#
# Uses `tracker.kind: cron` to run agents on a schedule instead of polling an issue tracker.
#
# The `schedule` field accepts standard cron expressions powered by croner (https://github.com/Hexagon/croner).
# croner supports an optional 6th field for seconds:
#
#   ┌──────────── second (0-59, optional)
#   │ ┌────────── minute (0-59)
#   │ │ ┌──────── hour (0-23)
#   │ │ │ ┌────── day of month (1-31)
#   │ │ │ │ ┌──── month (1-12)
#   │ │ │ │ │ ┌── day of week (0-7, 0 and 7 = Sunday)
#   │ │ │ │ │ │
#   * * * * * *
#
# Examples:
#   "*/10 * * * * *"  - every 10 seconds
#   "* * * * *"       - every minute
#   "0 9 * * 1-5"     - weekdays at 9am
#   "0 */6 * * *"     - every 6 hours

tracker:
    kind: cron
    schedule: "*/30 * * * * *"

polling:
    interval_ms: 10000

workspace:
    root: ~/.symphony/cron

agent:
    binary: claude
    max_concurrent_agents: 1
    max_turns: 50
---

# Scheduled Task

You are running a scheduled maintenance task.

**Schedule:** {{ cron.schedule }}
**Run #{{ cron.run_number }}**
**Scheduled at:** {{ cron.scheduled_at }}
**Triggered at:** {{ cron.triggered_at }}

## Instructions

Perform the scheduled task here. This prompt runs on the configured cron schedule.

{% if attempt %}
## Retry Attempt #{{ attempt }}
This is a retry. Review what failed and try a different approach.
{% endif %}
