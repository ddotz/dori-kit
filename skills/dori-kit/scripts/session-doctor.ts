// Self-recovery for omo tabs that die in compaction. launchd dev.<layer>.doctor runs this every 2 minutes.
// Stage 1: kill, resume the same session, /compact, continue. Stage 2 (stage 1 failed or it broke again within 2h):
// start a fresh session in the same pane with a handover built from the old session file.
import { dc2 } from "./dc2.ts";
import { cfg, LAYER_DIR } from "./config.ts";
import { readdirSync, readFileSync } from "node:fs";
import { killTree, omoProcs, panes, paneSend, sessionFile, sessionIdOf, type OmoProc } from "./omo-proc.ts";

const HOME = process.env.HOME!;
const STATE = `${LAYER_DIR}/doctor-state.json`;
const WORKLOG = cfg.discord.channels.worklog;
const ALERT = cfg.discord.channels.alert;
const DORI = cfg.agent_cwd;
const NAME = cfg.identity.name;
const DRY = process.argv.includes("--dry");
const SPIN_CPU = 80;
const SPIN_IDLE_MIN = 15;
const envFor = (cwd: string) => (cwd === DORI ? "PI_CACHE_RETENTION=long " : "");
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

type SessionState = { apiRevertAt?: number; stage?: number; at?: number; spin?: number; rlResumed?: string; rlEpisode?: string };
const state: Record<string, SessionState> = await Bun.file(STATE).json().catch(() => ({}));
const save = () => Bun.write(STATE, JSON.stringify(state, null, 1));

function parseTail(text: string) {
  const out: any[] = [];
  for (const l of text.split("\n")) {
    if (!l.startsWith("{")) continue;
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}
const tail = async (file: string, bytes: number) => {
  const f = Bun.file(file);
  return f.slice(Math.max(0, f.size - bytes)).text();
};
const isRateLimit = (e: any) =>
  e?.type === "message" && e.message?.role === "assistant" && e.message?.stopReason === "error" && /429|rate_limit|overloaded|usage limit/i.test(e.message?.errorMessage ?? "");
const isCompactionError = (e: any) =>
  e?.type === "message" && e.message?.role === "assistant" && e.message?.stopReason === "error" && /compaction/i.test(e.message?.errorMessage ?? "");

async function waitFor(cond: () => Promise<boolean>, ms: number, step = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(step); }
  return false;
}
const procIn = async (cwd: string) => (await omoProcs()).find((p) => p.cwd === cwd);

function lastTexts(entries: any[], n: number, cap: number) {
  const texts: string[] = [];
  for (const e of entries) {
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const t = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
    if (t.length > 200) texts.push(`(${e.timestamp})\n${t}`);
  }
  return texts.slice(-n).join("\n\n=====\n\n").slice(-cap);
}

function modelOf(entries: any[]) {
  let model = "anthropic/claude-opus-5-5";
  let thinking = "medium";
  for (const e of entries) {
    if (e.type === "model_change") model = `${e.provider}/${e.modelId}`;
    if (e.type === "message" && e.message?.role === "assistant" && e.message.provider && e.message.model) model = `${e.message.provider}/${e.message.model}`;
    if (e.type === "thinking_level_change") thinking = e.thinkingLevel;
  }
  return { model, thinking };
}

