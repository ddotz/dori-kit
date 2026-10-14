# Installing this assistant layer for yourself

`setup.ts` copies the `shared` files from `MANIFEST.md` (never `personal` ones, `secrets/`, `state.json`, logs) into `~/.<layer>`, writes your `config.json` and `identity/IDENTITY.md` (from `identity/IDENTITY.template.md`), and generates launchd plists `dev.<layer>.<name>.plist`. Scripts find their folder from their own location and build launchd labels from `config.json` `layer`, so any layer name works. The dori-kit `install.sh` runs it for you.

```sh
bun <dir of this file>/setup.ts                         # interactive
bun <dir of this file>/setup.ts --answers answers.json  # non-interactive
```

Options: `--target <dir>` (default `~/.<layer>`), `--plist-dir <dir>` (default `~/Library/LaunchAgents`), `--force` (overwrite an existing `config.json`), `--load` (run `launchctl bootstrap` for the plists; without it nothing is loaded).

`answers.json`:

```json
{
  "bot": { "name": "Mybot", "character": "calm secretary cat, short polite Korean" },
  "layer": "mybot",
  "discord": {
    "guild": "<guild id>",
    "channels": { "chat": "<id>", "alert": "<id>", "brief": "<id>", "worklog": "<id>" },
    "owner_id": "<your user id>", "bot_user_id": "<bot user id>", "bot_name": "mybot"
  },
  "mail": { "google": "you@gmail.com" },
  "github_owner": "<github user>",
  "agent_cwd": "~/mybot-agent",
  "features": ["listener", "herdr", "doctor", "usage-watch"]
}
```

`features` is `"all"` or a list of names from the interactive menu (shared scripts; `listener`, `herdr`, `zele`, `doctor`, `nightly`, `usage-watch`, `api-fallback-watch`, `backup` also get a plist). Files a feature imports come along automatically. Missing channels fall back to `chat`.

After it runs, follow the printed next steps: `agent-discordbot auth set <token> --bot <bot_name>`, the Dori base (pinned commit `40034ad` of https://github.com/sisyphuslabs/omo-dori-mode-experimental; dori-kit's `install.sh` installs it), your own optional `ext/SKILL.md`, then `launchctl bootstrap gui/$(id -u) <plist>` per service.
