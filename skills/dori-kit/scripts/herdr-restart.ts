// Restart the herdr server on its new binary, then bring every omo tab back:
// project tabs resume the same session (--session), the bot (cfg.agent_cwd) starts a fresh session with the nightly prompt.
// Must run outside herdr (launchd).
// Flags: --dry (plan only), --nightly (called by nightly.ts: print RESULT line, no Discord post), --omo-update (bun add -g omo-ai@latest while every tab is down)
import { $ } from "bun";
import { dc2 } from "./dc2.ts";
import { cfg, LAYER_DIR } from "./config.ts";
import { omoProcs, sessionFile, sessionIdOf, killTree } from "./omo-proc.ts";

const HOME = process.env.HOME!;
const BOT_CWD = cfg.agent_cwd;
const HERDR = `${HOME}/.local/bin/herdr`;
const SNAP_FILE = `${LAYER_DIR}/herdr-restart.json`;
const WORKLOG_CHANNEL = cfg.discord.channels.worklog;
const ALERT_CHANNEL = cfg.discord.channels.alert;
const DOCTOR_PLIST = `${HOME}/Library/LaunchAgents/dev.${cfg.layer}.doctor.plist`;
const BOT_CMD = "PI_CACHE_RETENTION=long omo --model anthropic/claude-opus-5-5 --thinking medium";
const DRY = process.argv.includes("--dry");
const NIGHTLY = process.argv.includes("--nightly");
const OMO_UPDATE = process.argv.includes("--omo-update");

process.env.PATH = `${HOME}/.bun/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
for (const k of Object.keys(process.env)) if (k.startsWith("HERDR_")) delete process.env[k];
process.env.HERDR_SOCKET_PATH = `${HOME}/.config/herdr/herdr.sock`;

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${DRY ? "(dry) " : ""}${m}`);
const sleep = (ms: number) => Bun.sleep(ms);
const kst = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(5, 16);
const resting = (s?: string) => s === "idle" || s === "done";
const botPrompt = (prev?: string) =>
  `[야간 정리] 새 세션으로 재시작했어(herdr 서버도 새 버전으로 재시작). 저번 세션처럼 ${cfg.identity.name} 모드 해줘: ${LAYER_DIR}/MODE.md와 state.json(open_tasks 포함) 읽고 Discord inbox·herdr·zele 등 모니터를 다시 걸어. 어제 대화가 필요하면 이전 세션 파일 ${prev ?? "(없음)"} 끝부분만 참고. 재시작 사이에 inbox.jsonl에 새로 온 메시지 있으면 처리하고, 끝나면 #📋┃작업로그(${WORKLOG_CHANNEL})에 한 줄로 보고.`;

async function herdr(...a: string[]): Promise<any> {
  const r = await $`${HERDR} ${a}`.nothrow().quiet();
  if (r.exitCode !== 0) throw new Error(`herdr ${a.slice(0, 2).join(" ")} 실패: ${(r.stderr.toString() || r.stdout.toString()).trim().slice(0, 200)}`);
  const out = r.stdout.toString();
  try { return JSON.parse(out).result; } catch { return out; }
}
const paneList = async (): Promise<any[]> => (await herdr("pane", "list")).panes;
const getPane = async (id: string): Promise<any> => (await herdr("pane", "get", id)).pane;
const cwdOf = (p: any): string => p.foreground_cwd ?? p.cwd;
const omoIn = async (cwd: string) => (await omoProcs()).find((x) => x.cwd === cwd);

async function send(id: string, text: string) {
  await herdr("pane", "send-text", id, text);
  await sleep(600);
  await herdr("pane", "send-keys", id, "Enter");
}

async function waitFor(what: string, timeoutMs: number, ok: () => Promise<boolean>) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return;
    await sleep(2000);
  }
  throw new Error(`${what} 대기 시간 초과`);
}

async function serverStatus(): Promise<{ running: boolean; version?: string; stale: boolean }> {
  const t = (await $`${HERDR} status`.nothrow().quiet()).stdout.toString();
  const server = t.split(/\n(?=server:)/)[1] ?? "";
  return {
    running: /status:\s*running/.test(server),
    version: server.match(/version:\s*(\S+)/)?.[1],
    stale: /server_binary_stale:\s*yes|restart_needed:\s*yes/.test(t),
  };
}

async function report(msg: string, alert: boolean) {
  log(msg);
  if (NIGHTLY) { console.log(`RESULT ${alert ? "⚠️ " : ""}${msg}`); return; }
  if (!DRY) await dc2.sendMessage(alert ? ALERT_CHANNEL : WORKLOG_CHANNEL, msg);
}

type Entry = { label: string; cwd: string; pane: string; pid?: number; session?: string; bot: boolean };

