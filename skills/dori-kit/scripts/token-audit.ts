// Nightly token-leak audit (user 2026-10-05: "새벽에 닥터 도는거에서 토큰 누수 있는거 점검 추가하자"). Pure TS, no LLM calls.
// Scans omo session jsonl files (main tabs + subagent children) active in the last 24h, writes a full report to
// logs/token-audit-YYYYMMDD.md, keeps a 14-day rolling history, and posts ONE short Korean message to #알림 only
// when something is flagged. Report-only: every fix below is a "제안"; nothing is ever applied automatically.
// Proposals are restricted to no-trade-off fixes (user: "성능 트레이드 오프가 있으면 안되고"); cuts that could cost
// capability (weaker model, shorter context, fewer checks) go to the "보류(트레이드오프 있음)" section instead.
// usage: bun token-audit.ts [--dry] [--hours N]    (--dry prints the alert instead of sending it)
// Last stdout line: RESULT {"flags":N,"report":"...","sent":bool}
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, LAYER_DIR } from "./config.ts";
const HOME = process.env.HOME!;
const BASE = `${LAYER_DIR}`;
const LOG_DIR = `${BASE}/logs`;
const HISTORY = `${BASE}/token-audit.json`;
const SESS_ROOT = `${HOME}/.omo/agent/sessions`;
const STORES_FILE = `${HOME}/.omo/agent/rpc/task-stores.json`;
const ALERT_CH = cfg.discord.channels.alert;
const LIMITS = `${BASE}/limits.ts`; // read-only plan usage, same source as `limits`
const SEND = (text: string) => [`${HOME}/.bun/bin/agent-discordbot`, "message", "send", ALERT_CH, text]; // bot identity only (never agent-discord)
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const HOURS = Number(argv[argv.indexOf("--hours") + 1]) || 24;
const BUST_CW = 50_000;
const BIG_CTX = 300_000;
const SUB_NOTE = 20e6, SUB_FLAG = 50e6;
// senpi trims the context per request once the LAST usage is >= 50% of the window (context-pipeline.js
// shouldApplyContextReduction); the trim is not persisted, so requests alternate full/trimmed and the trimmed prefix
// shifts -> cache breaks. Children never compact inside one run. (methodology-fix-20261008.md)
const REDUCE_GATE = 500_000;
const STEER_BIG = 250_000;
// Where each recurring warning class already has a rule; a class flagged on consecutive days despite its rule is
// escalated as 🔁 so the carrier (repo AGENTS.md / guard hook / brief) gets fixed instead of adding more prose.
const RULES: Record<string, string> = {
  "대형 하위에이전트": "레포 AGENTS.md 'Agent work' 1-3 (단계별 태스크, ≤250K, 후속은 새 태스크) + agent-guard(task_send 차단)",
  "반복 호출": "AGENTS.md 'Agent work' 5 (blocking 대기 한 번) + agent-guard(peek/sleep 차단)",
  "헛깨움": "AGENTS.md 'Agent work' 6 / bot rules 'No goals' (대기 세션에 goal 금지)",
  "캐시 깨짐": "AGENTS.md 'Agent work' 2 (≤250K로 senpi 50% 축소 구간 회피); 재핀·날짜 원인은 업스트림",
  "대형 컨텍스트": "AGENTS.md 'Agent work' 2 (태스크당 ≤250K)",
};
const CAUSE: Record<string, [string, string]> = {
  reduction: ["senpi context-reduction(창 50%↑에서 요청마다 맥락 축소·비영속)", "태스크를 단계로 나눠 컨텍스트 ≤250K 유지(AGENTS.md 'Agent work' 2); 원인 자체는 업스트림 이슈 A"],
  repin: ["컴팩트 직후 늦은 메모리 재핀", "로컬 조치 없음, 업스트림 이슈 C"],
  date: ["UTC 날짜 변경(environment-context)", "로컬 조치 없음(하루 1회), 업스트림 이슈 D"],
};
const IDLE_OUT = 300;
const WAKE = new Set(["goal-continuation", "omo-senpi:wake", "senpi-monitor:notification", "senpi-codemode:notification", "senpi-terminal:notification"]);
const KA_PREFIX = "[keepalive]";