async function restartSame(pane: string, proc: OmoProc, sid: string, file: string): Promise<boolean> {
  await killTree(proc.pid);
  await paneSend(pane, "");
  await paneSend(pane, `${envFor(proc.cwd)}omo --session ${sid}`);
  if (!(await waitFor(async () => !!(await procIn(proc.cwd)), 60e3))) return false;
  await Bun.sleep(25e3);
  const from = Bun.file(file).size;
  await paneSend(pane, "/compact");
  let failed = false;
  const ok = await waitFor(async () => {
    const added = parseTail(await Bun.file(file).slice(from).text());
    if (added.some(isCompactionError)) { failed = true; return true; }
    return added.some((e) => e.type === "compaction");
  }, 20 * 60e3, 10e3);
  if (!ok || failed) return false;
  await Bun.sleep(5e3);
  const cont = proc.cwd === DORI
    ? `[자동 복구] 컴팩트 실패로 멈춰서 session-doctor가 같은 세션으로 재시작하고 컴팩트했어. ${LAYER_DIR}/MODE.md와 state.json 읽고 Discord inbox·herdr·zele 등 모니터를 다시 걸고, 그사이 inbox.jsonl에 온 메시지 처리해.`
    : `[자동 복구] 컴팩트 실패로 멈춰서 ${NAME}이(가) 같은 세션으로 재시작하고 컴팩트했어. 하던 작업을 마지막 Now/Next부터 이어서 해줘. 커밋·푸시·외부 발송 규칙은 그대로.`;
  await paneSend(pane, cont);
  return true;
}

async function restartFresh(pane: string, cwd: string, oldSid: string, file: string, why = "컴팩트 실패로 멈췄고, 같은 세션 재시작도 실패해서", headOverride?: string): Promise<boolean> {
  const entries = parseTail(await tail(file, 6_000_000));
  // The bot's default is Opus medium (user 2026-10-01), whatever the dead session ran with.
  const { model, thinking } = cwd === DORI ? { model: "anthropic/claude-opus-5-5", thinking: "medium" } : modelOf(entries);
  const recent = lastTexts(entries, 3, 8000);
  const git = (await Bun.$`git -C ${cwd} status --short`.quiet().nothrow()).stdout.toString().split("\n").slice(0, 40).join("\n");
  const proc = await procIn(cwd);
  if (proc) await killTree(proc.pid);
  await paneSend(pane, "");
  await paneSend(pane, `${envFor(cwd)}omo --model ${model} --thinking ${thinking}`);
  if (!(await waitFor(async () => !!(await procIn(cwd)), 60e3))) return false;
  await Bun.sleep(25e3);
  const head = headOverride ?? (cwd === DORI
    ? `먼저 ${LAYER_DIR}/MODE.md, state.json을 읽고 ${NAME} 모드를 재개해(모니터 재등록, inbox.jsonl 밀린 메시지 처리).`
    : "대화 맥락이 없으니 아래 최근 보고와 디스크 상태(git)로 이어서 해줘. 긴 출력은 파일로 두고 요약만 읽어 컨텍스트를 아껴.");
  const prompt = `[자동 복구 인수인계] 이전 세션 ${oldSid}가 ${why} 새 세션으로 이어간다. 이전 세션 파일: ${file} (필요하면 끝부분만 읽어).
${head}
커밋·푸시·외부 발송은 원래 규칙대로 사용자 확인 후.

--- 이전 세션 최근 보고 ---
${recent || "(없음)"}
${git ? `\n--- git status --short ---\n${git}` : ""}`;
  await paneSend(pane, prompt);
  return true;
}

const KA_PREFIX = "[keepalive]";
const KA_TEXT = `${KA_PREFIX} 캐시 유지용 핑이야. 도구 호출·디스코드 전송·state 수정 없이 ok 한 단어만 답해.`;
const KA_MIN = 50, KA_MAX = 58, KA_CAP = 12;
async function keepalive(proc: OmoProc, entries: any[], lastMsg: any): Promise<boolean> {
  if (lastMsg?.message?.role !== "assistant" || lastMsg.message.stopReason !== "stop") return false;
  const idle = (Date.now() - Date.parse(lastMsg.timestamp)) / 60e3;
  if (idle < KA_MIN || idle > KA_MAX || proc.cpu >= 20) return false;
  const kst = new Date(Date.now() + 9 * 3600e3);
  const hm = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (hm >= 60 && hm < 270) return false; // 01:00-04:30 KST: nightly starts a fresh session at 04:30
  let pings = 0;
  for (const e of entries.slice().reverse()) {
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const c = e.message.content;
    const t = typeof c === "string" ? c : (c ?? []).map((x: any) => x.text ?? "").join("");
    if (!t.trimStart().startsWith(KA_PREFIX)) break;
    pings++;
  }
  if (pings >= KA_CAP) return false;
  const pane = await paneFor(proc.cwd);
  if (!pane) return false;
  log(`keepalive ping ${pings + 1}/${KA_CAP} to ${pane} (idle ${Math.round(idle)}m)`);
  if (!DRY) await paneSend(pane, KA_TEXT);
  return true;
}

