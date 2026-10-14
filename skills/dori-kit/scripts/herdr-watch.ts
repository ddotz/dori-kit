// herdr watcher (launchd: dev.<layer>.herdr). Emits agent status transitions for the
// managed agent panes (every workspace except the bot's own pane (cfg.agent_cwd); watching one workspace only missed tabs elsewhere)
// to <layer dir>/herdr-events.jsonl so the OmO session can relay them to Discord.
import { appendFileSync } from 'node:fs'
import { cfg, LAYER_DIR } from './config.ts'

const HOME = process.env.HOME!
const EVENTS = `${LAYER_DIR}/herdr-events.jsonl`
const SELF_CWD = cfg.agent_cwd
const POLL_MS = 20_000

type Agent = { pane_id: string; tab_id: string; agent?: string; agent_status?: string; title?: string; workspace_id: string; cwd?: string }

const last = new Map<string, string>()
let first = true

async function tick() {
  const proc = Bun.spawn(['herdr', 'pane', 'list'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`herdr pane list failed: ${out.slice(0, 200)}`)
  const agents: Agent[] = JSON.parse(out).result.panes
  for (const a of agents.filter((x) => x.agent_status && x.agent_status !== 'unknown' && x.cwd !== SELF_CWD)) {
    const prev = last.get(a.pane_id)
    last.set(a.pane_id, a.agent_status)
    const onlySeen = (prev === 'done' && a.agent_status === 'idle') || (prev === 'idle' && a.agent_status === 'done')
    if (first || prev === a.agent_status || onlySeen) continue
    appendFileSync(
      EVENTS,
      `${JSON.stringify({ ts: new Date().toISOString(), kind: 'agent_status', pane: a.pane_id, tab: a.tab_id, title: a.title, from: prev ?? 'none', to: a.agent_status })}\n`,
    )
  }
  first = false
}

while (true) {
  try {
    await tick()
  } catch (err) {
    appendFileSync(EVENTS, `${JSON.stringify({ ts: new Date().toISOString(), kind: 'watch_error', message: String(err).slice(0, 300) })}\n`)
  }
  await Bun.sleep(POLL_MS)
}
