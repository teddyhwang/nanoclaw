# Scheduled tasks in the Optimus fork

Upstream NanoClaw 2.1 moved scheduled-task management to `ncl tasks`. The Optimus fork does **not** adopt that control plane because task series live in host-only, per-agent-group `schedule.db` files (the S405 storage boundary), rather than session `inbound.db` files.

Agents continue to use the built-in scheduling MCP tools:

- `schedule_task`
- `list_tasks`
- `update_task`
- `cancel_task`
- `pause_task`
- `resume_task`

The host materializes due occurrences into session `inbound.db` files. Existing task series and pre-task script gates remain unchanged.
