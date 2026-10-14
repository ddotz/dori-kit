#!/usr/bin/env bash
# Installs dori-kit: the Dori base (pinned), the dori-kit skill, then runs setup.ts for your own layer (~/.<layer>).
# Usage: git clone <this repo> ~/Code/dori-kit && ~/Code/dori-kit/install.sh [setup.ts options]
#   setup.ts options: --answers answers.json  --target <dir>  --plist-dir <dir>  --load  --force   (see skills/dori-kit/scripts/SETUP.md)
# Needs: git, bun 1.3+. Optional env: DORI_SRC (Dori clone dir, default ~/.dori/src), SKILLS_DIR (where your agent loads skills),
#   DORI_KIT_SKIP_DORI=1 (never clone or touch the Dori base).
set -euo pipefail

here="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dori_repo="https://github.com/sisyphuslabs/omo-dori-mode-experimental.git"
dori_pin="40034ad"
src="${DORI_SRC:-$HOME/.dori/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

link() { # link <name> <target>: symlink a skill dir into $skills, never replacing a real directory
  if [ -e "$skills/$1" ] && [ ! -L "$skills/$1" ]; then
    echo "$skills/$1 exists and is not a link; leaving it alone" >&2
  else
    ln -sfn "$2" "$skills/$1"
  fi
}

mkdir -p "$skills"

if [ -d "$src" ]; then
  echo "Dori base found: $src (dori-kit is tested with commit $dori_pin; yours: $(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown))"
  if [ -d "$src/skills/dori-mode" ] && [ ! -e "$skills/dori-mode" ]; then link dori-mode "$src/skills/dori-mode"; fi
elif [ "${DORI_KIT_SKIP_DORI:-}" = "1" ]; then
  echo "DORI_KIT_SKIP_DORI=1: not installing the Dori base; install it yourself (commit $dori_pin of $dori_repo)" >&2
else
  echo "Installing the Dori base at $src (commit $dori_pin)"
  git clone --quiet "$dori_repo" "$src"
  git -C "$src" -c advice.detachedHead=false checkout --quiet "$dori_pin"
  link dori-mode "$src/skills/dori-mode"
  (cd "$src/skills/dori-mode/scripts" && bun install --silent && bun link --silent)
  mkdir -p "$HOME/.dori"
  [ -f "$HOME/.dori/config.json" ] || cp "$src/skills/dori-mode/references/config.example.json" "$HOME/.dori/config.json"
fi

link dori-kit "$here/skills/dori-kit"
echo "Skill linked: $skills/dori-kit -> $here/skills/dori-kit"

bun "$here/skills/dori-kit/scripts/setup.ts" "$@"

echo
echo "dori-kit $(cat "$here/VERSION") installed. Start your agent in the agent dir you chose and say: Dori mode"