async function main() {
  const uid = (await $`id -u`.quiet().text()).trim();
  const tabs: Record<string, string> = Object.fromEntries((await herdr("tab", "list")).tabs.map((t: any) => [t.tab_id, t.label]));
  const procs = await omoProcs();
  // The bot's pane is not detected as an agent by herdr, so omo panes are matched by process cwd too.
  const omoPanes = (await paneList()).filter((p) => p.agent || procs.some((x) => x.cwd === cwdOf(p)));
  if (!DRY) {
    await waitFor("탭 작업 종료", 20 * 60_000, async () => {
      const ps = (await paneList()).filter((p) => p.agent);
      const busy = ps.filter((p) => !resting(p.agent_status));
      if (busy.some((p) => p.agent_status === "blocked")) throw new Error(`승인 대기 탭 있음: ${busy.map((p) => tabs[p.tab_id]).join(",")}`);
      return busy.length === 0;
    });
  }
  const entries: Entry[] = omoPanes.map((p) => {
    const cwd = cwdOf(p);
    const proc = procs.find((x) => x.cwd === cwd);
    const file = sessionFile(cwd, proc?.sessionArg);
    return { label: tabs[p.tab_id] ?? p.tab_id, cwd, pane: p.pane_id, pid: proc?.pid, session: file ? sessionIdOf(file) : undefined, bot: cwd === BOT_CWD };
  });
  const prevBotSession = entries.some((e) => e.bot) ? sessionFile(BOT_CWD) : undefined;
  await Bun.write(SNAP_FILE, JSON.stringify({ at: new Date().toISOString(), entries, prevBotSession }, null, 2));
  log(`스냅샷: ${entries.map((e) => `${e.label}(${e.pane}, ${e.session ?? "세션 없음"})`).join(" · ")}`);
  if (DRY) { log(`서버 ${JSON.stringify(await serverStatus())}`); return; }

  // Keep session-doctor from relaunching tabs while they are down on purpose.
  await $`launchctl bootout gui/${uid}/dev.${cfg.layer}.doctor`.nothrow().quiet();
  try {
    for (const e of entries) await send(e.pane, "/quit").catch(() => {});
    for (const e of entries) {
      try { await waitFor(`${e.label} 종료`, 60_000, async () => !(await omoIn(e.cwd))); }
      catch { if (e.pid) await killTree(e.pid); }
    }
    log("omo 탭 모두 종료");

    let omoNote = "";
    if (OMO_UPDATE) {
      const r = await $`bun add -g omo-ai@latest`.nothrow().quiet();
      omoNote = r.exitCode === 0 ? "omo 업데이트 완료" : `⚠️ omo 업데이트 실패: ${r.stderr.toString().slice(-160)}`;
      log(omoNote);
    }

    const before = (await serverStatus()).version;
    const up = await $`${HERDR} update`.nothrow().quiet();
    log(`herdr update: ${(up.stdout.toString() + up.stderr.toString()).trim().split("\n").slice(-2).join(" / ")}`);
    await $`${HERDR} server stop`.nothrow().quiet();
    await waitFor("herdr 서버 종료", 30_000, async () => !(await serverStatus()).running);
    const srv = Bun.spawn([HERDR, "server"], { cwd: HOME, stdio: ["ignore", "ignore", "ignore"], env: process.env });
    srv.unref();
    await waitFor("herdr 서버 시작", 30_000, async () => (await serverStatus()).running);
    const after = (await serverStatus()).version;
    log(`herdr 서버 ${before} → ${after}`);
    await sleep(8000);

    const results: string[] = [];
    for (const e of [...entries.filter((x) => !x.bot), ...entries.filter((x) => x.bot)]) {
      try {
        let pane = (await paneList()).find((p) => cwdOf(p) === e.cwd);
        if (!pane) {
          const ws = (await herdr("workspace", "list")).workspaces?.[0]?.workspace_id ?? "w1";
          await herdr("tab", "create", "--workspace", ws, "--cwd", e.cwd, "--label", e.label, "--no-focus");
          pane = (await paneList()).find((p) => cwdOf(p) === e.cwd);
        }
        const id = pane!.pane_id;
        if (await omoIn(e.cwd)) {
          await send(id, "/quit");
          await waitFor(`${e.label} 복원 에이전트 종료`, 60_000, async () => !(await omoIn(e.cwd)));
        }
        await send(id, e.bot ? BOT_CMD : e.session ? `omo --session ${e.session}` : "omo --model anthropic/claude-opus-5-5 --thinking medium");
        await waitFor(`${e.label} omo 시작`, 120_000, async () => !!(await omoIn(e.cwd)));
        if (e.bot) {
          await sleep(25_000);
          await send(id, botPrompt(prevBotSession));
        }
        results.push(`${e.label} ✅${e.bot || !e.session ? "(새 세션)" : "(같은 세션)"}`);
      } catch (err) {
        results.push(`${e.label} ⚠️ ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await $`launchctl kickstart -k gui/${uid}/dev.${cfg.layer}.herdr`.nothrow().quiet();
    const bad = results.some((r) => r.includes("⚠️")) || after === before;
    await report(`🔄 herdr 재시작 ${kst()} · 서버 ${before}→${after}${omoNote ? ` · ${omoNote}` : ""} · ${results.join(" · ")} · 형 터미널은 herdr 다시 실행하면 붙어요`, bad);
  } finally {
    await $`launchctl bootstrap gui/${uid} ${DOCTOR_PLIST}`.nothrow().quiet();
    log("session-doctor 다시 켬");
  }
}

try {
  await main();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  await report(`🔄 herdr 재시작 ${kst()} · ⚠️ 실패: ${msg}`, true);
  process.exitCode = 1;
}
