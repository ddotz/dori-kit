// Nightly bot maintenance, run by launchd dev.<layer>.nightly at 04:30. No LLM calls.
import { dc2 } from "./dc2.ts";
import { cfg, LAYER_DIR } from "./config.ts";
import { omoProcs, sessionFile, sessionIdOf } from "./omo-proc.ts";

const CWD = cfg.agent_cwd;
const SESSION_FILE = sessionFile(CWD, (await omoProcs()).find((p) => p.cwd === CWD)?.sessionArg)!;
const SESSION_ID = sessionIdOf(SESSION_FILE)!;
const WORKLOG_CHANNEL = cfg.discord.channels.worklog;
const ALERT_CHANNEL = cfg.discord.channels.alert;
const IDLE_MIN = 5;
const DRY = process.argv.includes("--dry");
const NAME = cfg.identity.name;
// Optional per-user nightly steps: config.json "nightly_hooks": [{ "label": "...", "cmd": "~/path/to/script.sh" }].
const HOOKS = (cfg as { nightly_hooks?: { label: string; cmd: string }[] }).nightly_hooks ?? [];
const AUDIT_ONLY = process.argv.includes("--audit-only");
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => Bun.sleep(ms);

async function pane(): Promise<string> {
  const j = JSON.parse(await Bun.$`herdr pane list`.text());
  const p = j.result.panes.find((x: any) => x.cwd === CWD || x.foreground_cwd === CWD);
  if (!p) throw new Error(`no herdr pane with cwd ${CWD}`);
  return p.pane_id;
}
async function send(id: string, text: string) {
  await Bun.$`herdr pane send-text ${id} ${text}`.quiet();
  await sleep(600);
  await Bun.$`herdr pane send-keys ${id} Enter`.quiet();
}
const mtime = async () => (await Bun.file(SESSION_FILE).stat()).mtimeMs;
const compactions = async () => ((await Bun.file(SESSION_FILE).text()).match(/"type":"compaction"/g) ?? []).length;
async function running() {
  return (await omoProcs()).some((p) => p.cwd === CWD);
}
async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, stepMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return true; await sleep(stepMs); }
  return false;
}

const TAB_COMPACT_PCT = 60;
// Compaction never shrinks the session file; past this size an idle project tab gets a fresh session + handover
// instead (user 2026-10-14; a project tab hung on a 168MB session).
const TAB_ROTATE_BYTES = 50e6;

async function compactIdleTabs(myPane: string): Promise<string[]> {
  const out: string[] = [];
  const j = JSON.parse(await Bun.$`herdr pane list`.text());
  for (const p of j.result.panes) {
    if (p.pane_id === myPane || p.agent !== "pi") continue;
    const name = `${p.cwd.split("/").pop()}(${p.pane_id})`;
    if (!["idle", "done"].includes(p.agent_status)) {
      out.push(`${name} 작업 중이라 건너뜀`);
      continue;
    }
    const proc = (await omoProcs()).find((x) => x.cwd === p.cwd);
    const file = proc && sessionFile(p.cwd, proc.sessionArg);
    const size = file ? Bun.file(file).size : 0;
    if (size > TAB_ROTATE_BYTES) {
      const r = await Bun.$`bun ${LAYER_DIR}/session-doctor.ts --rotate ${p.cwd} ${DRY ? "--dry" : ""}`.quiet().nothrow();
      out.push(`${name} 세션 ${Math.round(size / 1e6)}MB → ${r.exitCode === 0 ? "새 세션+인수인계" : "⚠️ 새 세션 교체 실패"}${DRY ? " (dry)" : ""}`);
      continue;
    }
    const screen = await Bun.$`herdr pane read ${p.pane_id} --lines 6`.quiet().nothrow().text();
    const pct = Number(screen.match(/\(([\d.]+)%\)\s*\(auto\)/)?.[1] ?? NaN);
    if (!(pct >= TAB_COMPACT_PCT)) {
      out.push(`${name} ${Number.isNaN(pct) ? "?" : pct}%`);
      continue;
    }
    if (!DRY) await send(p.pane_id, "/compact");
    out.push(`${name} ${pct}% → 컴팩트${DRY ? " (dry)" : ""}`);
  }
  return out;
}

// Token-leak audit (token-audit.ts, pure TS): full report in logs/, posts to #알림 itself only when something is flagged.
async function tokenAudit(): Promise<string> {
  const p = Bun.spawn(["bun", `${LAYER_DIR}/token-audit.ts`, ...(DRY ? ["--dry"] : [])], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), 120e3);
  const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (DRY) process.stdout.write(out);
  const res = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (rc !== 0 || !res) return `⚠️ 토큰 점검 실패 (exit ${rc}): ${(err || out).trim().slice(-160)}`;
  const r = JSON.parse(res.slice(7));
  return r.flags ? `토큰 점검: 경고 ${r.flags}건 → #알림${r.sent ? "" : " (미발송)"}` : `토큰 점검: 이상 없음 (${(r.tokens / 1e6).toFixed(0)}M tok)`;
}
if (AUDIT_ONLY) {
  log(await tokenAudit());
  process.exit(0);
}

