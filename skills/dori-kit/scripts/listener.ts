// Discord gateway listener for the bot (cfg.identity.name).
// Appends every non-bot message the bot can see to <layer dir>/inbox.jsonl
// (one JSON object per line). The OmO session tails this file via a monitor.
// Run under launchd (dev.<layer>.listener) so it survives agent-session restarts.
import { appendFileSync } from 'node:fs'
import { cfg, LAYER_DIR } from './config.ts'
const { DiscordBotClient, DiscordBotListener, DiscordIntent } = await import(`${process.env.HOME}/.bun/install/global/node_modules/agent-messenger/dist/src/platforms/discordbot/index.js`)

const HOME = process.env.HOME!
const INBOX = `${LAYER_DIR}/inbox.jsonl`
const STATUS = `${LAYER_DIR}/listener.log`

const BOT_USER_ID = cfg.discord.bot_user_id
const status = (msg: string) => appendFileSync(STATUS, `${new Date().toISOString()} ${msg}\n`)

const client = await new DiscordBotClient().login()
const listener = new DiscordBotListener(client, {
  intents:
    DiscordIntent.Guilds |
    DiscordIntent.GuildMessages |
    DiscordIntent.GuildMessageReactions |
    DiscordIntent.DirectMessages |
    DiscordIntent.MessageContent,
})

const botMessageIds = new Set<string>()

listener.on('message_create', (e) => {
  if (e.author?.bot) {
    botMessageIds.add(e.id)
    return
  }
  const record = {
    ts: new Date().toISOString(),
    kind: 'message',
    id: e.id,
    channel_id: e.channel_id,
    guild_id: e.guild_id ?? null,
    author: { id: e.author.id, username: e.author.username, name: e.author.global_name ?? e.author.username },
    content: e.content,
    reply_to: e.message_reference?.message_id ?? null,
    attachments: (e.attachments ?? []).map((a) => ({ name: a.filename, url: a.url, type: a.content_type })),
  }
  appendFileSync(INBOX, `${JSON.stringify(record)}\n`)
})

listener.on('message_update', async (e) => {
  if (e.content === undefined || botMessageIds.has(e.id)) return
  const original = await client.getMessage(e.channel_id, e.id).catch(() => null)
  if (original?.author?.id === BOT_USER_ID) {
    botMessageIds.add(e.id)
    return
  }
  appendFileSync(
    INBOX,
    `${JSON.stringify({ ts: new Date().toISOString(), kind: 'edit', id: e.id, channel_id: e.channel_id, content: e.content })}\n`,
  )
})

listener.on('connected', (info) => status(`connected as ${info.user.username} (${info.user.id})`))
listener.on('disconnected', () => status('disconnected (auto-reconnect)'))
listener.on('error', (err) => status(`error: ${err.message}`))

process.on('SIGTERM', () => {
  status('SIGTERM, stopping')
  listener.stop()
  process.exit(0)
})

await listener.start()
status('listener started')
