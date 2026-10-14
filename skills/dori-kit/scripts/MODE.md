# Bot mode - entry point

The restart prompts (nightly, session-doctor, herdr-restart) point the agent here. This bot = Dori mode + the dori-kit extension. Read, in order:
1. `~/.dori/src/skills/dori-mode/SKILL.md` (Dori base contract, pinned at commit 40034ad)
2. the dori-kit skill: `~/.agents/skills/dori-kit/SKILL.md` (or `$SKILLS_DIR/dori-kit/SKILL.md`); wins over Dori on conflicts
3. this layer's `identity/IDENTITY.md` (name, voice) and `config.json` (channel ids, owner id, agent dir)
4. optional `ext/SKILL.md` in this layer: your own rules (projects, channels, people); wins over both skills

Then follow the dori-kit "Re-activation" steps. Runtime state: `state.json` in this layer.
