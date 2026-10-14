// Expensive-model guard -> #알림, every 2 min (launchd dev.<layer>.usage-watch): a running child task or an active
// session on Fable (or a max/xhigh variant) is reported once. User: "fable은 내가 명시적으로 요청할때만". Plan usage: `limits`.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { cfg, LAYER_DIR } from "./config.ts";

const HOME = process.env.HOME!;
const CH = cfg.discord.channels.alert;
const STATE = `${LAYER_DIR}/usage-watch.json`;
const POLL_MS = 10 * 60_000;
type Pt = { t: number; s: number; w: number };
type State = { hist: Pt[]; sent: Record<string, number>; rates: number[]; lastPoll: number; seenExpensive: Record<string, number> };
const st: State = { hist: [], sent: {}, rates: [], lastPoll: 0, seenExpensive: {}, ...(existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {}) };
const now = Date.now();
const alerts: string[] = [];
const once = (key: string, ttlMs: number) => { if (now - (st.sent[key] ?? 0) < ttlMs) return false; st.sent[key] = now; return true; };
const EXPENSIVE = (model: string, variant?: string) => /fable/i.test(model) || /^(max|xhigh)$/i.test(variant ?? "");

const tail = (file: string, bytes: number) => {
  const size = statSync(file).size, fd = openSync(file, "r"), len = Math.min(bytes, size), buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, size - len); closeSync(fd); return buf.toString("utf8");
};
let stores: string[] = [];
try { stores = Object.keys(JSON.parse(readFileSync(`${HOME}/.omo/agent/rpc/task-stores.json`, "utf8")).stores ?? {}); } catch {}
for (const store of stores) {
  const dir = join(store, "tasks");
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    if (now - statSync(p).mtimeMs > 6 * 3600_000) continue;
    let t: any; try { t = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    if (!["running", "queued", "starting"].includes(t.status)) continue;
    const m = t.resolved_model ?? t.requested_model ?? {};
    const model = String(m.model_id ?? t.model ?? ""), variant = String(m.variant ?? "");
    if (EXPENSIVE(model, variant) && !st.seenExpensive[t.task_id]) {
      st.seenExpensive[t.task_id] = now;
      alerts.push(`비싼 모델로 도는 하위 에이전트: ${t.task_id} (${m.display ?? model}${variant ? " " + variant : ""}, 분류 ${t.category ?? "-"}, "${String(t.task_summary ?? t.description ?? "").slice(0, 60)}")`);
    }
  }
}
const sessRoot = `${HOME}/.omo/agent/sessions`;
for (const d of existsSync(sessRoot) ? readdirSync(sessRoot) : []) {
  const dd = join(sessRoot, d);
  let files: string[] = []; try { files = readdirSync(dd).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
  for (const f of files) {
    const p = join(dd, f);
    if (now - statSync(p).mtimeMs > 5 * 60_000) continue;
    const lines = tail(p, 400_000).split("\n").filter((l) => l.includes('"usage"') && l.includes('"role":"assistant"')).slice(-3);
    const models = lines.map((l) => (l.match(/"model":"([^"]+)"/) ?? [])[1] ?? "");
    const hit = models.find((m) => /fable/i.test(m));
    const key = `sess:${f}`;
    if (hit && !st.seenExpensive[key]) { st.seenExpensive[key] = now; alerts.push(`비싼 모델로 도는 세션: ${d.replace(/^--|--$/g, "").replace(/-/g, "/")} (${hit})`); }
  }
}
for (const [k, t] of Object.entries(st.seenExpensive)) if (now - t > 24 * 3600_000) delete st.seenExpensive[k];

const line = "";
st.sent = Object.fromEntries(Object.entries(st.sent).filter(([, t]) => now - t < 8 * 24 * 3600_000));
writeFileSync(STATE, JSON.stringify(st));
console.log(new Date().toISOString(), line || "(no poll)", `alerts=${alerts.length}`);
if (alerts.length && !process.env.DRY) {
  const text = `\u200b⚠️ ${alerts.join("\n⚠️ ")}${line ? `\n${line}` : ""}`;
  const p = Bun.spawn([`${HOME}/.bun/bin/agent-discordbot`, "message", "send", CH, text], { stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) { console.error("send failed", await new Response(p.stderr).text()); process.exit(1); }
} else if (alerts.length) console.log(alerts.join("\n"));
