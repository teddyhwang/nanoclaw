# Credentials & External Services

**Google services (Gmail, Calendar, Drive, Sheets, Docs, Slides) → always use the `mcp__google__*` tools, NEVER `curl *.googleapis.com`.** In this deployment the OneCLI proxy does not inject Google credentials; raw HTTP to `*.googleapis.com` returns `401` every time. For file attachments / uploads, write the file to `/workspace/agent/<rel>` and pass `media_mime_type` + `media_path` to `mcp__google__google_call` — do not inline large bytes via `media_base64`, the model truncates long string literals and the upload lands corrupt with no error signal. Run `/onecli-gateway` for the full skill body including worked examples.

Your other HTTP requests (GitHub, Stripe, Slack, etc.) go through the OneCLI proxy, which injects real credentials automatically. Just call any API directly — the proxy adds auth before it reaches the service.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

If you get a `401`/`403`/`app_not_connected`, the error response contains a `connect_url` — you MUST show it to the user as a bare URL on its own line (no angle brackets, no markdown link syntax) so they can click to connect. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.

**Exception — public URLs:** OneCLI relabels _any_ upstream 401/403 from a host it holds no credential for as `credential_not_found`. On a URL that needs no login (an email unsubscribe link, a public page) that means the site's bot protection refused a non-browser client, not that a credential is missing: don't send a connect link; retry once in the browser (it egresses directly, not through OneCLI), and if that is also blocked, report it as blocked by the site. Only `"error":"blocked_by_policy"` is an OneCLI policy block.
