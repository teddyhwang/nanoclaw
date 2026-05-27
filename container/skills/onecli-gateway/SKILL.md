---
name: onecli-gateway
description: >-
  OneCLI Gateway: transparent HTTPS proxy that injects stored credentials
  into outbound calls. You MUST use this skill when the user asks you to
  read emails, check calendar, access GitHub repos, create issues, check
  Stripe payments, or interact with ANY external service or API. Do NOT
  use browser extensions or OAuth CLI tools. Make HTTP requests directly;
  the gateway injects credentials automatically.
compatibility: Requires HTTPS_PROXY set in environment (automatic when launched via `onecli run`)
metadata:
  author: onecli
  version: '0.5.0'
---

# OneCLI Gateway

Your outbound HTTPS traffic is transparently proxied through the OneCLI
gateway, which injects stored credentials at the proxy boundary. You never
see or handle credential values directly.

## Google services — use the Google MCP, NOT curl

> **Optimus host override.** In this deployment, OneCLI does **not** inject
> credentials for `*.googleapis.com`. Google services use a separate, per-
> message-sender MCP gateway that resolves the acting user's OAuth from the
> dashboard. The skill examples below (`curl gmail.googleapis.com`) do not
> apply to Google. If you `curl` a Google endpoint you will get **401
> Unauthorized** every time — wasted turn.

For **Gmail, Google Calendar, Google Drive, Google Sheets, Google Docs, and
Google Slides**, always call the `mcp__google__google_call` MCP tool:

- `mcp__google__google_schema` — discover available methods/parameters
- `mcp__google__google_call` — dispatch any method on those six services
- `mcp__google__google_list_my_accounts` — list labeled connections
  (`primary`, `catering`, etc.)
- `mcp__google__google_workspace_members` — discover shared accounts in
  this workspace
- `mcp__google__google_capabilities` — report what the sender has connected

For **file uploads / attachments** (Drive content, Gmail attachments,
Docs/Sheets imports), write the file under `/workspace/agent/` and pass
`media_mime_type` + `media_path` to `google_call`. Without one of the
`media_*` pairs, an upload-family endpoint returns
"uploading message via /upload/\* URL required" or silently creates a
metadata-only resource. Example for Drive content upload:

```
google_call({
  service: "drive",
  resource: "files",
  method: "create",
  params: '{"uploadType":"multipart","fields":"id,name,webViewLink"}',
  body: '{"name":"labels.docx","parents":["<folder-id>"]}',
  media_mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  media_path: ".outbox/labels.docx"
})
```

`media_path` is RELATIVE to `/workspace/agent/`, no leading `/`, no `..`.
**Do NOT use `media_base64` for files over ~4 KB** — the model silently
truncates long string literals inside tool inputs with `...`, producing
a corrupt upload (Word throws `OfficeImportError 912`, zip headers
broken, no error from the upload itself). Always go through `media_path`
for attachments. `media_base64` is only safe for tiny inline payloads.

For artifacts you generated that the chat user just wants to see
(screenshots, generated docx/PDF, charts), prefer
`mcp__nanoclaw__send_file` — it posts directly to the chat without the
Drive/email roundtrip.

## How to Access Other External Services

For everything else — GitHub, Stripe, third-party REST APIs that are wired
into OneCLI — you have direct HTTP access. OAuth apps and API key services
are available through the gateway. Just make the request directly; the
gateway injects credentials if the app is connected. If not, it returns an
error with a connect URL you can present to the user.

## Making Requests (non-Google)

Call the real API URL. The gateway intercepts the request and injects
credentials automatically.

```bash
curl -s "https://api.github.com/user/repos?per_page=10"
curl -s "https://api.stripe.com/v1/charges?limit=5"
```

Standard HTTP clients (curl, fetch, requests, axios, Go net/http, git) all
honor the `HTTPS_PROXY` environment variable automatically. You do not need
to set any auth headers.

**Do not `curl` `*.googleapis.com`** — see the Google MCP section above.

## Credential Stubs for MCP Servers

Some MCP servers need local credential files to start. Stubs for connected
apps are pre-written automatically. Files containing `"onecli-managed"`
values are managed by OneCLI — do NOT modify or delete them.

If an MCP server won't start due to missing credentials, create stubs
**before** starting it. Use `"onecli-managed"` as the placeholder for all
secret values, with file permissions `0600`. See the guide at:
https://www.onecli.sh/docs/guides/credential-stubs/general-app

## When a Request Fails

If you get a 401, 403, or a gateway error (e.g., `app_not_connected`):

**Step 1 — Show the user a connect link.** Use the `connect_url` from the
error response:

> To connect [service], open this link:
> [connect_url from the error response]

If there is no `connect_url` in the error, tell the user to open the
OneCLI dashboard and connect the service there.

**Step 2 — Retry after the user connects.** Let the user know you will
retry once they have connected. When they confirm, retry the original
request. If the retry still fails, ask if they need help with the setup.

## Rules

- **Never** say "I don't have access to X" without first making the
  appropriate call — `mcp__google__google_call` for Google services,
  proxied HTTP for everything else.
- **Never** `curl` `*.googleapis.com`. Use `mcp__google__*` tools.
- **Never** use browser extensions, gcloud, or manual auth flows. The
  gateway and MCP handle credentials for you.
- **Never** ask the user for API keys or tokens directly. Direct them to
  connect the service in the OneCLI dashboard (or, for Google, at
  `/settings/integrations`).
- **Never** suggest the user open Gmail/Calendar/GitHub in their browser
  when they ask you to read or interact with those services. You have API
  access. Use it.
- If the gateway returns a policy error (403 with a JSON body), respect
  the block. Do not retry or circumvent it.
