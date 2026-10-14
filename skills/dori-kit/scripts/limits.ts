// `limits`: plan usage (read-only, never refreshes a CLI's token) + running agent tasks with their real model and tokens.
// Flags: --json (machine output), --short (narrow, for Discord/mobile), --ansi (force colors, for a Discord ```ansi block), --tasks-only, --no-tasks.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
const { UsageService } = await import(`${cfg.projects.herdr_web_ui}/server/usage.ts`);

const HOME = process.env.HOME!;
const args = new Set(process.argv.slice(2));
const kst = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const left = (iso: string) => {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  return m >= 1440 ? `${Math.floor(m / 1440)}일 ${Math.floor((m % 1440) / 60)}시간` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
};
const bar = (pct: number) => "█".repeat(Math.round(pct / 5)).padEnd(20, "░");
const WIN: Record<string, string> = { session: "5시간", week: "주간", month: "월간" };

const tasks: any[] = [];
let stores: string[] = [];
try { stores = Object.keys(JSON.parse(readFileSync(`${HOME}/.omo/agent/rpc/task-stores.json`, "utf8")).stores ?? {}); } catch {}
for (const store of stores) {
  const dir = join(store, "tasks");
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!f.endsWith(".json") || Date.now() - statSync(p).mtimeMs > 24 * 3600_000) continue;
    try {
      const t = JSON.parse(readFileSync(p, "utf8"));
      if (["running", "queued", "starting"].includes(t.status)) tasks.push(t);
    } catch {}
  }
}

const report: any = args.has("--tasks-only") ? { providers: [] } : await new UsageService().report(true);
if (args.has("--json")) {
  console.log(JSON.stringify({ providers: report.providers, tasks: tasks.map((t) => ({ id: t.task_id, model: t.resolved_model?.display, variant: t.resolved_model?.variant, category: t.category, summary: t.task_summary, started: t.started_at })) }, null, 2));
  process.exit(0);
}
const compact = args.has("--short");
const shortLeft = (iso: string) => left(iso).replace(/일 /, "d").replace(/시간 ?/, "h").replace(/분/, "m");
const color = args.has("--ansi") || process.stdout.isTTY;
const tint = (remain: number) => (remain < 20 ? 31 : remain < 50 ? 33 : 32);
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const gauge = (remain: number, width = 15) => {
  const kept = Math.round((Math.min(100, Math.max(0, remain)) / 100) * (width - 1));
  return paint(tint(remain), "━".repeat(kept) + "╾") + paint(30, "─".repeat(width - 1 - kept));
};
for (const p of report.providers ?? []) {
  console.log(`${p.id}${p.plan ? ` (${p.plan})` : ""}${p.problem ? `  ⚠ ${p.problem.kind ?? p.problem}` : ""}`);
  for (const w of p.windows ?? []) {
    const remain = Math.max(0, 100 - w.used_percent);
    console.log(compact
      ? ` ${gauge(remain)} ${paint(tint(remain), `${String(remain).padStart(3)}% 남음`)} ${WIN[w.kind] ?? w.kind} (${shortLeft(w.resets_at)})`
      : `  ${(WIN[w.kind] ?? w.kind).padEnd(4)} ${bar(w.used_percent)} ${String(w.used_percent).padStart(3)}%  리셋 ${kst(w.resets_at)} (${left(w.resets_at)} 뒤)`);
  }
}
if (!args.has("--no-tasks")) {
  console.log(tasks.length ? `\n실행 중인 에이전트 ${tasks.length}개` : "\n실행 중인 에이전트 없음");
  for (const t of tasks) {
    const m = t.resolved_model ?? {};
    const hot = /fable/i.test(m.model_id ?? "") || /^(max|xhigh)$/i.test(m.variant ?? "") ? " ⚠비쌈" : "";
    const mins = t.started_at ? Math.round((Date.now() - new Date(t.started_at).getTime()) / 60_000) : 0;
    console.log(`  ${t.task_id}  ${m.display ?? t.model}${m.variant ? " " + m.variant : ""}${hot}  ${mins}분째  ${String(t.task_summary ?? t.description ?? "").slice(0, 60)}`);
  }
}