const report: string[] = [];
try {
  const id = await pane();
  const idle = DRY || await waitFor(async () => Date.now() - (await mtime()) > IDLE_MIN * 60e3, 90 * 60e3, 30e3);
  if (!idle) throw new Error(`${NAME}이(가) 90분 동안 계속 작업 중이라 건너뜀`);
  log(`idle, pane ${id}`);
  report.push(await tokenAudit().catch((e) => `⚠️ 토큰 점검 실패: ${String(e).slice(0, 120)}`));
  const tabs = await compactIdleTabs(id).catch((e) => [`⚠️ 탭 점검 실패: ${String(e).slice(0, 120)}`]);
  if (tabs.length) report.push(`작업 탭: ${tabs.join(", ")}`);

  for (const h of HOOKS) {
    const r = await Bun.$`${h.cmd}`.quiet().nothrow();
    report.push(r.exitCode === 0 ? `${h.label}: ${r.stdout.toString().trim().split("\n").pop()}` : `⚠️ ${h.label} 실패: ${r.stderr.toString().slice(-160)}`);
  }

  // No /compact: we start a fresh session below, so compacting the old one is wasted work.

  const cur = (await Bun.$`omo --version`.text()).match(/omo (\S+)/)?.[1] ?? "?";
  const latest = (await (await fetch("https://registry.npmjs.org/omo-ai/latest")).json()).version as string;
  let now = cur;

  // herdr: install any update, and when the running server is older than the binary, restart it with every tab
  // (user 2026-10-02: "야간정리때. herdr도 업데이트가 있으면 반영하는걸로 하자").
  const hu = await Bun.$`herdr update`.quiet().nothrow();
  const hst = await Bun.$`herdr status`.quiet().nothrow().text();
  const herdrStale = /server_binary_stale:\s*yes|restart_needed:\s*yes/.test(hst);
  report.push(`herdr ${(hu.stdout.toString() + hu.stderr.toString()).trim().split("\n").pop()}${herdrStale ? " · 서버 재시작 필요" : ""}`);
  if (herdrStale && !DRY) {
    const omoFlag = latest && latest !== cur ? ["--omo-update"] : [];
    const r = await Bun.$`bun ${LAYER_DIR}/herdr-restart.ts --nightly ${omoFlag}`.quiet().nothrow();
    const line = r.stdout.toString().split("\n").find((l) => l.startsWith("RESULT "))?.slice(7) ?? `herdr-restart exit ${r.exitCode}`;
    if (r.exitCode === 0) {
      if (omoFlag.length) report.push(`omo ${cur} → ${(await Bun.$`omo --version`.text()).match(/omo (\S+)/)?.[1] ?? "?"}`);
      report.push(line);
      log(report.join(" | "));
      await dc2.sendMessage(line.includes("⚠️") ? ALERT_CHANNEL : WORKLOG_CHANNEL, `🌙 야간 정리\n- ${report.join("\n- ")}`);
      process.exit(0);
    }
    report.push(`⚠️ herdr 서버 재시작 못 함, ${NAME}만 재시작: ${line}`);
  }
  if (latest && latest !== cur) {
    if (!DRY) {
      // Quit before updating so bun doesn't swap files under a running process.
      await send(id, "/quit");
      if (!(await waitFor(async () => !(await running()), 60e3, 2000))) throw new Error(`${NAME} 종료 안 됨`);
      const r = await Bun.$`bun add -g omo-ai@latest`.quiet().nothrow();
      if (r.exitCode !== 0) report.push(`⚠️ omo 업데이트 실패: ${r.stderr.toString().slice(-200)}`);
      now = (await Bun.$`omo --version`.text()).match(/omo (\S+)/)?.[1] ?? "?";
    }
    report.push(`omo ${cur} → ${now}`);
  } else report.push(`omo ${cur} (최신)`);

  if (!DRY) {
    const id = await pane();
    if (await running()) {
      await send(id, "/quit");
      if (!(await waitFor(async () => !(await running()), 60e3, 2000))) throw new Error(`${NAME} 종료 안 됨`);
    }
    await sleep(1500);
    // Fresh session every night: a days-long resumed session grew to 43MB / 1.1GB RSS and hung while idle.
    // Pin the bot default (user 2026-10-01: Opus medium); per-model levels in settings.json can drift when other tabs pick high.
    await send(id, `PI_CACHE_RETENTION=long omo --model anthropic/claude-opus-5-5 --thinking medium`);
    if (!(await waitFor(running, 60e3, 2000))) throw new Error(`${NAME} 재시작 안 됨`);
    await sleep(25e3);
    await send(id, `[야간 정리] 새 세션으로 재시작했어. 저번 세션처럼 ${NAME} 모드 해줘: ${LAYER_DIR}/MODE.md와 state.json(open_tasks 포함) 읽고 Discord inbox·herdr·zele 등 모니터를 다시 걸어. 어제 대화가 필요하면 이전 세션 파일 ${SESSION_FILE} 끝부분만 참고. 재시작 사이에 inbox.jsonl에 새로 온 메시지 있으면 처리하고, 끝나면 #📋┃작업로그(${WORKLOG_CHANNEL})에 한 줄로 보고.`);
    report.push("새 세션으로 재시작 + 모니터 재등록 요청");
  }
  const kb = Math.round((await Bun.file(SESSION_FILE).stat()).size / 1024);
  log(report.join(" | "));
  if (!DRY) await dc2.sendMessage(WORKLOG_CHANNEL, `🌙 야간 정리\n- ${report.join("\n- ")}\n- 세션 파일 ${kb}KB`);
} catch (e) {
  const msg = `🌙 야간 정리 실패: ${(e as Error).message}\n${report.length ? "- " + report.join("\n- ") : ""}`;
  log(msg);
  if (!DRY) await dc2.sendMessage(ALERT_CHANNEL, msg);
  process.exit(1);
}
