// zele watcher (launchd: dev.<layer>.zele). Polls Gmail + Google Calendar for every
// zele account and appends new events to <layer dir>/zele-events.jsonl, which the OmO session tails.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dc2 } from './dc2.ts'
import { cfg, LAYER_DIR } from './config.ts'

const HOME = process.env.HOME!
const EVENTS = `${LAYER_DIR}/zele-events.jsonl`
const STATE = `${LAYER_DIR}/zele-state.json`
const POLL_MS = 120_000
const BRIEF_HOUR_KST = 8
// Calendar alerts go straight to the alert channel from here (fixed format, no need to wake the bot session).
// Only mail and the daily brief are written to EVENTS for the OmO session.
const ALERT_CHANNEL = cfg.discord.channels.alert
const SENT_LOG = `${LAYER_DIR}/zele-sent.log`
const isHoliday = (ev: Item) => String(ev.calendar ?? '').endsWith('@virtual') || /holiday/i.test(String(ev.calendar ?? ''))
const isAllDay = (ev: Item) => !/\d{1,2}:\d{2}/.test(String(ev.start ?? ''))
// Mail that never needs a human: automated marketing/bot notices. Security, billing, and people still reach the bot session.
// Extra per-user patterns: config.json "mail_noise" (case-insensitive regex strings).
const MAIL_NOISE = [/coderabbitai\[bot\]/i, /^\s*[\[(]광고[\])]/, /mkt@/i, ...((cfg as { mail_noise?: string[] }).mail_noise ?? []).map((s) => new RegExp(s, 'i'))]
const isNoise = (m: Item) => MAIL_NOISE.some((r) => r.test(String(m.from ?? '')) || r.test(String(m.subject ?? '')))

async function notify(text: string, fallback: object) {
  try {
    await dc2.sendMessage(ALERT_CHANNEL, text)
    appendFileSync(SENT_LOG, `${new Date().toISOString()} ${text.replace(/\n/g, ' ')}\n`)
  } catch (err) {
    // Could not post: hand it to the bot session as before so nothing is lost.
    emit({ ...fallback, sendError: String(err).slice(0, 200) })
  }
}
// zele prints en-US strings ("Oct 2, 2:00 PM", "Oct 2 at 2:00 PM", "Oct 2"): show them as "10/2 14:00".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const ko = (t: unknown) =>
  String(t ?? '')
    .replace(/\b([A-Z][a-z]{2}) (\d{1,2})\b/g, (m, mon, d) => (MONTHS.includes(mon) ? `${MONTHS.indexOf(mon) + 1}/${d}` : m))
    .replace(/(\d{1,2}):(\d{2})\s*([AP])M/g, (_, h, mm, ap) => `${(Number(h) % 12) + (ap === 'P' ? 12 : 0)}:${mm}`)
    .replace(/,? at |, /g, ' ')
const when = (ev: Item) => (ev.end && ev.end !== ev.start ? `${ko(ev.start)} ~ ${ko(ev.end)}` : ko(ev.start))

type Item = Record<string, string | number | undefined>
type State = { seeded: boolean; mail: string[]; events: string[]; soon: string[]; briefDate: string }

const load = (): State =>
  existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, 'utf8'))
    : { seeded: false, mail: [], events: [], soon: [], briefDate: '' }
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s))
const emit = (e: object) => appendFileSync(EVENTS, `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`)

async function zele(args: string[]): Promise<Item[]> {
  const proc = Bun.spawn(['zele', ...args], { stdout: 'pipe', stderr: 'pipe', })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`zele ${args.join(' ')} failed: ${out.slice(0, 200)}`)
  const parsed = Bun.YAML.parse(out) as { items?: Item[] }
  return parsed?.items ?? []
}

const cap = (xs: string[]) => xs.slice(-2000)
const kstNow = () => new Date(Date.now() + 9 * 3600_000)

async function tick() {
  const s = load()
  const mail = await zele(['mail', 'list', '--filter', 'is:unread newer_than:2d', '--limit', '40'])
  for (const m of mail) {
    const key = String(m.id)
    if (s.mail.includes(key)) continue
    s.mail.push(key)
    if (!s.seeded) continue
    if (isNoise(m)) { appendFileSync(SENT_LOG, `${new Date().toISOString()} skipped mail ${m.account} ${m.from} | ${m.subject}\n`); continue }
    emit({ kind: 'mail', account: m.account, id: m.id, from: m.from, to: m.to, subject: m.subject, snippet: m.snippet })
  }

  const upcoming = await zele(['cal', 'events', '--days', '14', '--all', '--limit', '100'])
  for (const ev of upcoming) {
    const key = String(ev.id)
    if (s.events.includes(key)) continue
    s.events.push(key)
    if (s.seeded && !isHoliday(ev)) await notify(`📅 새 일정: ${when(ev)} · ${ev.summary}`, { kind: 'cal_new', account: ev.account, id: ev.id, summary: ev.summary, start: ev.start, end: ev.end })
  }

  const soon = await zele(['cal', 'events', '--from', new Date().toISOString(), '--to', '+45m', '--all'])
  for (const ev of soon) {
    const key = `${ev.id}:${ev.start}`
    if (s.soon.includes(key)) continue
    s.soon.push(key)
    // All-day events and holidays are covered by the morning brief, not a "starting soon" ping at night.
    if (isAllDay(ev) || isHoliday(ev)) continue
    await notify(`⏰ 곧 시작: ${when(ev)} · ${ev.summary}`, { kind: 'cal_soon', account: ev.account, id: ev.id, summary: ev.summary, start: ev.start, end: ev.end })
  }

  const now = kstNow()
  const today = now.toISOString().slice(0, 10)
  if (s.seeded && now.getUTCHours() >= BRIEF_HOUR_KST && s.briefDate !== today) {
    s.briefDate = today
    emit({ kind: 'daily_brief', date: today })
  }

  s.seeded = true
  s.mail = cap(s.mail)
  s.events = cap(s.events)
  s.soon = cap(s.soon)
  save(s)
}

while (import.meta.main) {
  try {
    await tick()
  } catch (err) {
    emit({ kind: 'watch_error', message: String(err).slice(0, 300) })
  }
  await Bun.sleep(POLL_MS)
}