async function paneFor(cwd: string) {
  const all = await panes();
  const here = (p: any) => p.cwd === cwd || p.foreground_cwd === cwd;
  return all.find((p) => here(p) && p.agent === "pi")?.pane_id ?? all.find(here)?.pane_id;
}

// Orphaned omo RPC hosts: a finished `omo -p` (or a crashed tab) can leave an
// --internal-rpc-host-supervisor reparented to launchd (ppid 1) with its `--mode rpc` child,
// ~100-300MB each, forever. Reap those older than 10 min whose shard socket has no client.
async function reapOrphans() {
  const ps = (await Bun.$`ps -axo pid=,ppid=,etime=,command=`.nothrow().quiet()).stdout.toString();
  const mins = (et: string) => { const [d, hms] = et.includes("-") ? et.split("-") : ["0", et]; const p = hms.split(":").map(Number); while (p.length < 3) p.unshift(0); return +d * 1440 + p[0] * 60 + p[1]; };
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || m[2] !== "1" || !m[4].includes("--internal-rpc-host-supervisor") || mins(m[3]) < 10) continue;
    const pid = m[1];
    const socks = (await Bun.$`lsof -a -p ${pid} -U -Fn`.nothrow().quiet()).stdout.toString().split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1));
    let inUse = false;
    for (const s of socks) {
      const users = (await Bun.$`lsof -t ${s}`.nothrow().quiet()).stdout.toString().split("\n").filter((x) => x && x !== pid);
      if (users.length) inUse = true;
    }
    if (inUse) continue;
    const kids = (await Bun.$`pgrep -P ${pid}`.nothrow().quiet()).stdout.toString().split("\n").filter(Boolean);
    log(`orphan rpc host ${pid} (+${kids.join(",") || "-"}) age ${m[3]}: ${DRY ? "(dry) would kill" : "killing"}`);
    if (!DRY) await Bun.$`kill ${pid} ${kids}`.nothrow().quiet();
  }
}
// API drift (user 2026-10-12): on a Max 429 the bot falls back to the API key, and omo only tries to go back at an idle turn boundary,
// which a continuously busy session never gets. Once the subscription is usable again, restart the same session on Opus medium
// when it is idle (not mid-tool) and has no running children; at most once per 30 min so a still-limited account cannot loop.
const API_REVERT_IDLE_MIN = 2, API_REVERT_GAP_MIN = 30;
async function claudeUsable(): Promise<boolean> {
  const out = (await Bun.$`bun ${LAYER_DIR}/limits.ts --json`.cwd(cfg.projects.herdr_web_ui).nothrow().quiet()).stdout.toString();
  try {
    const c = JSON.parse(out).providers.find((p: any) => p.id === "claude");
    return !!c && !c.problem && c.windows.length > 0 && c.windows.every((w: any) => w.used_percent < 99);
  } catch { return false; }
}
function ownTasksRunning(sid: string): boolean {
  const dir = `${DORI}/.omo/senpi-task/tasks`;
  try {
    return readdirSync(dir).some((f) => {
      if (!f.endsWith(".json")) return false;
      try { const t = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); return t.parent_session_id === sid && ["running", "queued", "starting"].includes(t.status); } catch { return false; }
    });
  } catch { return false; }
}

