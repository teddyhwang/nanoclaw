## Admin CLI (`ncl`)

The `ncl` command is available at `/usr/local/bin/ncl`. It lets you query and modify NanoClaw's central configuration — agent groups, messaging groups, wirings, users, roles, and more.

### Usage

```
ncl <resource> <verb> [<id>] [--flags]
ncl <resource> help
ncl help
```

### Resources

| Resource | Verbs | What it is |
|----------|-------|------------|
| groups | list, get, create, update, delete | Agent groups (workspace, personality, container config) |
| messaging-groups | list, get, create, update, delete | A single chat/channel on one platform |
| wirings | list, get, create, update, delete | Links a messaging group to an agent group (session mode, triggers) |
| users | list, get, create, update | Platform identities (`<channel>:<handle>`) |
| roles | list, grant, revoke | Owner / admin privileges (global or scoped to an agent group) |
| members | list, add, remove | Unprivileged access gate for an agent group |
| destinations | list, add, remove | Where an agent group can send messages |
| sessions | list, get | Active sessions (read-only) |
| user-dms | list | Cold-DM cache (read-only) |
| dropped-messages | list | Messages from unregistered senders (read-only) |
| approvals | list, get | Pending approval requests (read-only) |

### When to use

- **Looking up your own config** — `ncl groups get <your-group-id>` to see your agent group settings.
- **Finding who you're wired to** — `ncl wirings list` to see which messaging groups route to which agent groups.
- **Checking user roles** — `ncl roles list` to see who is an owner/admin.
- **Answering questions about the system** — when the user asks about groups, channels, users, or configuration, query `ncl` rather than guessing.

### Access rules

Read commands (list, get) are open. Write commands (create, update, delete, grant, revoke, add, remove) require admin approval — the request is held until an admin approves it.

### Approval flow

Write commands (create, update, delete, grant, revoke, add, remove) require admin approval. Here's what happens:

1. You run the command (e.g. `ncl groups create --name "Research" --folder research`).
2. The command returns immediately with an `approval-pending` response — it has **not** been executed yet.
3. An admin or owner gets a notification (on the same channel when possible) showing exactly what you requested, with approve/reject options.
4. Once the admin responds:
   - **Approved:** the command executes and the result is delivered back to you as a system message in this conversation.
   - **Rejected:** you get a system message saying the request was rejected.

You don't need to poll or retry — the result arrives automatically.

### Examples

```bash
# Read commands (no approval needed)
ncl groups list
ncl groups get abc123
ncl wirings list --messaging-group-id mg_xyz
ncl roles list
ncl wirings help

# Write commands (approval required)
ncl groups create --name "Research" --folder research
ncl groups update abc123 --name "Research v2"
ncl roles grant --user telegram:jane --role admin
ncl roles grant --user discord:bob --role admin --group abc123
ncl members add --user-id telegram:jane --agent-group-id abc123
ncl destinations add --agent-group-id abc123 --messaging-group-id mg_xyz
```

### Tips

- Use `ncl <resource> help` to see all available fields, types, enums, and which fields are required or updatable.
- Flags use `--hyphen-case` (e.g. `--agent-group-id`), mapped to `underscore_case` DB columns automatically.
- `list` supports filtering by any non-auto column (e.g. `ncl wirings list --messaging-group-id mg_xyz`). Default limit is 200 rows; override with `--limit N`.
- For composite-key resources (roles, members, destinations), use the custom verbs (grant/revoke, add/remove) instead of create/delete.
- Write commands return `approval-pending` immediately — don't treat this as an error. Wait for the system message with the result.
