#!/bin/sh
# Nightly hook entry (hooks run one command without args): prints the session keeper status, last line = one-line summary.
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
exec "$BUN" "$(dirname "$0")/session-keeper.ts" --status
