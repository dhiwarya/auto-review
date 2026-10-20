#!/bin/sh
# Starts Auto Reviewer at login and keeps it running (macOS LaunchAgent).
# Usage: sh deploy/macos/install.sh          install or update
#        sh deploy/macos/install.sh remove   stop and remove
set -eu

LABEL="com.auto-reviewer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "${1:-}" = "remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
# launchd starts with a bare PATH, so carry over where node, git, gh, claude and codex live.
P="/usr/bin:/bin:/usr/sbin:/sbin"
for tool in node git gh claude codex; do
  if t="$(command -v "$tool" 2>/dev/null)"; then P="$(dirname "$t"):$P"; else echo "note: $tool not found on PATH"; fi
done

mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>src/index.ts</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$P</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/data/reviewer.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/reviewer.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL. Logs: $DIR/data/reviewer.log"
