#!/usr/bin/env bun
// Session keeper: keeps browser logins alive with one adapter per site and one common runner.
// Adapter = check() (logged in?), touch() (cheap request that extends the session), relogin() (stored credentials in the
// hidden automation window from aside-window.ts, verify, close its tab). The runner does scheduling-time policy only:
//   - one run at a time (lock file),
//   - 2 consecutive failures -> one alert per site per 12h, 3 -> no relogin attempts for that site for 6h (account lockout guard),
//   - sites with a second factor never relogin without the owner's approval (secondFactor.approved()),
//   - one status line per site (statusLines()) for a nightly report.
// Browser rules for adapters: tabs only in the automation window (replInTab), no OS keystrokes, never activate/raise Aside,
// secrets never inside repl code (oneShotSecret serves them once from a random localhost URL; aside repl fs is sandboxed).
// Shared (no personal values). CLI reads config.json next to this file: "session_keeper": { "adapters": "<module path>" }; the
// module exports `adapters: Adapter[]` and optionally `alert(adapter, state, note)`.
//   bun session-keeper.ts [--dry] [--only a,b] [--force-relogin]   run (dry: checks only, no touch/relogin/state/alerts)
//   bun session-keeper.ts --status                                   print the status lines (last line = one-line summary)
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ASIDE, openInAutomationWindow, runCmd } from "./aside-window.ts";

export type Check = { ok: boolean; out?: boolean; note: string; data?: Record<string, unknown> };
export type SiteState = { status?: "ok" | "failed"; note?: string; lastCheck?: string; lastOk?: string; lastRelogin?: string; fails: number; lastAlert?: string; pausedUntil?: string; [k: string]: unknown };
export type KeeperState = { sites: Record<string, SiteState>; [k: string]: unknown };
export type Ctx = { dry: boolean; force: boolean; log: (m: string) => void; st: SiteState; state: KeeperState };
export type Adapter = {
  name: string;
  label?: string;
  check(ctx: Ctx): Promise<Check>;
  // Called after a good check (not in dry runs). Return a note when it did something, null when not due; throw = session lost.
  touch?(ctx: Ctx, c: Check): Promise<string | null>;
  relogin?(ctx: Ctx): Promise<string>;
  verify?(ctx: Ctx): Promise<Check>; // default: check()
  onOk?(ctx: Ctx, c: Check): void | Promise<void>; // persist data from a good check/verify (not in dry runs)
  forceRelogin?: boolean; // false: --force-relogin does not apply (e.g. token sites)
  secondFactor?: { approved(ctx: Ctx): Promise<boolean>; requestApproval?(ctx: Ctx): Promise<void> };
  alerts?: boolean; // false: the site's own flow already alerts
};
export type Policy = { alertAfter: number; alertEveryMs: number; pauseAfter: number; pauseMs: number };
const H = 3600e3;
export const DEFAULT_POLICY: Policy = { alertAfter: 2, alertEveryMs: 12 * H, pauseAfter: 3, pauseMs: 6 * H };
export type KeeperOpts = {
  adapters: Adapter[];
  stateFile: string;
  lockFile: string;
  logFile?: string;
  dry?: boolean;
  force?: boolean;
  only?: string[];
  policy?: Partial<Policy>;
  alert?: (a: Adapter, st: SiteState, note: string) => Promise<void>;
};
export type SiteResult = { name: string; ok: boolean; note: string };

const hhmm = (ms: number) => new Date(ms).toLocaleString("sv-SE").slice(5, 16);
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

// One run at a time: pid lock, stale after 20 min or when the holder is gone; waits up to 8 min.
async function lock(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < 160; i++) {
    let holder = 0;
    try { holder = Number(readFileSync(file, "utf8")); } catch {}
    let alive = false;
    if (holder && holder !== process.pid) { try { process.kill(holder, 0); alive = true; } catch {} }
    if (!alive || Date.now() - statSync(file).mtimeMs > 20 * 60e3) { writeFileSync(file, String(process.pid)); return; }
    await Bun.sleep(3000);
  }
  throw new Error(`another session keeper run holds ${file} for over 8 min`);
}

export function loadState(file: string): KeeperState {
  const s: KeeperState = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { sites: {} };
  s.sites ??= {};
  return s;
}

