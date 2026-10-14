#!/usr/bin/env bun
// Installs this assistant layer for another person under their own layer name (~/.<layer>).
// Copies only files MANIFEST.md marks `shared`, writes config.json + identity/IDENTITY.md from answers,
// and generates launchd plists dev.<layer>.<name>.plist. Never runs launchctl unless --load. See SETUP.md.
//
//   bun setup.ts                              interactive
//   bun setup.ts --answers answers.json       non-interactive (shape: see SETUP.md)
//   options: --target <dir> (default ~/.<layer>)  --plist-dir <dir> (default ~/Library/LaunchAgents)
//            --load (launchctl bootstrap the generated plists)  --force (overwrite an existing install)
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SRC = import.meta.dir;
const HOME = process.env.HOME!;
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const die = (m: string): never => { console.error(`setup: ${m}`); process.exit(1); };

// Always installed: loaders, docs, avatar. Identity and config are generated, never copied.
const CORE = ["config.ts", "cfg.sh", "dc2.ts", "omo-proc.ts", "config.example.json", "MANIFEST.md", "MODE.md",
  "omo-icon.png", "omo-icon-light.svg", "setup.ts", "SETUP.md"];
// Hard stop list on top of MANIFEST (defence in depth): never leaves the owner's machine.
const NEVER = [/^secrets(\/|$)/, /^state\.json/, /^config\.json$/, /\.log$/, /\.jsonl$/, /^logs\//, /^backups\//, /^share\//, /\.bak/, /^identity\//];

type Service = { script: string; keepAlive?: boolean; interval?: number; calendar?: { Hour: number; Minute: number }; cwd?: "layer" | "herdr_web_ui"; abandon?: boolean };
const SERVICES: Record<string, Service> = {
  listener: { script: "listener.ts", keepAlive: true },
  herdr: { script: "herdr-watch.ts", keepAlive: true },
  zele: { script: "zele-watch.ts", keepAlive: true },
  doctor: { script: "session-doctor.ts", interval: 120, cwd: "layer" },
  nightly: { script: "nightly.ts", calendar: { Hour: 4, Minute: 30 }, cwd: "layer", abandon: true },
  "usage-watch": { script: "usage-watch.ts", interval: 120, cwd: "herdr_web_ui" },
  "api-fallback-watch": { script: "api-fallback-watch.ts", keepAlive: true, cwd: "layer" },
  backup: { script: "backup.py", calendar: { Hour: 5, Minute: 10 } },
};

const manifest = readFileSync(join(SRC, "MANIFEST.md"), "utf8");
const shared = new Map<string, string>();
for (const m of manifest.matchAll(/^- `([^`]+)` - shared: (.*)$/gm)) if (!NEVER.some((r) => r.test(m[1]))) shared.set(m[1], m[2]);
const featureOf = (file: string) => Object.entries(SERVICES).find(([, s]) => s.script === file)?.[0] ?? file.replace(/\.(ts|py|sh)$/, "");
const FEATURES = new Map<string, string>();
for (const f of shared.keys()) if (/^[\w.-]+\.(ts|py|sh)$/.test(f) && !CORE.includes(f)) FEATURES.set(featureOf(f), f);

// Files a script needs: ./x.ts imports, ${LAYER_DIR}/x / $LAYER_DIR/x references, restricted to shared files.
function closure(start: string[]): Set<string> {
  const out = new Set<string>(), todo = [...start];
  while (todo.length) {
    const f = todo.pop()!;
    if (out.has(f) || !existsSync(join(SRC, f))) continue;
    out.add(f);
    if (!/\.(ts|py|sh)$/.test(f)) continue;
    const src = readFileSync(join(SRC, f), "utf8");
    for (const m of src.matchAll(/(?:\.\/|\$\{?LAYER_DIR\}?\/)((?:patches\/)?[\w.-]+\.(?:ts|py|sh|patch))/g)) if (shared.has(m[1])) todo.push(m[1]);
  }
  return out;
}

type Answers = {
  bot: { name: string; character: string };
  layer: string;
  discord: { guild: string; channels: Record<string, string>; owner_id: string; bot_user_id: string; bot_name: string };
  mail?: Record<string, string>;
  github_owner: string;
  agent_cwd: string;
  features: string[] | "all";
};

function ask(q: string, def = "", required = true): string {
  for (;;) {
    const v = (prompt(`${q}${def ? ` [${def}]` : ""}:`) ?? "").trim() || def;
    if (v || !required) return v;
    console.log("  (required)");
  }
}

function interactive(): Answers {
  console.log("Assistant layer setup. Enter = default in [brackets].\n");
  const name = ask("Bot display name");
  const character = ask("Character, one line (who the bot is, how it talks)");
  const layer = ask("Layer name (scripts go to ~/.<layer>, launchd labels dev.<layer>.*)", name.toLowerCase().replace(/[^a-z0-9-]/g, "") || "");
  const guild = ask("Discord server (guild) id");
  const channels: Record<string, string> = {};
  for (const [k, d] of [["chat", "main chat"], ["alert", "alerts"], ["brief", "daily brief"], ["worklog", "work log"]] as const)
    channels[k] = ask(`Discord channel id for ${d} (${k})`, k === "chat" ? "" : channels.chat ?? "");
  const owner_id = ask("Your Discord user id (owner)");
  const bot_user_id = ask("Bot user id");
  const bot_name = ask("agent-discordbot bot key (--bot <key> used at login)", layer);
  const mail: Record<string, string> = {};
  const g = ask("Google mail account (optional)", "", false); if (g) mail.google = g;
  const n = ask("Naver mail account (optional)", "", false); if (n) mail.naver = n;
  const github_owner = ask("GitHub user/org (private backup repo owner)");
  const agent_cwd = ask("Agent working dir (where the bot's omo session runs)", `~/${layer}-agent`);
  console.log("\nShared features:");
  for (const [f, s] of FEATURES) console.log(`  ${f.padEnd(20)} ${shared.get(s)}${SERVICES[f] ? "  [launchd]" : ""}`);
  const fs = ask("Features to install (comma list or 'all')", "all");
  return { bot: { name, character }, layer, discord: { guild, channels, owner_id, bot_user_id, bot_name }, mail, github_owner, agent_cwd, features: fs === "all" ? "all" : fs.split(",").map((x) => x.trim()).filter(Boolean) };
}

const answersPath = opt("--answers");
const A: Answers = answersPath ? JSON.parse(readFileSync(answersPath, "utf8")) : interactive();
for (const k of ["bot.name", "bot.character", "layer", "discord.guild", "discord.channels.chat", "discord.owner_id", "discord.bot_user_id", "discord.bot_name", "github_owner", "agent_cwd"]) {
  const v = k.split(".").reduce<any>((o, p) => o?.[p], A);
  if (typeof v !== "string" || !v.trim()) die(`missing answer: ${k}`);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(A.layer)) die(`layer must be lowercase letters/digits/dashes: ${A.layer}`);
const features = A.features === "all" ? [...FEATURES.keys()] : A.features;
for (const f of features) if (!FEATURES.has(f)) die(`unknown feature "${f}"; choose from: ${[...FEATURES.keys()].join(", ")}`);

const TARGET = opt("--target") ?? join(HOME, `.${A.layer}`);
const PLIST_DIR = opt("--plist-dir") ?? join(HOME, "Library/LaunchAgents");
if (TARGET === SRC) die("target is the source layer itself");
if (existsSync(join(TARGET, "config.json")) && !flag("--force")) die(`${TARGET}/config.json exists (use --force to overwrite)`);
const tilde = (p: string) => (p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);
const expand = (p: string) => (p.startsWith("~/") ? HOME + p.slice(1) : p);

const files = closure([...CORE.filter((f) => shared.has(f)), ...features.map((f) => FEATURES.get(f)!)]);
mkdirSync(TARGET, { recursive: true });
for (const f of [...files].sort()) {
  if (NEVER.some((r) => r.test(f))) die(`refusing to copy ${f}`);
  const to = join(TARGET, f);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(SRC, f), to);
  if (f.endsWith(".sh")) chmodSync(to, 0o755);
}

const example = JSON.parse(readFileSync(join(SRC, "config.example.json"), "utf8"));
const config = {
  _comment: `Personal values for the ~/.${A.layer} scripts (generated by setup.ts). Paths may start with ~/ (expanded by config.ts).`,
  layer: A.layer,
  identity: { name: A.bot.name, avatar: `${tilde(TARGET)}/omo-icon.png`, doc: `${tilde(TARGET)}/identity/IDENTITY.md` },
  discord: {
    guild: A.discord.guild,
    channels: Object.fromEntries(Object.keys(example.discord.channels).map((k) => [k, A.discord.channels[k] ?? A.discord.channels.chat])),
    owner_id: A.discord.owner_id, bot_user_id: A.discord.bot_user_id, bot_name: A.discord.bot_name,
  },
  mail: A.mail ?? {},
  github_owner: A.github_owner,
  agent_cwd: A.agent_cwd,
  projects: { herdr_web_ui: "~/Code/herdr-web-ui" },
  backup_repo: `${A.layer}-backup`,
  mail_noise: [],
  nightly_hooks: [],
};
writeFileSync(join(TARGET, "config.json"), JSON.stringify(config, null, 2) + "\n");

mkdirSync(join(TARGET, "identity"), { recursive: true });
const vars: Record<string, string> = { NAME: A.bot.name, CHARACTER: A.bot.character, LAYER: A.layer, LAYER_DIR: tilde(TARGET), BOT_NAME: A.discord.bot_name, BOT_USER_ID: A.discord.bot_user_id };
const identity = readFileSync(join(SRC, "identity/IDENTITY.template.md"), "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
writeFileSync(join(TARGET, "identity/IDENTITY.md"), identity);

const bun = process.execPath;
const PATH = [dirname(bun), `${HOME}/.bun/bin`, `${HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((v, i, a) => a.indexOf(v) === i).join(":");
const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plists: string[] = [];
mkdirSync(PLIST_DIR, { recursive: true });
for (const f of features) {
  const s = SERVICES[f];
  if (!s) continue;
  const label = `dev.${A.layer}.${f}`;
  const prog = s.script.endsWith(".py") ? ["/usr/bin/python3", join(TARGET, s.script)] : [bun, join(TARGET, s.script)];
  const cwd = s.cwd === "layer" ? TARGET : s.cwd === "herdr_web_ui" ? expand(config.projects.herdr_web_ui) : undefined;
  const body = [
    `<key>Label</key><string>${label}</string>`,
    `<key>ProgramArguments</key><array>${prog.map((p) => `<string>${x(p)}</string>`).join("")}</array>`,
    cwd ? `<key>WorkingDirectory</key><string>${x(cwd)}</string>` : "",
    `<key>EnvironmentVariables</key><dict><key>HOME</key><string>${x(HOME)}</string><key>PATH</key><string>${x(PATH)}</string></dict>`,
    s.keepAlive ? `<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>` : "",
    s.interval ? `<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>${s.interval}</integer>` : "",
    s.calendar ? `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${s.calendar.Hour}</integer><key>Minute</key><integer>${s.calendar.Minute}</integer></dict>` : "",
    s.abandon ? `<key>AbandonProcessGroup</key><true/>` : "",
    `<key>StandardOutPath</key><string>${x(join(TARGET, `${f}.out.log`))}</string>`,
    `<key>StandardErrorPath</key><string>${x(join(TARGET, `${f}.err.log`))}</string>`,
  ].filter(Boolean).join("\n");
  const path = join(PLIST_DIR, `${label}.plist`);
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${body}
</dict></plist>
`);
  plists.push(path);
}

if (flag("--load")) {
  const uid = process.getuid!();
  for (const p of plists) {
    const r = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, p]);
    console.log(`launchctl bootstrap ${p}: rc=${r.exitCode}${r.exitCode ? " " + r.stderr.toString().trim() : ""}`);
  }
}

console.log(`\nInstalled ${files.size} shared files into ${TARGET}:`);
for (const f of [...files].sort()) console.log(`  ${f}`);
console.log(`  config.json, identity/IDENTITY.md (generated)`);
console.log(`\nPlists (${plists.length}) in ${PLIST_DIR}:`);
for (const p of plists) console.log(`  ${relative(PLIST_DIR, p)}`);
console.log(`
Next steps:
  1. Bot token:   agent-discordbot auth set <BOT_TOKEN> --bot ${A.discord.bot_name}
                  agent-discordbot --bot ${A.discord.bot_name} whoami      (should print user id ${A.discord.bot_user_id})
  2. Dori base (pinned 40034ad): the dori-kit install.sh installs it; by hand:
                  git clone https://github.com/sisyphuslabs/omo-dori-mode-experimental ~/.dori/src
                  git -C ~/.dori/src checkout 40034ad      then follow ~/.dori/src/README for the base install
  3. Rules: the dori-kit skill holds the generic rules; put your own (channels, projects) in ${tilde(TARGET)}/ext/SKILL.md (optional).
                  Edit ${tilde(TARGET)}/identity/IDENTITY.md, replace omo-icon.png; mkdir -p ${expand(A.agent_cwd)}
  4. Services:${flag("--load") ? "        loaded above (--load)." : `
${plists.map((p) => `                  launchctl bootstrap gui/$(id -u) ${p}`).join("\n") || "                  (no launchd features chosen)"}`}
  Remove a service: launchctl bootout gui/$(id -u)/dev.${A.layer}.<name>`);
