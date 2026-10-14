// Loads config.json from the layer dir (= the directory of this file, exported as LAYER_DIR) for every script. Strings starting with "~/" are expanded to $HOME.
// Shareable: another person keeps all scripts and only swaps config.json (see config.example.json).
import { readFileSync } from "node:fs";
import { basename } from "node:path";

type Cfg = {
  layer: string; // launchd labels are dev.<layer>.<name>
  identity: { name: string; avatar: string; doc: string };
  // chat/alert/brief/worklog are used by the shared scripts; add your own project channels as extra keys.
  discord: { guild: string; channels: Record<"chat" | "alert" | "brief" | "worklog", string> & Record<string, string>; owner_id: string; bot_user_id: string; bot_name: string };
  mail: Record<string, string>;
  github_owner: string;
  agent_cwd: string;
  projects: Record<"herdr_web_ui", string> & Record<string, string>;
  backup_repo?: string; // default <layer>-backup
  mail_noise?: string[]; // extra case-insensitive regexes for zele-watch's noise filter
  nightly_hooks?: { label: string; cmd: string }[]; // extra steps nightly.ts runs before the update
  [extra: string]: unknown; // personal keys (tailnet, remote_macs, ...) for your own scripts
};

const expand = (v: unknown): unknown =>
  typeof v === "string" ? (v.startsWith("~/") ? `${process.env.HOME}${v.slice(1)}` : v)
  : Array.isArray(v) ? v.map(expand)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
  : v;

export const LAYER_DIR = import.meta.dir;
export const cfg = expand(JSON.parse(readFileSync(`${LAYER_DIR}/config.json`, "utf8"))) as Cfg;
cfg.layer ||= basename(LAYER_DIR).replace(/^\./, "");
