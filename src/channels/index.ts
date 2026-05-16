// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';
// Optimus fork note: all non-cli channels (Discord, Telegram, WhatsApp) are
// driven from apps/optimus via the public engine seam — channel-bots plugin
// for Discord/Telegram (cybertron.db creds), whatsapp-channel plugin for
// WhatsApp (env creds). No in-tree self-registration; this file is otherwise
// upstream-identical. (Fork-opt 2026-05-16.)
