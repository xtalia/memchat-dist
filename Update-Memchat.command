#!/bin/bash
# Double-click launcher for the native macOS updater.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$SCRIPT_DIR/update-memchat.sh" ]; then
    printf 'Memchat updater script was not found beside this launcher.\n' >&2
    STATUS=1
else
    bash "$SCRIPT_DIR/update-memchat.sh" "$@"
    STATUS=$?
fi
if [ -t 0 ]; then
    printf '\nPress Enter to close this window. '
    IFS= read -r _ || :
fi
exit "$STATUS"
