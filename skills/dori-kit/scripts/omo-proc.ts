import { readdirSync, statSync } from "node:fs";

export type OmoProc = { pid: number; cpu: number; cwd: string; sessionArg?: string };

export async function omoProcs(): Promise<OmoProc[]> {
  const lines = (await Bun.$`ps -axo pid=,pcpu=,command=`.quiet().text()).split("\n");
  const out: OmoProc[] = [];
  for (const l of lines) {
    if (!l.includes("senpi/dist/bundle/cli.js") || l.includes("internal-rpc") || l.includes("--mode rpc") || l.includes(" -p ")) continue;
    const [pid, cpu] = l.trim().split(/\s+/);
    const cwd = (await Bun.$`lsof -a -p ${pid} -d cwd -Fn`.quiet().nothrow().text()).split("\n").find((x) => x.startsWith("n"))?.slice(1);
    if (!cwd) continue;
    out.push({ pid: Number(pid), cpu: Number(cpu), cwd, sessionArg: l.match(/--session (\S+)/)?.[1] });
  }
  return out;
}

export const sessionDir = (cwd: string) =>
  `${process.env.HOME}/.omo/agent/sessions/--${cwd.slice(1).replaceAll("/", "-")}--`;

export function sessionFile(cwd: string, sessionId?: string): string | undefined {
  const dir = sessionDir(cwd);
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return undefined; }
  if (sessionId) {
    const f = files.find((x) => x.includes(sessionId));
    if (f) return `${dir}/${f}`;
  }
  return files.map((f) => `${dir}/${f}`).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export const sessionIdOf = (file: string) => file.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1];

export async function panes(): Promise<any[]> {
  return JSON.parse(await Bun.$`herdr pane list`.quiet().text()).result.panes;
}

export async function paneSend(id: string, text: string) {
  await Bun.$`herdr pane send-text ${id} ${text}`.quiet().nothrow();
  await Bun.sleep(600);
  await Bun.$`herdr pane send-keys ${id} Enter`.quiet().nothrow();
}

export async function killTree(pid: number) {
  await Bun.$`pkill -TERM -P ${pid}`.quiet().nothrow();
  await Bun.$`kill -TERM ${pid}`.quiet().nothrow();
  for (let i = 0; i < 10; i++) {
    if ((await Bun.$`kill -0 ${pid}`.quiet().nothrow()).exitCode !== 0) return;
    await Bun.sleep(1000);
  }
  await Bun.$`pkill -KILL -P ${pid}`.quiet().nothrow();
  await Bun.$`kill -KILL ${pid}`.quiet().nothrow();
}