// Nightly rotation (user 2026-10-14): nightly.ts calls `--rotate <cwd>` for an idle project tab whose session file passed
// the size cap. Compaction never shrinks the file (a project tab hung on a 168MB one), so swap to a fresh session + handover.
const rotateIdx = process.argv.indexOf("--rotate");
if (rotateIdx > 0) {
  const cwd = process.argv[rotateIdx + 1];
  const proc = await procIn(cwd);
  const file = proc && sessionFile(cwd, proc.sessionArg);
  const sid = file && sessionIdOf(file);
  const pane = await paneFor(cwd);
  if (!proc || !file || !sid || !pane) { console.log(`ROTATE_FAIL no proc/session/pane for ${cwd}`); process.exit(1); }
  const mb = Math.round(Bun.file(file).size / 1e6);
  const ok = DRY || await restartFresh(pane, cwd, sid, file, `세션 파일이 ${mb}MB로 커져서 야간 정리 때`,
    "대화 맥락이 없으니 아래 최근 보고와 디스크 상태(git)를 읽고 프로젝트 상황만 파악해 둬. 정기 교체라 진행 중이던 작업은 없어: 새 작업을 시작하지 말고 다음 지시를 기다려. 이전 맥락이 필요하면 이전 세션 파일 끝부분을 찾아 읽어.");
  console.log(`${ok ? "ROTATED" : "ROTATE_FAIL"} ${cwd} ${sid} ${mb}MB${DRY ? " (dry)" : ""}`);
  process.exit(ok ? 0 : 1);
}

await reapOrphans().catch((e) => log(`reapOrphans failed: ${e}`));

