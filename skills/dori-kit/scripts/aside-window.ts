import { basename, dirname } from "node:path";
// One dedicated, minimized Aside window for all automations (owner 2026-10-14: "별도 창을 띄우고 거기에서 처리하면서 해당 창
// 숨기기... 그 창만 사용하는걸로"). The user works in Aside himself, so nothing here may activate Aside, raise or unminimize a
// window, send OS keystrokes, or touch any window other than this one. Its AppleScript window id equals the `windowId` that
// `listBrowserTabs()` reports in `aside repl`, so repl code can pick tabs from this window only.
// The window keeps an about:blank anchor tab: closing the last work tab would otherwise close the window itself.
// Shared (no personal values): state lives next to this file in aside-window.json; the window name is the "name" stored there,
// else "<layer>-automation" from this directory (~/.<layer> -> <layer>).
const DIR = import.meta.dir;
const STORE = `${DIR}/aside-window.json`;
const LAYER = basename(DIR) === "scripts" ? basename(dirname(DIR)) : basename(DIR);
const ANCHOR = "about:blank";
const OSA_MS = 15e3;
export const ASIDE = Bun.which("aside") ?? `${process.env.HOME}/.local/bin/aside`;

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Spawn with a hard kill: a hung "aside repl"/osascript must never stall a caller's loop.
export async function runCmd(argv: string[], timeoutMs: number): Promise<{ out: string; err: string; timedOut: boolean }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, timeoutMs);
  let out = "";
  let err = "";
  const reading = Promise.all([new Response(proc.stdout).text().then((t) => (out = t)), new Response(proc.stderr).text().then((t) => (err = t))]);
  await proc.exited;
  clearTimeout(timer);
  await Promise.race([reading, Bun.sleep(2000)]);
  return { out, err, timedOut };
}

async function osa(script: string, ms = OSA_MS): Promise<string> {
  const r = await runCmd(["osascript", "-e", script], ms);
  if (r.timedOut) throw new Error(`osascript timed out after ${ms}ms`);
  if (r.err.trim()) throw new Error(`osascript: ${r.err.trim().slice(0, 300)}`);
  return r.out.trim();
}

async function stored(): Promise<{ id: string | null; name: string }> {
  const f = Bun.file(STORE);
  const j = (await f.exists()) ? await f.json().catch(() => ({})) : {};
  return { id: String(j.id ?? "") || null, name: String(j.name ?? "") || `${LAYER.replace(/^\./, "")}-automation` };
}

// Returns the AppleScript id of the automation window, creating it (minimized, never activated) when it is gone.
export async function ensureAutomationWindow(): Promise<string> {
  const ids = (await osa('tell application "Aside" to get id of every window')).split(/,\s*/).filter(Boolean);
  let { id, name } = await stored();
  if (!id || !ids.includes(id)) {
    // Fallback when the json was lost: a window we created earlier carries our given name.
    const named = await osa(`tell application "Aside" to get id of every window whose given name is ${q(name)}`).catch(() => "");
    id = named.split(/,\s*/).filter(Boolean)[0] ?? null;
  }
  if (!id) {
    id = await osa(`tell application "Aside"
  set w to make new window
  set minimized of w to true
  set given name of w to ${q(name)}
  set URL of active tab of w to ${q(ANCHOR)}
  return id of w
end tell`);
    if (!/^\d+$/.test(id)) throw new Error(`could not create automation window: ${id}`);
  }
  await Bun.write(STORE, JSON.stringify({ id, name, updated: new Date().toISOString() }));
  // Anchor tab + minimized state, checked every time (both are cheap and both guard the user's view).
  await osa(`tell application "Aside"
  set w to window id ${q(id)}
  if (URL of every tab of w) does not contain ${q(ANCHOR)} then
    tell w to make new tab with properties {URL:${q(ANCHOR)}}
  end if
  if minimized of w is false then set minimized of w to true
end tell`);
  return id;
}

// CDP target ids of the tabs currently in the automation window (from aside repl; read-only).
async function targetIds(windowId: string): Promise<string[]> {
  const r = await runCmd([ASIDE, "repl", `console.log('IDS ' + JSON.stringify((await listBrowserTabs()).filter(x => String(x.windowId) === ${q(windowId)}).map(x => x.targetId ?? x.id)))`], 30e3);
  const line = r.out.split("\n").find((l) => l.startsWith("IDS "));
  if (!line) throw new Error(`aside repl failed${r.timedOut ? " (timeout)" : ""}: ${(r.out + r.err).slice(-300)}`);
  return JSON.parse(line.slice(4));
}

// tabId = AppleScript id of the tab we opened; close() closes exactly that tab (safe when several scripts share the window).
export type AutomationTab = { windowId: string; tabId: string; url: string; before: string[]; attach: (varName?: string) => string; close: () => Promise<void> };

// Opens url in a new tab of the automation window and keeps the window minimized. `attach()` returns repl code that declares
// `const <varName>` bound to that new tab (the tab that was not in the window before), after it has navigated and loaded.
// AppleScript-opened tabs outlive the repl run, unlike repl openTab() tabs, so callers close them when done (close()).
export async function openInAutomationWindow(url: string, opts: { replacePrefix?: string } = {}): Promise<AutomationTab> {
  const windowId = await ensureAutomationWindow();
  if (opts.replacePrefix) await closeTabsMatching(opts.replacePrefix);
  const before = await targetIds(windowId);
  const tabId = await osa(`tell application "Aside"
  set t to make new tab at end of tabs of window id ${q(windowId)} with properties {URL:${q(url)}}
  if minimized of window id ${q(windowId)} is false then set minimized of window id ${q(windowId)} to true
  return id of t
end tell`);
  return { windowId, tabId, url, before, attach: (v = "p") => attachCode(windowId, before, v, url), close: () => closeTab(windowId, tabId) };
}

