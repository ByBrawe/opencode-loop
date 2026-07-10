#!/usr/bin/env sh
set -eu

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGIN_DIR="$CONFIG_DIR/plugins"
COMMAND_DIR="$CONFIG_DIR/commands"
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

mkdir -p "$PLUGIN_DIR" "$COMMAND_DIR"
PACKAGE_FILE="$CONFIG_DIR/package.json"
if command -v node >/dev/null 2>&1; then
  PACKAGE_FILE="$PACKAGE_FILE" node --input-type=module - <<'NODE'
import fs from "node:fs"

const file = process.env.PACKAGE_FILE
let pkg = {}
try {
  pkg = JSON.parse(fs.readFileSync(file, "utf8"))
} catch (error) {
  if (error.code !== "ENOENT") {
    console.warn(`Could not update ${file}: ${error.message}`)
    process.exit(0)
  }
}
if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) pkg = {}
if (!pkg.dependencies || typeof pkg.dependencies !== "object" || Array.isArray(pkg.dependencies)) pkg.dependencies = {}
if (!pkg.dependencies["@opencode-ai/plugin"]) {
  pkg.dependencies["@opencode-ai/plugin"] = ">=1.4.0"
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
}
NODE
elif [ ! -f "$PACKAGE_FILE" ]; then
  printf '%s\n' '{"dependencies":{"@opencode-ai/plugin":">=1.4.0"}}' > "$PACKAGE_FILE"
fi
cp "$ROOT_DIR/src/index.js" "$PLUGIN_DIR/opencode-loop.ts"
rm -f "$PLUGIN_DIR/opencode-loop.js"
cp "$ROOT_DIR/commands"/*.md "$COMMAND_DIR/"

echo "Installed OpenCode Loop plugin."
echo "Plugin:   $PLUGIN_DIR/opencode-loop.ts"
echo "Commands: $COMMAND_DIR/loop*.md"
echo "Restart OpenCode, then run: /loop-help"