for (const proc of await omoProcs()) {
  const file = sessionFile(proc.cwd, proc.sessionArg);
  const sid = file && sessionIdOf(file);
  if (!file || !sid) continue;
  const idleMin = (Date.now() - (await Bun.file(file).stat()).mtimeMs) / 60e3;
  const entries = parseTail(await tail(file, 300_000));
  const lastMsg = entries.filter((e) => e.type === "message").at(-1);
  const st = (state[sid] ??= {});
  const name = proc.cwd.split("/").pop();

  // Rate/usage limit (429): omo gives up after its quick retries and nothing re-prompts the tab.
  // Once the server's retry-after has passed (+1 min), send one continue per error.
  if (isRateLimit(lastMsg)) {
    const ra = Number(lastMsg.message.errorMessage.match(/retry-after-ms:\s*(\d+)/)?.[1] ?? 10 * 60e3);
    const due = Date.parse(lastMsg.timestamp) + Math.min(ra, 6 * 3600e3) + 60e3;
    if (st.rlResumed === lastMsg.timestamp) continue;
    if (Date.now() < due) {
      // Say once per limit episode (user 2026-10-01: "최초에 한번 멈췄고, 언제 재개하겠다 이거만 보내고 그냥 조용히 해").
      // omo retries write a new 429 entry every couple of minutes, so key on the episode, not the entry.
      if (!DRY && !st.rlEpisode) {
        st.rlEpisode = lastMsg.timestamp; await save();
        const at = new Date(due + 120e3).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });
        await dc2.sendMessage(WORKLOG, `⏸️ ${name} 탭: 사용량 한도(429)로 멈춤 → ${at}쯤 자동 재개 예정 (그 전에 직접 말 걸면 바로 이어감)`);
      }
      continue;
    }
    const pane = await paneFor(proc.cwd);
    if (!pane) { log(`no pane for ${proc.cwd}`); continue; }
    log(`${name} ${sid}: rate limit since ${lastMsg.timestamp}, resuming in ${pane}`);
    if (DRY) continue;
    st.rlResumed = lastMsg.timestamp; await save();
    await paneSend(pane, proc.cwd === DORI
      ? "[자동 재개] 레이트리밋(429)으로 멈췄다가 한도 풀린 시각이 지나서 session-doctor가 깨웠어. 멈추기 직전 요청을 이어서 처리해. 모니터가 살아있는지 확인하고, 그사이 inbox.jsonl에 온 메시지도 처리해."
      : `[자동 재개] 레이트리밋(429)으로 멈췄다가 한도가 풀려서 ${NAME}이(가) 깨웠어. 하던 작업을 마지막 Now/Next부터 이어서 해줘. 커밋·푸시·외부 발송 규칙은 그대로.`);
    continue;
  }
  // A non-429 last message ends the episode; the next limit gets one new notice.
  if (st.rlEpisode && !DRY) { delete st.rlEpisode; await save(); }

  // Keepalive for the bot's 1h prompt cache (user 2026-10-05): a ping just before expiry costs a 0.1x cache read,
  // an expired cache costs a 2x rewrite of the whole context. Silent: no Discord message about pings.
  if (proc.cwd === DORI && await keepalive(proc, entries, lastMsg)) continue;

  if (proc.cwd === DORI && modelOf(entries).model.startsWith("anthropic-api/") && idleMin >= API_REVERT_IDLE_MIN
      && !(st.apiRevertAt && Date.now() - st.apiRevertAt < API_REVERT_GAP_MIN * 60e3) && !ownTasksRunning(sid) && await claudeUsable()) {
    const pane = await paneFor(proc.cwd);
    if (pane) {
      log(`${name} ${sid}: on API key but Claude subscription usable -> fresh Opus medium session in ${pane}${DRY ? " (dry)" : ""}`);
      if (!DRY) {
        st.apiRevertAt = Date.now(); await save();
        // Fresh session + handover, like the nightly (user 2026-10-12): the model switch misses the cache either way,
        // and re-writing a small handover context is far cheaper than re-writing the whole old one (~264K on 10/12).
        const up = await restartFresh(pane, proc.cwd, sid, file, "API 키로 돌다가 클코 구독이 다시 쓸 수 있게 돼서 (같은 세션으로 돌리면 모델이 바뀌어 전체 컨텍스트 캐시를 다시 써야 해서)");
        await dc2.sendMessage(WORKLOG, up ? `🩺 ${NAME}: 구독이 돌아와서 API에서 Opus medium 새 세션으로 넘어감 (인수인계 포함)` : `🩺⚠️ ${NAME}: API→Opus 복귀 재시작 실패. 확인 필요`);
      }
      continue;
    }
  }

  const compactFail = isCompactionError(lastMsg) && idleMin >= 2;
  const spinningNow = proc.cpu >= SPIN_CPU && idleMin >= SPIN_IDLE_MIN;
  st.spin = spinningNow ? (st.spin ?? 0) + 1 : 0;
  const spinning = (st.spin ?? 0) >= 2;
  if (!compactFail && !spinning) continue;

  const why = compactFail ? "컴팩트 실패로 멈춤" : `CPU ${proc.cpu}%로 ${Math.round(idleMin)}분째 기록 없이 헛돎`;
  log(`${name} ${sid}: ${why}`);
  const pane = await paneFor(proc.cwd);
  if (!pane) { log(`no pane for ${proc.cwd}`); continue; }
  if (DRY) { log(`(dry) would recover ${pane}`); continue; }

  const recentStage = st.at && Date.now() - st.at < 2 * 3600e3 ? st.stage ?? 0 : 0;
  if (recentStage >= 2) { log("already did a fresh restart within 2h; leaving it"); continue; }
  st.at = Date.now();
  st.spin = 0;
  if (recentStage < 1) {
    st.stage = 1; await save();
    if (await restartSame(pane, proc, sid, file)) {
      await dc2.sendMessage(WORKLOG, `🩺 ${name} 탭 자동 복구: ${why} → 같은 세션으로 재시작, 컴팩트 성공, 이어서 진행 중`);
      continue;
    }
    log("same-session restart failed; going fresh");
  }
  st.stage = 2; await save();
  const ok = await restartFresh(pane, proc.cwd, sid, file);
  await dc2.sendMessage(ok ? WORKLOG : ALERT, ok
    ? `🩺 ${name} 탭 자동 복구: ${why}, 같은 세션으로도 안 살아나서 **새 세션 + 인수인계**로 이어가는 중 (이전 세션 ${sid.slice(0, 8)})`
    : `🩺⚠️ ${name} 탭 자동 복구 실패: ${why}. 새 세션도 안 떠요. 확인 필요 (pane ${pane})`);
}
await save();