// With url, a new tab on the same host wins over other new tabs (another script may open a tab in the window at the same time).
export function attachCode(windowId: string, before: string[], v = "p", url?: string): string {
  const host = url ? new URL(url).hostname.replace(/^www\./, "") : "";
  return `let ${v}_t;
for (let i = 0; i < 60 && !${v}_t; i++) { const ${v}_n = (await listBrowserTabs()).filter(x => String(x.windowId) === ${q(windowId)} && !${JSON.stringify(before)}.includes(x.targetId ?? x.id) && /^https?:/.test(x.url)); ${v}_t = ${v}_n.find(x => ${q(host)} && x.url.includes(${q(host)})) ?? (i >= 10 ? ${v}_n[0] : undefined); if (!${v}_t) await sleep(500); }
if (!${v}_t) throw new Error('automation tab did not appear in window ${windowId}');
const ${v} = await attachBrowserTab(${v}_t.targetId ?? ${v}_t.id);
await ${v}.waitForLoadState('domcontentloaded').catch(() => {});`;
}

// Closes one tab (AppleScript id) of the automation window; no-op when it is already gone. Never the anchor tab.
export async function closeTab(windowId: string, tabId: string): Promise<void> {
  await osa(`tell application "Aside"
  if not (exists window id ${q(windowId)}) then return
  set w to window id ${q(windowId)}
  repeat with i from (count of tabs of w) to 1 by -1
    if (id of tab i of w as text) is ${q(tabId)} and URL of tab i of w is not ${q(ANCHOR)} then close tab i of w
  end repeat
  if (count of tabs of w) is 0 then return
  if minimized of w is false then set minimized of w to true
end tell`);
}

// Closes tabs whose URL starts with urlPrefix, in the automation window only. Never the anchor tab.
export async function closeTabsMatching(urlPrefix: string): Promise<number> {
  const windowId = await ensureAutomationWindow();
  const n = await osa(`tell application "Aside"
  set w to window id ${q(windowId)}
  set n to 0
  repeat with i from (count of tabs of w) to 1 by -1
    if URL of tab i of w starts with ${q(urlPrefix)} then
      close tab i of w
      set n to n + 1
    end if
  end repeat
  return n
end tell`);
  return Number(n) || 0;
}

// Read-only snapshot ("tab" is a class name in Aside's dictionary, so fields are joined with "|~|") of every Aside window (id, name, minimized, tab URLs) for before/after checks.
export async function windowSnapshot(): Promise<{ id: string; name: string; minimized: boolean; urls: string[] }[]> {
  const out = await osa(`tell application "Aside"
  set s to ""
  repeat with w in every window
    set s to s & (id of w) & "|~|" & (given name of w) & "|~|" & (minimized of w) & "|~|"
    repeat with t in tabs of w
      set s to s & (URL of t) & " "
    end repeat
    set s to s & linefeed
  end repeat
  return s
end tell`);
  return out.split("\n").filter(Boolean).map((l) => { const [id, name, min, urls] = l.split("|~|"); return { id, name, minimized: min === "true", urls: (urls ?? "").trim().split(" ").filter(Boolean) }; });
}

// While a login flow runs, a site may open its sign-in popup as a new window. This keeps such windows minimized: only windows
// that did not exist when the guard started AND whose active tab URL matches urlRe (so a window the user opens is never touched).
export function minimizeNewWindows(urlRe = /accounts\.google\.com/): { stop: () => Promise<void> } {
  let on = true;
  const loop = (async () => {
    const before = new Set((await osa('tell application "Aside" to get id of every window').catch(() => "")).split(/,\s*/).filter(Boolean));
    while (on) {
      const rows = await osa(`tell application "Aside"
  set s to ""
  repeat with w in (every window whose minimized is false)
    set s to s & (id of w) & "|~|" & (URL of active tab of w) & linefeed
  end repeat
  return s
end tell`).catch(() => "");
      for (const l of rows.split("\n").filter(Boolean)) {
        const [id, url] = l.split("|~|");
        if (!before.has(id) && urlRe.test(url ?? "")) await osa(`tell application "Aside" to set minimized of window id ${q(id)} to true`).catch(() => {});
      }
      await Bun.sleep(700);
    }
  })();
  return { stop: async () => { on = false; await loop; } };
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "id" || cmd === "ensure") console.log(await ensureAutomationWindow());
  else if (cmd === "open" && arg) {
    const t = await openInAutomationWindow(arg);
    console.log(JSON.stringify({ windowId: t.windowId, tabId: t.tabId, before: t.before }));
  } else if (cmd === "close" && arg) console.log(await closeTabsMatching(arg));
  else if (cmd === "windows") console.log(JSON.stringify(await windowSnapshot()));
  else {
    console.error("usage: aside-window.ts id | open <url> | close <urlPrefix> | windows");
    process.exit(2);
  }
}
