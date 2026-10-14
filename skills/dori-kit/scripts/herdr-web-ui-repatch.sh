#!/bin/bash
# herdr-web-ui auto-updates into a fresh release-* dir, dropping the local keychain patch (Claude usage shows "locked").
# Run by launchd (WatchPaths on the updates dir) and nightly: patch the release the bridge runs from, restart once.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LAYER_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$LAYER_DIR/cfg.sh"
PATCH="$LAYER_DIR/patches/herdr-web-ui-usage-keychain.patch"
PLUGIN="$HOME/.config/herdr/plugins/github/devswha.herdr-web-ui-210f619d6b7b"
CFG="$HOME/.config/herdr/plugins/config/devswha.herdr-web-ui"
LOG="$LAYER_DIR/herdr-web-ui-repatch.log"
sleep 20
pid=$(pgrep -f 'server/index.ts' | head -1)
[ -n "$pid" ] || { echo "$(date) no bridge" >>"$LOG"; exit 0; }
rel=$(lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')
case "$rel" in */release-*) ;; *) echo "$(date) bridge cwd not a release: $rel" >>"$LOG"; exit 0;; esac
changed=0
if ! grep -q readKeychainInLoginSession "$rel/server/usage.ts"; then
  if (cd "$rel" && git apply "$PATCH"); then changed=1
  else echo "$(date) patch failed on $rel (upstream changed usage.ts; re-port by hand)" >>"$LOG"; fi
fi
# omo runs as senpi + omo-ai extension; 0.3.40+ no longer recognizes it, so chat shows nothing
SENPI_PATCH="$LAYER_DIR/patches/herdr-web-ui-senpi-omo.patch"
if ! grep -q "local patch (senpi-omo)" "$rel/server/omo.ts"; then
  if (cd "$rel" && git apply "$SENPI_PATCH"); then changed=1
  else echo "$(date) senpi-omo patch failed on $rel (upstream changed omo.ts; re-port by hand)" >>"$LOG"; fi
fi
# Claude Code may refresh only ~/.claude/.credentials.json; prefer whichever token expires later
FRESH_PATCH="$LAYER_DIR/patches/herdr-web-ui-claude-fresher-token.patch"
if ! grep -q "local patch (fresher-claude-token)" "$rel/server/usage.ts"; then
  if (cd "$rel" && git apply "$FRESH_PATCH"); then changed=1
  else echo "$(date) fresher-token patch failed on $rel (upstream changed usage.ts; re-port by hand)" >>"$LOG"; fi
fi
[ "$changed" = 1 ] || exit 0
cd "$PLUGIN" && bun scripts/plugin.ts stop >>"$LOG" 2>&1
for _ in $(seq 1 20); do pgrep -f 'server/managed.ts' >/dev/null || break; sleep 0.5; done
HERDR_PLUGIN_ROOT="$PLUGIN" HERDR_PLUGIN_CONFIG_DIR="$CFG" bun scripts/plugin.ts start >>"$LOG" 2>&1
echo "$(date) patched + restarted $rel" >>"$LOG"