export async function runKeeper(o: KeeperOpts): Promise<{ allOk: boolean; results: SiteResult[] }> {
  const P = { ...DEFAULT_POLICY, ...o.policy };
  const dry = !!o.dry, force = !!o.force;
  if (o.logFile) mkdirSync(dirname(o.logFile), { recursive: true });
  const log = (m: string) => {
    const line = `${new Date().toISOString()} ${dry ? "[dry] " : ""}${m}`;
    console.log(line);
    if (o.logFile) appendFileSync(o.logFile, line + "\n");
  };
  await lock(o.lockFile);
  const state = loadState(o.stateFile);
  const results: SiteResult[] = [];
  try {
    for (const a of o.adapters.filter((x) => !o.only?.length || o.only.includes(x.name))) {
      const st = (state.sites[a.name] ??= { fails: 0 });
      const ctx: Ctx = { dry, force, log, st, state };
      const ok = await handle(a, ctx, P, o).catch((e) => { log(`${a.name} runner_error ${msg(e)}`); return { ok: false, note: `runner error: ${msg(e)}` }; });
      results.push({ name: a.name, ...ok });
    }
  } finally {
    if (!dry) {
      writeFileSync(o.stateFile + ".tmp", JSON.stringify(state, null, 1));
      renameSync(o.stateFile + ".tmp", o.stateFile);
    }
    rmSync(o.lockFile, { force: true });
  }
  return { allOk: results.every((r) => r.ok), results };
}

async function handle(a: Adapter, ctx: Ctx, P: Policy, o: KeeperOpts): Promise<{ ok: boolean; note: string }> {
  const { dry, force, log, st } = ctx;
  const now = Date.now();
  let c: Check;
  try { c = await a.check(ctx); } catch (e) { c = { ok: false, note: `check error: ${msg(e)}` }; }
  log(`${a.name} check ${c.ok ? "ok" : c.out ? "logged_out" : "error"} ${c.note}`);
  let ok = c.ok, note = c.note;
  if (ok && !dry) await a.onOk?.(ctx, c);
  if (ok && !dry && a.touch) {
    try {
      const t = await a.touch(ctx, c);
      if (t) { note = t; log(`${a.name} touch ${t}`); }
    } catch (e) { ok = false; c.out = true; note = msg(e); log(`${a.name} touch_failed ${note}`); }
  }
  const paused = !!st.pausedUntil && Date.parse(st.pausedUntil) > now;
  const wantRelogin = (!ok && c.out) || (force && a.forceRelogin !== false);
  if (wantRelogin && !dry && a.relogin) {
    if (paused && !force) {
      note = `${note} (relogin paused until ${hhmm(Date.parse(st.pausedUntil!))})`;
      log(`${a.name} relogin_paused until ${st.pausedUntil}`);
    } else if (a.secondFactor && !(await a.secondFactor.approved(ctx).catch(() => false))) {
      note = `${note} (relogin waits for the owner's approval)`;
      log(`${a.name} relogin_needs_approval`);
      await a.secondFactor.requestApproval?.(ctx).catch((e) => log(`${a.name} approval_request_failed ${msg(e)}`));
    } else {
      try { log(`${a.name} relogin ${await a.relogin(ctx)}`); } catch (e) { log(`${a.name} relogin_failed ${msg(e)}`); }
      let v: Check;
      try { v = await (a.verify ?? a.check)(ctx); } catch (e) { v = { ok: false, note: `verify error: ${msg(e)}` }; }
      log(`${a.name} verify ${v.ok ? "ok" : "fail"} ${v.note}`);
      note = v.ok ? `relogin ok · ${v.note}` : v.note;
      if (v.ok) { ok = true; st.lastRelogin = new Date().toISOString(); await a.onOk?.(ctx, v); }
    }
  }
  if (dry) return { ok, note };
  st.lastCheck = new Date().toISOString();
  st.note = note;
  if (ok) {
    Object.assign(st, { status: "ok", fails: 0, lastOk: st.lastCheck, pausedUntil: undefined });
    return { ok, note };
  }
  st.status = "failed";
  st.fails = (st.fails ?? 0) + 1;
  if (st.fails >= P.pauseAfter && !paused && a.relogin) {
    st.pausedUntil = new Date(now + P.pauseMs).toISOString();
    log(`${a.name} paused ${P.pauseMs / H}h after ${st.fails} failures`);
  }
  if (st.fails >= P.alertAfter && a.alerts !== false && (!st.lastAlert || now - Date.parse(st.lastAlert) > P.alertEveryMs)) {
    st.lastAlert = new Date().toISOString();
    if (o.alert) await o.alert(a, st, note).then(() => log(`${a.name} alert sent`), (e) => log(`${a.name} alert_failed ${msg(e)}`));
    else log(`${a.name} alert (no alert hook) ${note}`);
  }
  return { ok, note };
}