const now = Date.now();
const since = now - HOURS * 3600e3;
const kstDate = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const kst = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const K = (n: number) => `${Math.round(n / 1e3)}K`;
const $ = (n: number) => `$${n.toFixed(2)}`;
type Src = { file: string; label: string; child?: { id: string; name: string; summary: string; requested?: string; runTotal?: number; spawner?: string } };
const srcs: Src[] = [];
const fresh = (p: string) => { try { return statSync(p).mtimeMs >= since; } catch { return false; } };
function walk(dir: string, depth: number) {
  let ents: import("node:fs").Dirent[] = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && !e.name.endsWith("-artifacts") && !["resident-blobs", "extensions", "session-holders"].includes(e.name)) walk(p, depth - 1);
    } else if (e.name.endsWith(".jsonl") && fresh(p)) {
      const proj = dir.slice(SESS_ROOT.length + 1).split("/")[0].replace(/^--|--$/g, "").replace(/-/g, "/").replace(HOME.slice(1), "~");
      srcs.push({ file: p, label: `${proj} ${e.name.match(/_([0-9a-f-]{8})/)?.[1] ?? e.name.slice(0, 8)}` });
    }
  }
}
walk(SESS_ROOT, 3);
let stores: string[] = [];
try { stores = Object.keys(JSON.parse(readFileSync(STORES_FILE, "utf8")).stores ?? {}); } catch {}
for (const store of stores) {
  const cdir = join(store, "children");
  if (!existsSync(cdir)) continue;
  for (const tid of readdirSync(cdir)) {
    const sdir = join(cdir, tid, "sessions", tid);
    let files: string[] = [];
    try { files = readdirSync(sdir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(sdir, f);
      if (!fresh(p)) continue;
      let t: any = {};
      try { t = JSON.parse(readFileSync(join(store, "tasks", `${tid}.json`), "utf8")); } catch {}
      const rq = t.requested_model;
      const tname = t.name && t.name !== tid ? t.name : String(t.task_summary ?? tid).slice(0, 40);
      srcs.push({ file: p, label: `task:${tname} (${tid})`, child: { id: tid, name: tname, summary: String(t.task_summary ?? t.description ?? ""), requested: rq ? `${rq.provider}/${rq.model_id}` : undefined, runTotal: t.run_stats?.total_tokens, spawner: t.parent_session_id ? `${String(t.spawn_spec?.cwd ?? "?").replace(HOME, "~")} ${String(t.parent_session_id).slice(0, 8)}` : undefined } });
    }
  }
}
type Bust = { ts: number; cw: number; cost: number; cr: number; prevCtx: number; events: string[]; anthropic: boolean; cause: string };
type S = {
  src: Src; start?: number; tokens: number; cost: number; turns: number; cw: number; cr: number; out: number; inp: number;
  busts: Bust[]; explained: Record<string, number>; bigNew: number;
  wakes: Record<string, { n: number; tokens: number; cost: number }>; wakeTurns: number;
  ping: { n: number; tokens: number; cost: number; expired: number; useful: number; wasted: number; pending: number; avoided: number };
  builtinKa: number; errTurns: number; errStreak: number; maxErrStreak: number; errCodes: Record<string, number>; compactErr: number;
  bigStreak: number; maxBigStreak: number; bigTokens: number; bigCost: number; maxCtx: number; compactions: number;
  fbTurns: number; fbFirst?: number; fbLast?: number; fbModels: Set<string>; intended?: string; fbSegs: number[][];
  toolHash: string; toolStreak: number; maxToolStreak: number; maxToolDesc: string; loopTokens: number; loopCost: number; loopGuard: number;
  ctxSeries: number[]; readRate: number; writeRate: number; reduced: number; bigSteers: number;
};
const mk = (src: Src): S => ({
  src, tokens: 0, cost: 0, turns: 0, cw: 0, cr: 0, out: 0, inp: 0, busts: [], explained: {}, bigNew: 0, wakes: {}, wakeTurns: 0,
  ping: { n: 0, tokens: 0, cost: 0, expired: 0, useful: 0, wasted: 0, pending: 0, avoided: 0 }, builtinKa: 0,
  errTurns: 0, errStreak: 0, maxErrStreak: 0, errCodes: {}, compactErr: 0, bigStreak: 0, maxBigStreak: 0, bigTokens: 0, bigCost: 0, maxCtx: 0, compactions: 0,
  fbTurns: 0, fbModels: new Set(), fbSegs: [], toolHash: "", toolStreak: 0, maxToolStreak: 0, maxToolDesc: "", loopTokens: 0, loopCost: 0, loopGuard: 0,
  ctxSeries: [], readRate: 0, writeRate: 0, reduced: 0, bigSteers: 0,
});

async function* lines(file: string) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.file(file).stream()) {
    buf += dec.decode(chunk, { stream: true });
    let start = 0, i: number;
    while ((i = buf.indexOf("\n", start)) >= 0) { yield buf.slice(start, i); start = i + 1; }
    buf = buf.slice(start);
  }
  if (buf) yield buf;
}
const code429 = (m: any) => /429|rate_limit/i.test(m.errorMessage ?? "") || (m.diagnostics ?? []).some((d: any) => d?.details?.statusCode === 429);
const sameModel = (a: string, b: string) => { const x = a.split("/").pop()!, y = b.split("/").pop()!; return x.includes(y) || y.includes(x); };

