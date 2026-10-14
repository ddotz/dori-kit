# dori-kit scripts manifest

Every file here is `shared`: generic scripts that read all personal values from `config.json` (written by `setup.ts`, see `config.example.json`) and the persona from `identity/IDENTITY.md` (generated from `identity/IDENTITY.template.md`). `setup.ts` copies the files listed below into `~/.<layer>`; runtime files (`config.json`, `state.json`, `*.log`, `*.jsonl`, `secrets/`) are created per install and never ship.

- `api-fallback-watch.ts` - shared: reports API-key fallback switches
- `backup.py` - shared: backs up config+memory to a private GitHub repo (owner from config)
- `budget-gate.ts` - shared: pause heavy work near the 5h limit
- `config.example.json` - shared: placeholder template for config.json
- `config.ts` - shared: loader for config.json; no personal values
- `dc2.ts` - shared: minimal Discord REST sender; bot key from config
- `fresh-restart.ts` - shared: manual fresh-session restart of the agent tab
- `herdr-restart.ts` - shared: restart herdr server and resume omo tabs
- `herdr-watch.ts` - shared: herdr pane status -> herdr-events.jsonl
- `herdr-web-ui-repatch.sh` - shared: re-applies herdr-web-ui patches after updates
- `identity/IDENTITY.template.md` - shared: persona/voice template setup.ts fills in
- `limits.ts` - shared: plan usage report (needs herdr-web-ui)
- `listener.ts` - shared: Discord gateway -> inbox.jsonl; bot id from config
- `nightly.ts` - shared: nightly compaction/update/fresh-session; extra steps from config.json nightly_hooks
- `omo-icon-light.svg` - shared: avatar source image
- `omo-icon.png` - shared: bot avatar (replace to change identity)
- `omo-proc.ts` - shared: finds omo processes/sessions by cwd
- `MANIFEST.md` - shared: this list
- `MODE.md` - shared: entry point the restart prompts point to (load order of Dori + dori-kit skills)
- `patches/herdr-web-ui-claude-fresher-token.patch` - shared: herdr-web-ui patch
- `patches/herdr-web-ui-senpi-omo.patch` - shared: herdr-web-ui patch
- `patches/herdr-web-ui-usage-keychain.patch` - shared: herdr-web-ui patch
- `patches/herdr-web-ui-usage-keychain.patch.prev-keychain-only` - shared: herdr-web-ui patch
- `ppt-error-watch.py` - shared: prints provider errors from an omo session jsonl
- `session-doctor.ts` - shared: revives hung/compaction-error omo tabs, keepalive
- `token-audit.ts` - shared: nightly token-leak audit report
- `usage-watch.ts` - shared: Fable/max model guard -> alert channel
- `zele-watch.ts` - shared: Gmail/Calendar poll via zele; extra noise patterns from config.json mail_noise
- `cfg.sh` - shared: shell helper for config.json (sourced by .sh scripts)
- `setup.ts` - shared: interactive installer for a new layer (~/.<layer>)
- `SETUP.md` - shared: how to run setup.ts
- `aside-window.ts` - shared: one dedicated minimized Aside window for all automations (tabs open/close by id, never focus)
- `session-keeper.ts` - shared: session keeper runner (check/touch/relogin adapters, lock, alert/pause policy, status lines)
- `session-status.sh` - shared: nightly hook wrapper printing session-keeper status
