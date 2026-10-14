# Source from shell scripts in the layer dir:
#   LAYER_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; . "$LAYER_DIR/cfg.sh"; then $(cfg .projects.herdr_web_ui)
# Reads $LAYER_DIR/config.json with jq and expands a leading ~ to $HOME. LAYER_DIR defaults to the sourcing script's dir.
LAYER_DIR="${LAYER_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
cfg() { /usr/bin/jq -er "$1" "$LAYER_DIR/config.json" | sed "s#^~#$HOME#"; }