// Claude exhaustion intervals: an Anthropic 429 blocks until its retry-after (5h when unknown, sanity cap 7d: weekly-limit
// 429s carry retry-after of 1-2 days and a 6h cap flagged expected fallbacks as leaks); a fallback inside one is expected, a fallback that outlives it by >60 min is the leak.
const exhaust: { from: number; to: number; why: string }[] = [];
async function analyze(src: Src): Promise<S> {
  const s = mk(src);
  if (src.child?.requested) s.intended = src.child.requested;
  let ev: string[] = [], compacted = false, modelChanged = false, thinkChanged = false, user = false, keepalive = false;
  let prev: { ts: number; ctx: number; ttl1h: boolean; out: number } | undefined;
  let lastCompactTs = 0;
  let prevStop = "stop";
  let pingChain = 0, fbOpen = false;
  let rTok = 0, rCost = 0, wTok = 0, wCost = 0;
  for await (const line of lines(src.file)) {
    if (line.length < 20) continue;
    const head = line.slice(0, 320);
    if (head.includes('"type":"message"')) {
      if (head.includes('"role":"toolResult"')) continue;
      if (head.includes('"role":"user"')) {
        if (line.slice(0, 900).includes(KA_PREFIX)) keepalive = true; else user = true;
        if (src.child && prev && prev.ctx >= STEER_BIG) s.bigSteers++;
        continue;
      }
      if (!head.includes('"role":"assistant"')) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message, u = m.usage ?? {}, ts = Date.parse(o.timestamp);
      const inWin = ts >= since;
      const newTurn = prevStop !== "toolUse";
      const tokens = u.totalTokens ?? 0, cost = u.cost?.total ?? 0;
      const cw = u.cacheWrite ?? 0, cr = u.cacheRead ?? 0, ctx = (u.input ?? 0) + cr + cw;
      const uncached = cw + (u.input ?? 0); // Anthropic reports new prefix tokens as cacheWrite, OpenAI-style providers as input
      const calls = (m.content ?? []).filter((c: any) => c.type === "toolCall");
      const model = `${m.provider}/${m.model}`;
      if (inWin) s.start ??= ts;
      if (m.stopReason === "error") {
        if (inWin) {
          s.errTurns++; s.errStreak++; s.maxErrStreak = Math.max(s.maxErrStreak, s.errStreak);
          const code = String(m.diagnostics?.find((d: any) => d.details?.statusCode)?.details?.statusCode ?? (m.errorMessage ?? "").match(/\b([45]\d\d)\b/)?.[1] ?? "other");
          s.errCodes[code] = (s.errCodes[code] ?? 0) + 1;
          if (/compaction/i.test(m.errorMessage ?? "")) s.compactErr++;
        }
        if (m.provider === "anthropic" && (code429(m))) {
          const ra = Number(m.errorMessage?.match(/retry-after-ms:\s*(\d+)/)?.[1] ?? m.diagnostics?.map((d: any) => d?.details?.retryAfterMs).find((v: any) => typeof v === "number") ?? 5 * 3600e3);
          exhaust.push({ from: ts, to: ts + Math.min(ra, 7 * 24 * 3600e3), why: `429 ${kst(ts)}` });
        }
        prevStop = "error";
        if (!tokens) continue;
      } else s.errStreak = 0;
      if (!tokens) { prevStop = m.stopReason ?? "stop"; continue; }
      if (inWin) {
        s.turns++; s.tokens += tokens; s.cost += cost; s.cw += cw; s.cr += cr; s.out += u.output ?? 0; s.inp += u.input ?? 0;
        if (cr) { rTok += cr; rCost += u.cost?.cacheRead ?? 0; }
        if (cw) { wTok += cw; wCost += u.cost?.cacheWrite ?? 0; }
        s.maxCtx = Math.max(s.maxCtx, ctx);
        if (src.child) s.ctxSeries.push(ctx);
        const trimmed = !!prev && !compacted && prev.ctx + prev.out >= REDUCE_GATE * 0.98 && ctx < prev.ctx * 0.9;
        if (trimmed) s.reduced++;
        // cache busts: big write that did not reuse the prefix, without compaction / model change / TTL gap
        if (uncached > BUST_CW && prev) {
          const gapMin = (ts - prev.ts) / 60e3, ttl = prev.ttl1h ? 60 : 5;
          const why = compacted ? "compaction" : modelChanged ? "model change" : thinkChanged ? "thinking change" : gapMin > ttl ? `gap>${ttl}m` : "";
          if (why) s.explained[why] = (s.explained[why] ?? 0) + 1;
          else if (cr < prev.ctx * 0.8) {
            const events = [...new Set(ev)];
            const cause = trimmed ? "reduction"
              : events.includes("omo-memory:projection-pin") && ts - lastCompactTs < 20 * 60e3 ? "repin"
              : events.includes("environment-context") && new Date(prev.ts).toISOString().slice(0, 10) !== new Date(ts).toISOString().slice(0, 10) ? "date" : "";
            s.busts.push({ ts, cw: uncached, cr, cost: (u.cost?.cacheWrite ?? 0) + (u.cost?.input ?? 0), prevCtx: prev.ctx, events, anthropic: /anthropic|claude/i.test(model), cause });
          }
          else s.bigNew++; // prefix reused; the write is genuinely new content (big tool output)
        }
        if (keepalive && !user) {
          s.ping.n++; s.ping.tokens += tokens; s.ping.cost += cost;
          if (!(cr > 0 && cw < BUST_CW)) s.ping.expired++;
          pingChain++;
        } else if (newTurn && pingChain) {
          if (cr > 0 && cw < BUST_CW) { s.ping.useful += pingChain; s.ping.avoided += cr; } else s.ping.wasted += pingChain;
          pingChain = 0;
        }
        // idle wakes: a new turn started only by wake-type events, ending with no tool call and a tiny reply
        const wakeBy = ev.filter((e) => WAKE.has(e));
        if (newTurn && !user && !keepalive && wakeBy.length) {
          s.wakeTurns++;
          if (!calls.length && (u.output ?? 0) <= IDLE_OUT) {
            const k = wakeBy.at(-1)!;
            const w = (s.wakes[k] ??= { n: 0, tokens: 0, cost: 0 });
            w.n++; w.tokens += tokens; w.cost += cost;
          }
        }
        if (ctx > BIG_CTX) { s.bigStreak++; s.bigTokens += tokens; s.bigCost += cost; s.maxBigStreak = Math.max(s.maxBigStreak, s.bigStreak); } else s.bigStreak = 0;
        if (s.intended && !sameModel(model, s.intended)) {
          s.fbTurns++; s.fbFirst ??= ts; s.fbLast = ts; s.fbModels.add(model);
          if (!fbOpen) { s.fbSegs.push([]); fbOpen = true; }
          s.fbSegs.at(-1)!.push(ts);
        } else fbOpen = false;
        for (const c of calls) {
          const h = c.name + JSON.stringify(c.arguments ?? {}).slice(0, 4000);
          if (h === s.toolHash) {
            s.toolStreak++;
            if (s.toolStreak >= 3) { s.loopTokens += tokens / calls.length; s.loopCost += cost / calls.length; }
            if (s.toolStreak > s.maxToolStreak) { s.maxToolStreak = s.toolStreak; s.maxToolDesc = `${c.name} ${JSON.stringify(c.arguments ?? {}).slice(0, 90)}`; }
          } else { s.toolHash = h; s.toolStreak = 1; }
        }
      }
      if (!s.intended) s.intended = model;
      prev = { ts, ctx, ttl1h: cw > 0 ? (u.cacheWrite1h ?? 0) > 0 : (prev?.ttl1h ?? false), out: u.output ?? 0 };
      prevStop = m.stopReason ?? "stop";
      ev = []; compacted = modelChanged = thinkChanged = user = keepalive = false;
      continue;
    }
    if (head.startsWith('{"type":"compaction"')) {
      compacted = true; s.bigStreak = 0;
      const ts = Date.parse(head.match(/"timestamp":"([^"]+)"/)?.[1] ?? "");
      if (!(ts < since)) s.compactions++;
      if (ts) lastCompactTs = ts;
      continue;
    }
    if (head.startsWith('{"type":"model_change"')) {
      modelChanged = true;
      try {
        const o = JSON.parse(line);
        s.intended = o.reason === "fallback" && o.originalModelId ? `${o.originalProvider}/${o.originalModelId}` : `${o.provider}/${o.modelId}`;
      } catch {}
      continue;
    }
    if (head.startsWith('{"type":"thinking_level_change"')) { thinkChanged = true; continue; }
    const ct = head.match(/"customType":"([^"]+)"/)?.[1];
    if (ct) {
      ev.push(ct === "pi-rules.scan" ? `pi-rules.scan(${head.match(/"reason":"([^"]+)"/)?.[1] ?? "?"})` : ct);
      if (ct === "loop-guard:notice" && !(Date.parse(line.slice(-80).match(/"timestamp":"([^"]+)"/)?.[1] ?? "") < since)) s.loopGuard++;
      if (ct === "cache-keepalive" || ct === "goal-cache-warmup") s.builtinKa++;
    }
  }
  if (pingChain) s.ping.pending += pingChain;
  s.readRate = rTok ? rCost / rTok : 0;
  s.writeRate = wTok ? wCost / wTok : 0;
  return s;
}

const t0 = Date.now();
const results = (await Promise.all(srcs.map((x) => analyze(x).catch((e) => { console.error(`skip ${x.file}: ${e}`); return null; })))).filter((x): x is S => !!x && x.turns + x.errTurns > 0);
const elapsed = (Date.now() - t0) / 1000;

async function claudeLimits(): Promise<{ left: number; kind: string; resetsAt: string | null } | null> {
  try {
    const p = Bun.spawn([process.execPath, LIMITS, "--json", "--no-tasks"], { stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(60e3) });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    const c = (JSON.parse(out).providers ?? []).find((x: any) => x.id === "claude");
    if (!c || c.problem || !c.windows?.length) return null;
    const w = c.windows.reduce((a: any, b: any) => (b.used_percent > a.used_percent ? b : a));
    return { left: Math.max(0, 100 - w.used_percent), kind: w.kind, resetsAt: w.resets_at ?? null };
  } catch { return null; }
}
const lim = results.some((s) => s.fbTurns) ? await claudeLimits() : null;
if (lim && lim.left <= 1) exhaust.push({ from: lim.kind === "session" ? now - 5 * 3600e3 : since - 1, to: now + 1, why: `Claude ${lim.kind === "week" ? "주간" : "5시간"} 한도 ${lim.left}% 남음${lim.resetsAt ? ` (리셋 ${kst(Date.parse(lim.resetsAt))})` : ""}` });
const blockedAt = (t: number) => exhaust.filter((e) => t >= e.from && t <= e.to);
// Per fallback segment: minutes spent on the fallback after Claude had capacity again (0 when every turn was inside an exhaustion interval).
function fallbackAfterCapacity(seg: number[]) {
  const free = seg.filter((t) => !blockedAt(t).length);
  if (!free.length) return 0;
  const back = Math.max(seg[0], ...exhaust.filter((e) => e.to <= free[0]).map((e) => e.to));
  return (free.at(-1)! - back) / 60e3;
}
type Finding = { flag: boolean; kind: string; who: string; what: string; amount: string; saveCost: number; evidence: string; fix?: string; tip?: string; hold?: string; recur?: number };
const F: Finding[] = [];
const BUST_FIX: [RegExp, string][] = [
  [/^pi-rules\.scan\((reload|startup|resume)\)$|^senpi-memory\.session-binding$/, "리로드/재개 때 프롬프트를 새로 조립하며 대화 프리픽스가 바뀜 → 재개 시 projection 핀 revision·environment-context를 이전 값 그대로 재사용(omo 쪽 수정 후보)"],
  [/^omo-memory:(projection-pin|notice|soul-updated)$/, "메모리 projection 재핀이 프롬프트 앞부분을 바꾸는지 확인 → 세션 중엔 핀 고정 유지하고 변경은 notice 메시지로만 전달"],
  [/^environment-context$/, "environment-context 재주입(날짜·cwd 변경)이 프리픽스를 깨는지 확인 → 변경분을 대화 끝에 append"],
  [/^senpi-memory\.reflection-(launched|completion)$/, "메모리 reflection 커밋 뒤 프롬프트 재조립 여부 확인 → 세션 중엔 핀 고정 유지"],
  [/^(rule-activation|pi-rules\.scan)$/, "규칙 활성화가 시스템 프롬프트에 끼어드는지 확인 → 메시지로 주입해 프리픽스 유지"],
  [/^claude-sdk-oauth-binding$/, "OAuth 바인딩 재설정 경로 확인 (토큰 교체 시 캐시 키 변경)"],
  [/^omo-kibitzer:/, "kibitzer recall 주입 위치 확인 → 프리픽스 뒤쪽 메시지로"],
  [/^senpi\.todo-|^senpi-task\.usage$/, "시스템 리마인더 주입 위치 확인 → 프리픽스 뒤쪽 메시지로"],
];
for (const s of results) {
  const who = s.src.label;
  if (s.busts.length) {
    const cw = s.busts.reduce((a, b) => a + b.cw, 0), wc = s.busts.reduce((a, b) => a + b.cost, 0);
    const save = s.busts.reduce((a, b) => a + Math.max(0, b.cost - b.cw * s.readRate), 0);
    const evCount: Record<string, number> = {};
    for (const b of s.busts) if (!b.cause) for (const e of b.events) evCount[e] = (evCount[e] ?? 0) + 1;
    const top = Object.entries(evCount).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const causes = [...new Set(s.busts.map((b) => b.cause).filter(Boolean))];
    const fixes = [...new Set([
      ...causes.map((c) => `${CAUSE[c]![0]} x${s.busts.filter((b) => b.cause === c).length} -> ${CAUSE[c]![1]}`),
      ...top.map(([e]) => BUST_FIX.find(([re]) => re.test(e))?.[1]).filter(Boolean),
    ])];
    const anth = s.busts.filter((b) => b.anthropic);
    const bestEffort = anth.length < s.busts.length ? ` (그중 ${s.busts.length - anth.length}회는 OpenAI 계열: 캐시가 best-effort라 프리픽스 변경이 아닌 단순 미스일 수 있음)` : "";
    F.push({
      flag: anth.length >= 3 || anth.reduce((a, b) => a + b.cw, 0) > 1e6, kind: "캐시 깨짐", who,
      what: `캐시 깨짐 ${s.busts.length}회 (컴팩트/모델변경/TTL 아님)${bestEffort}`, amount: `미캐시 재입력 ${M(cw)} tok, ${$(wc)}`, saveCost: save,
      evidence: s.busts.slice(0, 6).map((b) => `${kst(b.ts)} 새로 ${K(b.cw)}/읽기 ${K(b.cr)} (직전 컨텍스트 ${K(b.prevCtx)}) ← ${b.cause ? CAUSE[b.cause]![0] : b.events.join(", ") || "(이벤트 없음: 도구 목록/시스템 프롬프트 변경 의심)"}`).join("; "),
      tip: fixes[0]?.split(/ → | -> /)[0] ?? "직전 주입 이벤트 확인",
      fix: `제안: ${fixes.join(" / ") || `직전 이벤트(${top.map(([e]) => e).join(", ") || "없음"})가 프롬프트 프리픽스를 바꾸는지 확인해 고정`} — 예상 절감 ~${$(save)}/일 (같은 토큰을 쓰기 대신 읽기로). 컨텍스트·모델은 그대로라 성능 영향 없음`,
    });
  }
  const wk = Object.entries(s.wakes);
  const wn = wk.reduce((a, [, w]) => a + w.n, 0), wt = wk.reduce((a, [, w]) => a + w.tokens, 0), wc = wk.reduce((a, [, w]) => a + w.cost, 0);
  if (wn) {
    const by = wk.sort((a, b) => b[1].cost - a[1].cost).map(([k, w]) => `${k} ${w.n}회 ${M(w.tokens)} ${$(w.cost)}`).join(", ");
    const main = wk[0][0];
    const fix = main === "senpi-monitor:notification" ? "모니터 필터를 소스 쪽에서 좁혀(grep) 반응할 필요 없는 라인·중복 이벤트가 세션을 깨우지 않게"
      : main === "goal-continuation" ? "끝난 목표를 update_goal complete로 닫아 continuation 루프를 멈추기"
      : main === "omo-senpi:wake" ? "이미 처리한 태스크 완료 알림이 반복되면 중복 알림 원인(notify_on_terminal) 정리"
      : "백그라운드 셀/터미널 완료 알림 중 할 일 없는 것을 줄이기(완료 대기는 monitor 하나로)";
    F.push({
      flag: wn >= 10 || wc >= 5, kind: "헛깨움", who, tip: fix.split("(")[0], what: `할 일 없이 깨어난 턴 ${wn}회 (전체 깨움 ${s.wakeTurns})`, amount: `${M(wt)} tok, ${$(wc)}`, saveCost: wc,
      evidence: by, fix: `제안: ${fix} — 예상 절감 ~${$(wc)}/일. 실제 일을 시키는 이벤트는 그대로라 성능 영향 없음`,
    });
  }
  if (s.ping.n || s.builtinKa) {
    const p = s.ping;
    const avoided = p.avoided * Math.max(0, s.writeRate - s.readRate);
    const bad = p.expired + p.wasted;
    F.push({
      flag: p.expired > 0 || (p.wasted >= 3 && p.wasted > p.useful), kind: "keepalive", who, tip: p.expired ? "핑 시점을 TTL 만료 전으로" : "안 쓰이는 핑 체인 제한",
      what: `핑 ${p.n}회: 캐시 유지 성공 ${p.n - p.expired}, 이미 만료 ${p.expired}; 뒤이은 실제 턴에서 캐시 적중 ${p.useful}, 소용없음 ${p.wasted}, 대기 ${p.pending}${s.builtinKa ? `; omo 내장 keepalive/warmup 이벤트 ${s.builtinKa}` : ""}`,
      amount: `핑 비용 ${M(p.tokens)} tok, ${$(p.cost)} / 재작성 회피 ~${$(avoided)}`, saveCost: bad ? p.cost * (bad / Math.max(1, p.n)) : 0,
      evidence: `ping→실제턴 적중 시 회피한 캐시 재작성 ${M(p.avoided)} tok`,
      fix: bad ? `제안: ${p.expired ? "핑이 TTL 만료 뒤에 도착함 → 핑 시점을 마지막 캐시 쓰기 기준 50분 이내로 당기기" : "아무도 안 쓰는 긴 핑 체인 → 직전 실제 턴 이후 경과로 체인 길이를 제한(사용 패턴 기반)"} — 예상 절감 ~${$(p.cost * (bad / Math.max(1, p.n)))}/일. 캐시만 다루므로 성능 영향 없음` : undefined,
    });
  }
  if (s.maxErrStreak >= 3) {
    F.push({
      flag: s.maxErrStreak >= 5, kind: "에러 재시도", who, tip: "429 연속 재시도 상한", what: `에러 턴 ${s.errTurns}회, 최장 연속 ${s.maxErrStreak}회 (${Object.entries(s.errCodes).map(([k, v]) => `${k}×${v}`).join(", ")})`,
      amount: `${$(0)}~ (대부분 0토큰, 대기·재시도 시간 낭비)`, saveCost: 0, evidence: s.compactErr ? `컴팩트 실패 ${s.compactErr}회 포함` : "",
      fix: `제안: 429는 retry-after까지 멈추고 재개는 doctor에 맡기기(연속 재시도 상한) — 결과물엔 영향 없음`,
    });
  }
  if (s.maxBigStreak >= 10) {
    F.push({
      flag: s.compactErr > 0, kind: "대형 컨텍스트", who, what: `컨텍스트 >${K(BIG_CTX)}로 컴팩트 없이 연속 ${s.maxBigStreak}턴 (최대 ${K(s.maxCtx)})`,
      amount: `해당 턴 ${M(s.bigTokens)} tok, ${$(s.bigCost)}`, saveCost: 0, evidence: `컴팩트 ${s.compactions}회, 컴팩트 실패 ${s.compactErr}회`,
      fix: s.compactErr ? `제안: 컴팩트 실패 원인 수리(설정된 자동 컴팩트가 원래대로 돌게) — 의도된 동작 복원이라 트레이드오프 없음` : undefined,
      hold: s.compactErr ? undefined : `보류(트레이드오프 있음): 컴팩트 임계를 낮추면 토큰은 줄지만 작업 맥락이 줄어듦`,
    });
  }
  if (s.fbTurns && s.fbFirst !== undefined) {
    const span = (s.fbLast! - s.fbFirst) / 60e3;
    const after = Math.max(0, ...s.fbSegs.map(fallbackAfterCapacity));
    const why = [...new Set(s.fbSegs.flat().flatMap((t) => blockedAt(t).map((e) => e.why)))];
    const ctx = why.length ? `한도 근거: ${why.slice(0, 3).join(", ")}${why.length > 3 ? ` 외 ${why.length - 3}` : ""}` : `한도 소진 근거 없음 (limits ${lim ? `${lim.left}% 남음` : "조회 실패/미조회"})`;
    F.push(after > 60 ? {
      flag: true, kind: "폴백 모델", who, tip: "Claude 복귀 경로 확인", what: `Claude 여유가 생긴 뒤에도 ${Math.round(after)}분 ${[...s.fbModels].join(", ")}에 머묾 (의도 ${s.intended}, 전체 ${s.fbTurns}턴 ${Math.round(span)}분)`,
      amount: `여유 생긴 뒤 ${Math.round(after)}분`, saveCost: 0, evidence: `${kst(s.fbFirst)}~${kst(s.fbLast!)}; ${ctx}`,
      fix: `제안: 한도가 풀리면 원래 모델로 돌아오는 복귀 경로 추가/점검 — 의도한 모델 복원이라 오히려 품질 회복`,
    } : {
      flag: false, kind: "폴백 모델(예상)", who, what: `Claude 한도 소진 중이라 ${[...s.fbModels].join(", ")} 폴백은 예상된 동작 (${s.fbTurns}턴, ${Math.round(span)}분${after > 0 ? `, 여유 생긴 뒤 ${Math.round(after)}분` : ""})`,
      amount: `${Math.round(span)}분`, saveCost: 0, evidence: `${kst(s.fbFirst)}~${kst(s.fbLast!)}; ${ctx}`,
    });
  }
  if (s.maxToolStreak >= 5) {
    F.push({
      flag: true, kind: "반복 호출", who, tip: "폴링 대신 monitor 대기", what: `같은 도구 호출 연속 ${s.maxToolStreak}회${s.loopGuard ? `, loop-guard 경고 ${s.loopGuard}회` : ""}`,
      amount: `~${M(s.loopTokens)} tok, ${$(s.loopCost)}`, saveCost: s.loopCost, evidence: s.maxToolDesc,
      fix: `제안: 같은 호출로 폴링하는 대신 monitor 이벤트로 대기 — 예상 절감 ~${$(s.loopCost)}/일, 결과 동일`,
    });
  } else if (s.loopGuard >= 10) {
    F.push({
      flag: false, kind: "유사 호출", who, what: `loop-guard(거의 같은 호출 반복) 경고 ${s.loopGuard}회, 완전 동일 연속은 최대 ${s.maxToolStreak}회`,
      amount: "-", saveCost: 0, evidence: "인자만 조금씩 바꾼 호출 반복",
      fix: `제안: 오프셋·파일만 바꾸는 호출은 한 번에 넓게(배치) — 같은 결과를 적은 턴으로, 절감액은 측정 불가`,
    });
  }
  if (s.src.child && s.tokens > SUB_NOTE) {
    // estimated saving from splitting the brief in two stages at the midpoint: the 2nd stage starts from the
    // initial prompt + a ~10K handoff instead of re-reading the 1st stage's history on every turn.
    const xs = s.ctxSeries, mid = Math.floor(xs.length / 2), base = xs[0] ?? 0;
    let saveTok = 0;
    for (let i = mid; i < xs.length; i++) saveTok += Math.max(0, Math.min(xs[i], xs[mid]) - base - 10_000);
    const save = saveTok * (s.readRate || 0);
    F.push({
      flag: s.tokens > SUB_FLAG, kind: "대형 하위에이전트", who, tip: "브리프를 단계별 태스크로 분할", what: `${s.src.child.name}: ${M(s.tokens)} tok, ${s.turns}턴, 컴팩트 ${s.compactions}회, 최대 컨텍스트 ${K(s.maxCtx)}${s.src.child.runTotal ? ` (태스크 집계 마지막 실행 ${M(s.src.child.runTotal)})` : ""}`,
      amount: `${$(s.cost)}`, saveCost: save,
      evidence: `"${s.src.child.summary.slice(0, 80)}"; 캐시읽기 ${M(s.cr)}가 대부분${s.src.child.spawner ? `; 스폰: ${s.src.child.spawner}` : ""}; ${K(STEER_BIG)} 넘은 컨텍스트에 후속 지시 ${s.bigSteers}회; senpi 맥락 축소 요청 ${s.reduced}회`,
      fix: `제안: 브리프를 독립 단계(조사→구현→검증)로 나눠 별도 태스크로${s.bigSteers ? ", 후속 리뷰·수정은 task_send 대신 새 단계 태스크로" : ""} — 2단계 분할 기준 예상 절감 ~${M(saveTok)} tok (${$(save)}). 모델·effort·검증은 그대로라 성능 영향 없음`,
    });
  }
}
const total = results.reduce((a, s) => a + s.tokens, 0), totalCost = results.reduce((a, s) => a + s.cost, 0);
const totalCw = results.reduce((a, s) => a + s.cw, 0);
const today = kstDate(now);
type Day = { date: string; tokens: number; cost: number; cacheWrite: number; sessions: number; flags: number };
let hist: Day[] = [];
try { hist = JSON.parse(readFileSync(HISTORY, "utf8")).days ?? []; } catch {}
const prior = hist.filter((d) => d.date !== today).slice(-7);
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0; };
const medTok = median(prior.map((d) => d.tokens)), medCost = median(prior.map((d) => d.cost));
if (prior.length >= 3 && (total > 2 * medTok || totalCost > 2 * medCost)) {
  const top = [...results].sort((a, b) => b.cost - a.cost).slice(0, 3).map((s) => `${s.src.label} ${M(s.tokens)}`).join(", ");
  F.push({ flag: true, kind: "급증", who: "전체", tip: "상위 세션 확인", what: `24h 합계가 7일 중앙값의 ${(total / Math.max(1, medTok)).toFixed(1)}배`, amount: `${M(total)} tok (${$(totalCost)}) vs 중앙값 ${M(medTok)} (${$(medCost)})`, saveCost: 0, evidence: `상위: ${top}` });
}
const flaggedCache = new Map<string, Set<string> | null>();
const flaggedOn = (date: string) => {
  if (!flaggedCache.has(date)) {
    try {
      const t = readFileSync(`${LOG_DIR}/token-audit-${date.replace(/-/g, "")}.md`, "utf8");
      flaggedCache.set(date, new Set([...t.matchAll(/^### (?:🔁)?⚠️ \[([^\]]+)\]/gm)].map((m) => m[1]!)));
    } catch { flaggedCache.set(date, null); }
  }
  return flaggedCache.get(date);
};
for (const f of F) {
  if (!f.flag) continue;
  let days = 0;
  for (let d = 1; d <= 7; d++) if (flaggedOn(kstDate(now - d * 86400e3))?.has(f.kind)) days++;
  if (days) f.recur = days + 1;
}
const flags = F.filter((f) => f.flag);
const recurring = [...new Set(flags.filter((f) => f.recur).map((f) => `${f.kind} 최근 8일 중 ${f.recur}일`))];
hist = [...hist.filter((d) => d.date !== today), { date: today, tokens: total, cost: totalCost, cacheWrite: totalCw, sessions: results.length, flags: flags.length }].slice(-14);
mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(HISTORY, JSON.stringify({ updated: new Date(now).toISOString(), days: hist }, null, 1));
const sorted = [...results].sort((a, b) => b.tokens - a.tokens);
const order = [...F].sort((a, b) => Number(b.flag) - Number(a.flag) || b.saveCost - a.saveCost);
const md = [
  `# 토큰 누수 점검 ${today} (KST)`,
  ``,
  `기간: ${kst(since)} ~ ${kst(now)} KST (${HOURS}h) · 세션 ${results.length}개 · 합계 ${M(total)} tok · ${$(totalCost)} · 캐시쓰기 ${M(totalCw)} · 분석 ${elapsed.toFixed(1)}s${DRY ? " · dry" : ""}`,
  `7일 중앙값: ${prior.length ? `${M(medTok)} tok / ${$(medCost)} (${prior.length}일)` : "기록 없음"}`,
  ``,
  `모든 항목은 보고만 함 — 자동 적용 없음. "제안"은 성능 트레이드오프가 없는 것만, 트레이드오프가 있는 후보는 "보류"로 따로 표시.`,
  ``,
  `## 경고 ${flags.length}건 / 참고 ${F.length - flags.length}건`,
  ...order.flatMap((f) => [
    ``,
    `### ${f.recur ? "🔁" : ""}${f.flag ? "⚠️" : "ℹ️"} [${f.kind}] ${f.who}`,
    `- ${f.what} — ${f.amount}`,
    ...(f.recur ? [`- 🔁 최근 8일 중 ${f.recur}일 경고 · 기존 규칙: ${RULES[f.kind] ?? "없음 → 규칙 신설 필요"} → 규칙이 있는데 재발하면 문구를 더하지 말고, 그 규칙이 일을 스폰하는 세션(레포 AGENTS.md·가드 훅·브리프)에 실리는지부터 점검`] : []),
    ...(f.evidence ? [`- 근거: ${f.evidence}`] : []),
    ...(f.fix ? [`- ${f.fix}`] : []),
    ...(f.hold ? [`- ${f.hold}`] : []),
  ]),
  ``,
  `## 세션별 (토큰 순)`,
  ``,
  `| 세션 | 시작(KST) | 턴 | 토큰 | 비용 | 캐시읽기 | 캐시쓰기 | 출력 | 깨짐 | 설명된 큰 쓰기 | 헛깨움 | 핑 | 에러 | 최대 컨텍스트 | 컴팩트 |`,
  `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ...sorted.map((s) => `| ${s.src.label} | ${s.start ? kst(s.start) : "-"} | ${s.turns} | ${M(s.tokens)} | ${$(s.cost)} | ${M(s.cr)} | ${M(s.cw)} | ${K(s.out)} | ${s.busts.length} | ${Object.entries(s.explained).map(([k, v]) => `${k}×${v}`).join(" ") || "-"}${s.bigNew ? ` 새내용×${s.bigNew}` : ""} | ${Object.values(s.wakes).reduce((a, w) => a + w.n, 0)} | ${s.ping.n} | ${s.errTurns} | ${K(s.maxCtx)} | ${s.compactions} |`),
  ``,
  `## 최근 기록`,
  ``,
  ...hist.map((d) => `- ${d.date}: ${M(d.tokens)} tok, ${$(d.cost)}, 캐시쓰기 ${M(d.cacheWrite)}, 세션 ${d.sessions}, 경고 ${d.flags}`),
  ``,
  `기준: 캐시 깨짐 = 미캐시 입력(캐시쓰기+input) >${K(BUST_CW)} 이면서 캐시읽기가 직전 컨텍스트의 80% 미만, 직전에 컴팩트/모델·thinking 변경/TTL(1h, 5m) 초과 공백 없음. 폴백 = 한도 소진(5시간/주간 ≤1% 남음, 또는 Anthropic 429 후 retry-after까지) 중이면 참고만, Claude 여유가 생긴 뒤 60분 넘게 폴백이면 경고. 헛깨움 = goal-continuation·wake·모니터/셀/터미널 알림만으로 시작된 턴이 도구 호출 없이 출력 ≤${IDLE_OUT} tok으로 끝남. 하위에이전트 >${M(SUB_NOTE)} 참고, >${M(SUB_FLAG)} 경고. 깨짐 원인 분류: 직전 사용량이 창의 50%(${K(REDUCE_GATE)}) 이상이고 요청이 10% 넘게 줄면 senpi 맥락 축소, 컴팩트 20분 안의 projection-pin은 늦은 재핀, environment-context와 UTC 날짜가 바뀌면 날짜 변경. 🔁 = 오늘 경고가 지난 7일 리포트에도 경고로 있었음(기존 규칙 RULES와 대조).`,
].join("\n");
const reportPath = `${LOG_DIR}/token-audit-${today.replace(/-/g, "")}.md`;
writeFileSync(reportPath, md + "\n");
let sent = false;
if (flags.length) {
  const short = (f: Finding) => { const save = f.fix?.match(/예상 절감 (~[^ ]+(?: tok \([^)]+\))?)/)?.[1]; return `• ${f.kind} ${f.who.replace(/^task:/, "").replace(/ \(st_[0-9a-f]+\)$/, "")}: ${f.amount.split(" / ")[0]}${f.tip ? ` → 제안: ${f.tip}${save ? ` (${save})` : ""}` : ""}`; };
  const body = [
    `🔍 토큰 누수 점검 (${kst(since)}~${kst(now)}): 합계 ${M(total)} tok ${$(totalCost)}, 경고 ${flags.length}건`,
    ...(recurring.length ? [`🔁 규칙이 있는데 반복: ${recurring.join(", ")} → 규칙이 스폰하는 세션에 실리는지 점검`] : []),
    ...Object.values(Object.groupBy(flags.sort((a, b) => b.saveCost - a.saveCost), (f) => f.kind)).slice(0, 4).map((g) => g!.length === 1 ? short(g![0]) : `${short(g![0])} 외 ${g!.length - 1}건`),
    `전체 보고서: ${reportPath.replace(HOME, "~")} (자동 적용 없음)`,
  ];
  let text = body.slice(0, 6).join("\n");
  if (text.startsWith("-")) text = "\u200b" + text;
  if (DRY) console.log(`--- (dry) would send to #알림 ${ALERT_CH} ---\n${text}\n---`);
  else {
    const p = Bun.spawn(SEND(text), { cwd: BASE, stdout: "pipe", stderr: "pipe" });
    const rc = await p.exited;
    if (rc !== 0) { console.error(`send failed rc=${rc}: ${await new Response(p.stderr).text()}`); console.log(`RESULT ${JSON.stringify({ flags: flags.length, report: reportPath, sent: false, error: `send rc ${rc}` })}`); process.exit(1); }
    sent = true;
  }
} else if (DRY) console.log("--- (dry) clean, nothing to send ---");
console.log(`sessions=${results.length} tokens=${M(total)} cost=${$(totalCost)} flags=${flags.length} notes=${F.length - flags.length} elapsed=${elapsed.toFixed(1)}s report=${reportPath}`);
console.log(`RESULT ${JSON.stringify({ flags: flags.length, report: reportPath, sent, tokens: total, cost: Number(totalCost.toFixed(2)) })}`);