export function statusLines(stateFile: string, adapters?: Adapter[]): string[] {
  const s = loadState(stateFile);
  const names = adapters?.map((a) => a.name) ?? Object.keys(s.sites);
  return names.map((n) => {
    const st = s.sites[n];
    const label = adapters?.find((a) => a.name === n)?.label ?? n;
    if (!st?.lastCheck) return `${label}: no run yet`;
    const paused = st.pausedUntil && Date.parse(st.pausedUntil) > Date.now() ? `, relogin paused until ${hhmm(Date.parse(st.pausedUntil))}` : "";
    return `${label}: ${st.status ?? "?"}${st.fails ? ` (${st.fails} fails${paused})` : ""} at ${hhmm(Date.parse(st.lastCheck))} · ${(st.note ?? "").slice(0, 100)}`;
  });
}

// Serves `value` once from a random-token localhost URL so a secret never appears in repl code or argv. stop() when done.
export function oneShotSecret(value: string): { url: string; stop: () => void } {
  const token = crypto.randomUUID();
  let served = false;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
    if (served || new URL(req.url).pathname !== `/${token}`) return new Response("", { status: 404 });
    served = true;
    return new Response(value);
  } });
  return { url: `http://127.0.0.1:${srv.port}/${token}`, stop: () => srv.stop(true) };
}

export type ReplOpts = { timeoutMs?: number; prelude?: string; secret?: string };
// Runs `body` (an async function body; `return` gives the result) in `aside repl`. With `url`, a tab is opened in the automation
// window first and bound to `pg`; it is closed afterwards whatever happens. With `secret`, the body sees `const secret` (fetched
// once from a localhost URL, never written into the code).
export async function replInTab(url: string | null, body: string, o: ReplOpts = {}): Promise<any> {
  const tab = url ? await openInAutomationWindow(url) : null;
  const sec = o.secret ? oneShotSecret(o.secret) : null;
  try {
    const code = `try { const ksOut = await (async () => { ${o.prelude ?? ""}
${sec ? `const secret = await (await fetch(${JSON.stringify(sec.url)})).text();` : ""}
${tab ? tab.attach("pg") : ""}
${body}
})(); console.log("RESULT " + JSON.stringify({ data: ksOut ?? null })); } catch (e) { console.log("RESULT " + JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) })); }`;
    const r = await runCmd([ASIDE, "repl", code], o.timeoutMs ?? 118e3);
    const m = [...r.out.matchAll(/^.*?RESULT (\{.*\})\s*$/gm)].at(-1);
    if (!m) throw new Error(`aside repl${r.timedOut ? " timed out" : " failed"}: ${(r.out + r.err).replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").slice(-200)}`);
    const j = JSON.parse(m[1]);
    if (j.error) throw new Error(j.error);
    return j.data;
  } finally {
    sec?.stop();
    if (tab) await tab.close().catch(() => {});
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const DIR = import.meta.dir;
  const cfgFile = `${DIR}/config.json`;
  const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")).session_keeper ?? {} : {};
  const home = (p: string) => (p.startsWith("~/") ? `${process.env.HOME}${p.slice(1)}` : p);
  if (!cfg.adapters) {
    console.error(`session-keeper: set "session_keeper": { "adapters": "<module>" } in ${cfgFile}`);
    process.exit(2);
  }
  const mod = await import(home(cfg.adapters));
  const adapters: Adapter[] = mod.adapters;
  const stateFile = home(cfg.state ?? `${DIR}/session-keeper.json`);
  if (args.includes("--status")) {
    const lines = statusLines(stateFile, adapters);
    for (const l of lines) console.log(l);
    console.log(`sessions: ${lines.join(" | ")}`);
    process.exit(0);
  }
  const only = args.includes("--only") ? (args[args.indexOf("--only") + 1] ?? "").split(",").filter(Boolean) : [];
  const r = await runKeeper({
    adapters, stateFile, lockFile: home(cfg.lock ?? `${DIR}/session-keeper.lock`), logFile: home(cfg.log ?? `${DIR}/session-keeper.log`),
    dry: args.includes("--dry"), force: args.includes("--force-relogin"), only, policy: cfg.policy, alert: mod.alert,
  });
  process.exit(r.allOk ? 0 : 1);
}
