// budget-gate: run before starting heavy agent work. Exit 0 = go; exit 2 = paused, a question was posted to #알림.
// usage: bun budget-gate.ts "<work>" [--est <percent of the 5h window the work is expected to use>] [--force]
import { cfg } from "./config.ts";
const { UsageService } = await import(`${cfg.projects.herdr_web_ui}/server/usage.ts`);

const CH = cfg.discord.channels.alert;
const argv = process.argv.slice(2);
const work = argv.find((a) => !a.startsWith("--")) ?? "작업";
const estIdx = argv.indexOf("--est");
const est = estIdx >= 0 ? Number(argv[estIdx + 1]) : 15;
if (argv.includes("--force")) process.exit(0);

const r: any = await new UsageService().report(true);
const claude = (r.providers ?? []).find((p: any) => p.id === "claude");
const win = (k: string) => (claude?.windows ?? []).find((w: any) => w.kind === k);
const s = win("session"), w = win("week");
if (!s || !w) process.exit(0);
const sLeft = 100 - s.used_percent, wLeft = 100 - w.used_percent;
const tight = sLeft - est < 10;
if (!tight) { console.log(`go: 5h ${sLeft}% left, week ${wLeft}% left, est ${est}%`); process.exit(0); }

const until = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const why = `5시간 한도가 ${sLeft}% 남았는데 이 작업이 ~${est}% 쓸 것 같아요`;
const text = `\u200b⏸️ 멈춰두고 물어봐요: **${work}**\n${why}\n5시간 ${sLeft}% 남음 (리셋 ${until(s.resets_at)}) · 주간 ${wLeft}% 남음 (리셋 ${until(w.resets_at)})\n→ "지금 해" / "리셋 후" (${until(s.resets_at)}) / "줄여서 해" 중 답 주세요`;
const p = Bun.spawn([`${process.env.HOME}/.bun/bin/agent-discordbot`, "message", "send", CH, text], { stdout: "pipe", stderr: "pipe" });
const rc = await p.exited;
if (rc !== 0) console.error("send failed", await new Response(p.stderr).text());
console.log(`paused: ${why}`);
process.exit(2);
