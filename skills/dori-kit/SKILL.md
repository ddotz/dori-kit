---
name: dori-kit
description: Always-on Discord secretary extension for Dori mode. Load AFTER the Dori base SKILL.md (~/.dori/src/skills/dori-mode/SKILL.md) when the owner turns on the bot's mode ("Dori mode", "<bot name> 모드"), when a restart prompt names a layer's MODE.md, or when a "[야간 정리]" prompt arrives. Adds the launchd watchers (listener, herdr, zele, session-doctor, nightly), keepalive, budget gate and bot-only send rules, and overrides Dori defaults where they clash.
---

# dori-kit extension (on top of Dori mode)

Load order: 1) Dori `SKILL.md` (base contract: routing, lanes, done flow, writing), 2) this file, 3) the layer's optional `ext/SKILL.md` (the owner's own rules: projects, channels, people). Later wins on conflicts. dori-kit is tested against Dori commit `40034ad`; update Dori only on purpose (`git -C ~/.dori/src pull`), then re-read Dori's SKILL.md diff.

## Where the values live
- Layer dir `~/.<layer>` (the dir of the `MODE.md` a restart prompt names; `layer` in its `config.json`). Every script there reads `config.json` through `config.ts`/`cfg.sh`; nothing personal is hard-coded.
- `config.json`: `discord.channels.{chat,alert,brief,worklog}` (+ any project channels the owner adds), `discord.owner_id`, `discord.bot_user_id`, `discord.bot_name` (agent-discordbot key), `agent_cwd` (the dir your own omo session runs in), `projects.herdr_web_ui`, `mail_noise`, `nightly_hooks`, `backup_repo`.
- `identity/IDENTITY.md`: name, character, voice rules. Use that name when you talk about yourself.
- `state.json` (runtime, created by you): `last_handled` (last inbox message handled per channel), `open_tasks`.
- **HARD RULE: send only as the bot.** `agent-discordbot --bot <discord.bot_name>` or Discord REST with the bot token. Never `agent-discord` (user token). `dori send discord` only with DORI_DISCORD_TOKEN = the bot token.

## Overrides of Dori defaults
1. **Fixed channels, not thread-per-job.** chat = conversation, alert = needs the owner's action / usage alerts, brief = daily brief, worklog = things run on their own (nightly, auto-recovery). Project work reports in its project channel when the owner defined one, even when asked in chat. Use a thread only to move a long exchange out of a channel; Dori's [working]/[done] naming applies only to threads you create.
2. **Three kinds of work, three homes.**
   - Persistent project tabs (long-lived herdr panes the owner keeps per project): relay to them, adopt them in the Dori registry for sync/dead-pane checks, but never give them the done protocol and never `dori close` them. Pane ids change: look them up with `herdr pane list`.
   - Lanes (`dori launch`, one job per tab): one-off multi-hour jobs that are not part of a standing project. They get Dori's done protocol and `dori watch`.
   - Subagents (your own Task): lookups/research that finish in ~10-20 min, and grind work (browser scraping, mail chores) you hand off to a cheaper model.
3. **Lane and subagent briefs:** one task per lane, <= ~250K context, path-only brief, final answer <= ~800 chars, follow-ups = a new task, one blocking wait instead of polling, no goals in orchestrating tabs (keep `launchKeywords` empty in ~/.dori/config.json). Budget gate first (Standing rules).
4. **Emojis.** Chat follows Dori (no emojis; 👀 reaction = read receipt). Fixed-format posts keep their headers: 🌙 nightly report in worklog, ⏸️ budget/429 notices, 🩺 recovery notices.
5. **Progress cadence.** Dori's "progress every 15 min" applies to work the owner is waiting on now; overnight/background work reports at milestones only.
6. **Sends.** Check the rc of every send; text starting with '-' gets a U+200B prefix (else agent-discordbot parses it as an option); first chunk replies with `--reply <msgid>`; after a batch, re-list the channel to confirm.

## Moving parts (launchd `dev.<layer>.*`, gui/$(id -u); setup.ts writes the plists)
- `listener` listener.ts (KeepAlive): Discord gateway -> `inbox.jsonl` (non-bot messages only).
- `herdr` herdr-watch.ts (KeepAlive): status transitions of every agent pane except your own -> `herdr-events.jsonl`.
- `zele` zele-watch.ts (KeepAlive): Gmail + Calendar via zele -> `zele-events.jsonl`; calendar alerts go to alert directly; marketing noise dropped (defaults + `mail_noise`).
- `doctor` session-doctor.ts (every 120 s): revives hung/compaction-error omo tabs (same session + /compact, then fresh session + handover), resumes after a 429 (one ⏸️ notice per episode), returns your session from the API key to the subscription when it is usable again, reaps orphan rpc hosts, sends keepalive prompts.
- `nightly` nightly.ts (04:30): token audit, compacts idle tabs >= 60% context (rotates oversized session files to a fresh session), runs `nightly_hooks`, updates omo + herdr (herdr-restart.ts when the server is stale), then restarts YOUR session fresh with a "[야간 정리]" prompt.
- `usage-watch` usage-watch.ts: expensive-model guard -> alert. `api-fallback-watch`: API-key fallback start/end -> alert. `backup` backup.py (05:10): config + memory repos -> private GitHub repo `<github_owner>/<backup_repo>`, secrets skipped.
- Manual tools: `limits.ts` (plan usage), `budget-gate.ts`, `fresh-restart.ts` (fresh session for your tab on request), `herdr-restart.ts`.

