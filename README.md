# BGMI Tournament Bot (flat layout)

Standalone bot for **tournaments only** — split out of the T3 + Rebound merged
bot. The scrims / T3 bot keeps running separately with its own token and data.
Every file sits in one flat folder (no subfolders) so it's easy to upload from
mobile.

## Setup

1. Create a **new application** in the Discord Developer Portal (don't reuse the
   scrims bot's token) and add a bot user to it.
2. In the bot settings enable the **Server Members Intent** and **Message
   Content Intent** — the bot won't log in without them.
3. Invite it with these permissions: Manage Roles, Manage Channels, View
   Channels, Send Messages, Embed Links, Attach Files, Read Message History.
   Keep the bot's role **above** any tournament roles it needs to hand out.
4. Upload every file into one folder on your host, rename `.env.example` to
   `.env` and fill in `DISCORD_TOKEN` and `CLIENT_ID`.
5. `npm install`
6. `npm start`

## Commands

| Command | What it does |
|---|---|
| `!tournament` (alias `!tourney`) | Posts the tournament panel — create, switch between and manage tournaments (Manage Server required) |
| `!export_tournament [name]` (alias `!exporttournament`) | CSV of all registrations, in group order. Name is only needed when several tournaments exist |

Everything else (groups, registration panel, slot manager, rounds, punishments,
swaps, Excel export) is driven by the buttons inside the `!tournament` panel.

## Moving existing tournaments over from the old bot

Data is now stored in `tournament-data.json` (never `data.json`, so it can't
clash with the scrims bot). To carry over tournaments that already exist in the
old bot's `data.json`, run this once, with this bot stopped:

```
node migrate-from-scrims-bot.js /path/to/old/data.json
```

The old file is only read, never changed. Set `DATA_DIR` (or attach a Railway
Volume) first if you want the new file to live on a persistent disk.

**Panels the old bot already posted will stop responding.** Discord sends a
button click to the bot that posted the message, so registration panels and
slot-manager panels posted earlier by the scrims bot won't work here — post
fresh ones from `!tournament` in this bot.

## Files

| File | Purpose |
|---|---|
| `index.js` | Startup, prefix commands, interaction routing |
| `tournament-wizard-handlers.js` | The whole tournament panel / wizard |
| `tournament-store.js` | Multi-tournament support (which tournament an admin has open) |
| `pending-tournament-registrations.js` | In-progress "Register Team" state |
| `pending-group-swaps.js` | Currently unused (the wizard tracks swap requests itself) |
| `embeds.js` | Groups + slot-list embeds |
| `storage.js` | `tournament-data.json` read/write |
| `pcmd-tournament.js`, `pcmd-export-tournament.js` | Prefix commands |
| `migrate-from-scrims-bot.js` | One-time data import |

Adding more commands: drop in a `pcmd-*.js` (prefix) or `cmd-*.js` (slash) file
— `index.js` loads them automatically and throws at startup if two commands
share a name. Keep names different from the scrims bot's commands if both bots
share a server and a prefix, otherwise both bots will answer.
