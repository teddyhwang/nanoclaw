// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';
// Optimus fork: Discord + Telegram are driven from apps/optimus
// (channel-bots plugin, cybertron.db-sourced credentials, registered as
// `optimus-discord` / `optimus-telegram` via the public engine seam). The
// env-token bare adapters that used to live here were duplicated dead code
// (production .env sets no DISCORD_BOT_TOKEN/TELEGRAM_BOT_TOKEN) and a
// channelType-keyed activeAdapters collision risk — removed 2026-05-16.
// WhatsApp remains a genuine fork channel (no super-repo Baileys equivalent).
import './whatsapp.js';