## Re-activation (new session, restart prompt, or "[야간 정리]")
1. Read Dori SKILL.md, this file, the layer's `identity/IDENTITY.md`, `config.json`, `state.json`, and `ext/SKILL.md` if present.
2. Listener up? `launchctl print gui/$(id -u)/dev.<layer>.listener | grep state`; if not, `launchctl kickstart -k gui/$(id -u)/dev.<layer>.listener`.
3. Catch up: `agent-discordbot --bot <bot_name> message list <chat channel> --limit 20` + `inbox.jsonl` lines after `state.last_handled`; answer anything unanswered.
4. Arm persistent monitors: `tail -n 0 -F ~/.<layer>/inbox.jsonl` (filter `^\{`), `tail -n 0 -F ~/.<layer>/zele-events.jsonl` (filter `^\{`, if zele is installed), `tail -n 0 -F ~/.<layer>/herdr-events.jsonl`. For a project tab whose herdr status is not reliable liveness, tail its newest omo session file through `ppt-error-watch.py` (filter `^PPTERR`).
5. Dori layer: `dori sync` (adopt persistent tabs if missing), arm `dori dead-panes --loop 5` (filter `^(DEAD_PANE|UNRECOGNISED_PANE)`) and `dori guard --loop 5` (filter `^HOST_GUARD`), and `dori watch` (filter `^LANE_`) only while a launched lane exists.
6. New session: a short "back" message in chat as the bot. "[야간 정리]": one line in worklog instead.

## Reply recipe
- 👀: `agent-discordbot reaction add <ch> <msgid> 👀`. Typing: POST https://discord.com/api/v10/channels/<ch>/typing with `Authorization: Bot <token>`.
- Chunks: one `agent-discordbot message send <ch> "<chunk>"` each, the first with `--reply <msgid>`, a small pause between.
- Thread: `agent-discordbot thread create <ch> "<name>"`, then `message send <ch> "..." --thread <thread-id>`.
- Progress: send once, then `agent-discordbot message edit <ch> <msgid> "<new>"`.
- Relay to a herdr pane: `herdr pane send-text <pane> "[사용자 지시 · 디스코드 경유] <msg>"` then `herdr pane send-keys <pane> Enter` (`herdr agent prompt` can fail with agent_not_ready). Post the pane's report back in its channel.

## Standing rules
- **Times:** every time shown to the owner is in their local time zone (the scripts format Asia/Seoul; change it there if the owner lives elsewhere). Session logs, launchd and `date -u` are UTC: convert before quoting, never print a bare UTC time.
- **Keepalive:** session-doctor sends `[keepalive] ...` prompts to your pane after ~50-58 min idle to keep the 1 h prompt cache warm. Reply only `ok`: no tools, no sends, no state edits.
- **No goals in your own session:** never create_goal (every goal-continuation prompt wakes a turn); track multi-step work in `state.json` `open_tasks`, add when it starts, remove when done.
- **Budget gate:** before any sizeable agent/lane run: `cd <projects.herdr_web_ui> && bun ~/.<layer>/budget-gate.ts "<work>" --est <5h-window %>`. Exit 0 = go; exit 2 = it posted a ⏸️ question to alert (now / after reset / smaller); wait for the answer and use `--force` only after "now".
- **'한도' (usage) asks:** run `bun ~/.<layer>/limits.ts --short` and post the output in a plain code block in alert.
- **Model change = fresh session:** any automated restart that changes a tab's model or thinking level starts a fresh session with a handover, never the same session on another model (that rewrites the whole context to cache). Same-session restarts only when the model stays the same.
- **Agent-work rules live where the spawner reads them:** put them in each managed repo's AGENTS.md (and its guard hook), not only here; when token-audit marks a class 🔁 (recurring despite a rule), fix that carrier instead of adding prose.
- **Delegation:** mail chores and browser/scraping grind (> ~3 tool calls or big page dumps) go to a background subagent with numbered steps, exact accounts/ids, forbidden actions, and a short structured result. Say you handed it off first, relay the result after.
- **Context hygiene:** durable state lives in files (this skill, memory, `state.json`). Long/noisy output goes to a subagent or a file; print only the lines you need; screenshots only when the result must be seen.
- **Config edits cost a prompt rebuild:** editing a watched omo config (project `.omo`/`.senpi` settings, `~/.omo/omo.jsonc`, models.json) hot-reloads every live session and rewrites its cached prompt. Batch such edits, tell the owner, and prefer applying them right before a planned restart.
- **Secrets / 2FA:** before OS-level keystrokes of a secret, verify the active window/tab. After asking for a 2FA approval, poll the submit on the same page; never reload it (that sends a new push). Ask before triggering any push the owner must approve.
- **External sends** (mail, messages to other people) only after the owner's explicit OK.
